import * as ts from 'typescript';
import { isGeneratedFile } from './discover';
import { Analysis, PropNode } from './types';

const RANK: Record<Analysis, number> = { 'opaque': 0, 'type-inferred': 1, 'exact': 2 };
const MAX_EVAL_DEPTH = 100;
const MAX_TYPE_DEPTH = 10;
/** Methods whose result's keys come from the callback argument's return value. */
const CALLBACK_RESULT_METHODS = new Set(['map', 'flatMap', 'derive']);

export const emptyNode = (analysis: Analysis = 'exact'): PropNode => ({ children: new Map(), analysis });
export const opaqueNode = (): PropNode => emptyNode('opaque');

export const minAnalysis = (a: Analysis, b: Analysis): Analysis => (RANK[a] <= RANK[b] ? a : b);

/** Pure union of two nodes: merged key sets, weakest analysis wins. */
export const unionNodes = (a: PropNode, b: PropNode): PropNode => {
  const children = new Map(a.children);
  for (const [key, node] of b.children) {
    const existing = children.get(key);
    children.set(key, existing ? unionNodes(existing, node) : node);
  }
  return { children, analysis: minAnalysis(a.analysis, b.analysis) };
};

/** An argument captured for a parameter, together with its lexical frame. */
interface BoundArg {
  expr: ts.Expression;
  frame?: BindingFrame;
}

/** Parameter-declaration -> argument bindings for one analyzed call. */
interface BindingFrame {
  bindings: Map<ts.Declaration, BoundArg>;
}

export interface EvalContext {
  checker: ts.TypeChecker;
  /** Implementation source files, searched for subclass super() calls. */
  scanFiles: ts.SourceFile[];
  /** Function-like declarations currently being analyzed (recursion guard). */
  activeDeclarations: Set<ts.Node>;
  /** Memoized type expansions keyed by internal type id. */
  typeCache: Map<number, PropNode>;
  /** Bindings of the call currently being inlined, if any. */
  currentFrame?: BindingFrame;
  depth: number;
}

export const createEvalContext = (
  checker: ts.TypeChecker,
  scanFiles: ts.SourceFile[] = [],
): EvalContext => ({
  checker,
  scanFiles,
  activeDeclarations: new Set(),
  typeCache: new Map(),
  depth: 0,
});

const withFrame = <T>(ctx: EvalContext, frame: BindingFrame | undefined, fn: () => T): T => {
  const previous = ctx.currentFrame;
  ctx.currentFrame = frame;
  try {
    return fn();
  } finally {
    ctx.currentFrame = previous;
  }
};

const propertyKeyName = (name: ts.PropertyName): string | undefined => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) ||
      ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined; // computed keys
};

const isDefaultLibSymbol = (symbol: ts.Symbol | undefined): boolean => {
  const declarations = symbol?.declarations ?? [];
  return declarations.length > 0 &&
    declarations.every(d => d.getSourceFile().hasNoDefaultLib);
};

export const PRIMITIVE_FLAGS =
  ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.EnumLike |
  ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void | ts.TypeFlags.Never;

/**
 * Union members that are pure plumbing on top of the CFN value: IResolvable
 * (token indirection) and the generated `IXxxRef` reference interfaces.
 */
export const filterUnionParts = (type: ts.Type): ts.Type[] =>
  (type.isUnion() ? type.types : [type]).filter(part => {
    if (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) {
      return false;
    }
    const symbolName = part.aliasSymbol?.name ?? part.symbol?.name;
    if (symbolName === 'IResolvable' || (symbolName && /^I\w+Ref$/.test(symbolName))) {
      return false;
    }
    return true;
  });

/**
 * Whether the members of this object type can be read as CFN property keys.
 * Generated Property interfaces, anonymous object types, and plain data
 * interfaces qualify; classes and method-bearing interfaces (Box wrappers,
 * IBucket, ...) are opaque values whose members would poison the key set.
 */
const isCfnShapedType = (part: ts.Type, checker: ts.TypeChecker): boolean => {
  const symbol = part.aliasSymbol ?? part.symbol;
  const declarations = symbol?.declarations ?? [];
  if (declarations.length === 0) {
    return true; // fully synthetic types (e.g. mapped types)
  }
  if (symbol!.flags & ts.SymbolFlags.Class) {
    return false;
  }
  if (declarations.some(d => ts.isTypeLiteralNode(d) || ts.isObjectLiteralExpression(d))) {
    return true;
  }
  if (declarations.some(d => isGeneratedFile(d.getSourceFile().fileName))) {
    return true;
  }
  // Named non-generated interface: expand only when it is data-only.
  for (const prop of checker.getPropertiesOfType(part)) {
    const kinds = (prop.declarations ?? []).map(d => d.kind);
    if (kinds.includes(ts.SyntaxKind.MethodSignature) || kinds.includes(ts.SyntaxKind.MethodDeclaration)) {
      return false;
    }
  }
  return true;
};

/**
 * Expands a static type into the tree of keys a value of that type may carry.
 * Arrays and Records are flattened onto their element/value type, matching the
 * dot-notation flattening used on the L1 side.
 */
export const expandType = (
  type: ts.Type,
  ctx: EvalContext,
  depth: number = 0,
  visiting: Set<number> = new Set(),
): PropNode => {
  const typeId = (type as any).id as number;
  const cached = ctx.typeCache.get(typeId);
  if (cached) {
    return cached;
  }
  if (depth >= MAX_TYPE_DEPTH || visiting.has(typeId)) {
    return opaqueNode();
  }
  visiting.add(typeId);
  try {
    const parts = filterUnionParts(type);

    if (parts.length === 0) {
      return emptyNode('exact');
    }
    // A union mixing primitives and objects (e.g. `IBucketRef | string`) is a
    // scalar CFN value with reference sugar, not a nested structure.
    if (parts.some(part => part.flags & PRIMITIVE_FLAGS)) {
      return emptyNode('exact');
    }

    let result: PropNode | undefined;
    for (const part of parts) {
      const node = expandTypePart(part, ctx, depth, visiting);
      result = result ? unionNodes(result, node) : node;
    }
    const finalNode = result ?? emptyNode('exact');
    // Only cache complete expansions computed from the top of the visiting stack;
    // partial results produced under a cycle/depth guard must not be reused.
    if (depth === 0) {
      ctx.typeCache.set(typeId, finalNode);
    }
    return finalNode;
  } finally {
    visiting.delete(typeId);
  }
};

const expandTypePart = (
  part: ts.Type,
  ctx: EvalContext,
  depth: number,
  visiting: Set<number>,
): PropNode => {
  const { checker } = ctx;

  if (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive)) {
    return opaqueNode(); // NonPrimitive is the bare `object` keyword
  }
  // Uninstantiated generics and other type-level indirection carry no key info.
  if (part.flags & (ts.TypeFlags.TypeVariable | ts.TypeFlags.Conditional |
                    ts.TypeFlags.Substitution | ts.TypeFlags.Index)) {
    return opaqueNode();
  }
  if (part.flags & PRIMITIVE_FLAGS) {
    return emptyNode('exact');
  }
  // Arrays / tuples flatten onto the element type; records/maps onto the value
  // type. Checked before the default-lib leaf rule: `Array` is a lib symbol.
  const numberIndex = checker.getIndexTypeOfType(part, ts.IndexKind.Number);
  if (numberIndex) {
    return expandType(numberIndex, ctx, depth + 1, visiting);
  }
  const stringIndex = checker.getIndexTypeOfType(part, ts.IndexKind.String);
  if (stringIndex) {
    return expandType(stringIndex, ctx, depth + 1, visiting);
  }
  // Values typed by default-lib classes (Date, Function, ...) are leaves.
  if (isDefaultLibSymbol(part.symbol)) {
    return emptyNode('exact');
  }

  if (part.getCallSignatures().length > 0) {
    return emptyNode('exact');
  }

  const properties = checker.getPropertiesOfType(part);
  if (properties.length === 0) {
    return emptyNode('exact');
  }

  if (!isCfnShapedType(part, checker)) {
    return opaqueNode();
  }

  const node: PropNode = { children: new Map(), analysis: 'type-inferred' };
  for (const prop of properties) {
    const declaration = prop.valueDeclaration ?? prop.declarations?.[0];
    if (!declaration) {
      continue;
    }
    const propType = checker.getTypeOfSymbolAtLocation(prop, declaration);
    node.children.set(prop.getName(), expandType(propType, ctx, depth + 1, visiting));
  }
  return node;
};

const typeFallback = (node: ts.Node, ctx: EvalContext): PropNode =>
  expandType(ctx.checker.getTypeAtLocation(node), ctx);

interface ResolvedFunction {
  fn: ts.SignatureDeclaration;
  /** Lexical frame the function value was captured in, if it flowed through a binding. */
  frame?: BindingFrame;
}

/** Finds the function-like declaration behind an expression, if statically known. */
const resolveFunctionLike = (
  expr: ts.Expression,
  ctx: EvalContext,
): ResolvedFunction | undefined => {
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    return { fn: expr, frame: ctx.currentFrame };
  }
  if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) {
    const symbol = resolveSymbol(expr, ctx);
    const declaration = symbol?.valueDeclaration;
    if (declaration) {
      if (ts.isParameter(declaration)) {
        const bound = ctx.currentFrame?.bindings.get(declaration);
        if (bound && (ts.isArrowFunction(bound.expr) || ts.isFunctionExpression(bound.expr))) {
          return { fn: bound.expr, frame: bound.frame };
        }
        return undefined;
      }
      if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) {
        return { fn: declaration };
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
        return { fn: declaration.initializer };
      }
    }
  }
  return undefined;
};

const resolveSymbol = (expr: ts.Expression, ctx: EvalContext): ts.Symbol | undefined => {
  let symbol = ctx.checker.getSymbolAtLocation(expr);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
    symbol = ctx.checker.getAliasedSymbol(symbol);
  }
  return symbol;
};

/** Union of all `return` expressions of a function-like, with a recursion guard. */
const evalFunctionReturns = (fn: ts.SignatureDeclaration, ctx: EvalContext): PropNode => {
  if (ctx.activeDeclarations.has(fn)) {
    return opaqueNode();
  }
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (!body) {
    return opaqueNode();
  }
  ctx.activeDeclarations.add(fn);
  try {
    if (!ts.isBlock(body)) {
      return evalKeys(body, ctx);
    }
    const returns: ts.Expression[] = [];
    const collect = (node: ts.Node): void => {
      if (ts.isFunctionLike(node)) {
        return; // do not descend into nested functions
      }
      if (ts.isReturnStatement(node) && node.expression) {
        returns.push(node.expression);
      }
      ts.forEachChild(node, collect);
    };
    ts.forEachChild(body, collect);
    if (returns.length === 0) {
      return emptyNode('exact');
    }
    return returns.map(r => evalKeys(r, ctx)).reduce(unionNodes);
  } finally {
    ctx.activeDeclarations.delete(fn);
  }
};

/** Binds a call's arguments to the callee's (identifier) parameters. */
const bindArguments = (
  declaration: ts.SignatureDeclaration,
  call: ts.CallExpression,
  callerFrame: BindingFrame | undefined,
): BindingFrame => {
  const bindings = new Map<ts.Declaration, BoundArg>();
  declaration.parameters.forEach((param, index) => {
    if (param.dotDotDotToken || !ts.isIdentifier(param.name)) {
      return;
    }
    const arg = call.arguments[index];
    if (arg) {
      bindings.set(param, { expr: arg, frame: callerFrame });
    }
  });
  return { bindings };
};

/**
 * Unions every mutation of a target reference found inside `scope`:
 * `target = expr` (reassignment), `target.prop = expr` (member assignment),
 * and `target.push(expr)` (array building, flattened onto elements).
 */
const evalTargetMutations = (
  scope: ts.Node,
  isTarget: (expr: ts.Expression) => boolean,
  ctx: EvalContext,
): PropNode => {
  let node = emptyNode('exact');
  const setChild = (key: string, value: PropNode): void => {
    const existing = node.children.get(key);
    const children = new Map(node.children);
    children.set(key, existing ? unionNodes(existing, value) : value);
    node = { children, analysis: node.analysis };
  };
  const visit = (candidate: ts.Node): void => {
    if (ts.isBinaryExpression(candidate) &&
        candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (isTarget(candidate.left)) {
        node = unionNodes(node, evalKeys(candidate.right, ctx));
      } else if (ts.isPropertyAccessExpression(candidate.left) &&
                 isTarget(candidate.left.expression)) {
        setChild(candidate.left.name.text, evalKeys(candidate.right, ctx));
      }
    } else if (ts.isCallExpression(candidate) &&
               ts.isPropertyAccessExpression(candidate.expression) &&
               candidate.expression.name.text === 'push' &&
               isTarget(candidate.expression.expression)) {
      for (const arg of candidate.arguments) {
        const value = ts.isSpreadElement(arg) ? arg.expression : arg;
        node = unionNodes(node, evalKeys(value, ctx));
      }
    } else if (ts.isCallExpression(candidate) &&
               ts.isPropertyAccessExpression(candidate.expression) &&
               candidate.expression.name.text === 'set' &&
               candidate.arguments.length === 1 &&
               isTarget(candidate.expression.expression)) {
      // Box#set(value) — unary only, so Map#set(key, value) is not caught.
      node = unionNodes(node, evalKeys(candidate.arguments[0], ctx));
    }
    ts.forEachChild(candidate, visit);
  };
  visit(scope);
  return node;
};

/** All mutations of a local variable within its enclosing function or file. */
const evalVariableMutations = (declaration: ts.VariableDeclaration, ctx: EvalContext): PropNode => {
  if (!ts.isIdentifier(declaration.name)) {
    return emptyNode('exact');
  }
  const variableSymbol = ctx.checker.getSymbolAtLocation(declaration.name);
  if (!variableSymbol) {
    return emptyNode('exact');
  }
  let scope: ts.Node = declaration;
  while (scope.parent && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) {
    scope = scope.parent;
  }
  return evalTargetMutations(scope,
    expr => ts.isIdentifier(expr) && ctx.checker.getSymbolAtLocation(expr) === variableSymbol,
    ctx);
};

/** All mutations of `this.<prop>` anywhere in the declaring class body. */
const evalClassPropertyMutations = (declaration: ts.PropertyDeclaration, ctx: EvalContext): PropNode => {
  const parent = declaration.parent;
  if ((!ts.isClassDeclaration(parent) && !ts.isClassExpression(parent)) ||
      !ts.isIdentifier(declaration.name)) {
    return emptyNode('exact');
  }
  const propName = declaration.name.text;
  return evalTargetMutations(parent,
    expr => ts.isPropertyAccessExpression(expr) &&
      expr.expression.kind === ts.SyntaxKind.ThisKeyword &&
      expr.name.text === propName,
    ctx);
};

/**
 * When a constructor parameter cannot be resolved locally, unions the argument
 * expressions passed for it by `super(...)` calls of subclasses found in the
 * scanned files. This resolves the Base + variant pattern (e.g. ecs BaseService
 * receiving `additionalProps` from Ec2Service / FargateService).
 */
const evalSuperCallArguments = (
  param: ts.ParameterDeclaration,
  ctx: EvalContext,
): PropNode | undefined => {
  const ctor = param.parent;
  if (!ts.isConstructorDeclaration(ctor)) {
    return undefined;
  }
  const cls = ctor.parent;
  if (!ts.isClassDeclaration(cls) || !cls.name) {
    return undefined;
  }
  const classSymbol = ctx.checker.getSymbolAtLocation(cls.name);
  if (!classSymbol) {
    return undefined;
  }
  const index = ctor.parameters.indexOf(param);
  let node: PropNode | undefined;

  for (const sourceFile of ctx.scanFiles) {
    const visitClass = (candidate: ts.Node): void => {
      if (ts.isClassDeclaration(candidate)) {
        const extendsClause = candidate.heritageClauses?.find(h => h.token === ts.SyntaxKind.ExtendsKeyword);
        const parentExpr = extendsClause?.types[0]?.expression;
        if (parentExpr) {
          let parentSymbol = ctx.checker.getSymbolAtLocation(parentExpr);
          if (parentSymbol && (parentSymbol.flags & ts.SymbolFlags.Alias)) {
            parentSymbol = ctx.checker.getAliasedSymbol(parentSymbol);
          }
          if (parentSymbol === classSymbol) {
            const subCtor = candidate.members.find(ts.isConstructorDeclaration);
            if (subCtor?.body) {
              const visitSuper = (inner: ts.Node): void => {
                if (ts.isFunctionLike(inner) && inner !== subCtor) {
                  return;
                }
                if (ts.isCallExpression(inner) &&
                    inner.expression.kind === ts.SyntaxKind.SuperKeyword) {
                  const arg = inner.arguments[index];
                  if (arg) {
                    const value = withFrame(ctx, undefined, () => evalKeys(arg, ctx));
                    node = node ? unionNodes(node, value) : value;
                  }
                }
                ts.forEachChild(inner, visitSuper);
              };
              visitSuper(subCtor.body);
            }
          }
        }
      }
      ts.forEachChild(candidate, visitClass);
    };
    visitClass(sourceFile);
  }
  return node;
};

const evalSymbolValue = (symbol: ts.Symbol, at: ts.Node, ctx: EvalContext): PropNode => {
  const declaration = symbol.valueDeclaration;
  if (declaration) {
    if (ts.isParameter(declaration)) {
      const bound = ctx.currentFrame?.bindings.get(declaration);
      if (bound) {
        return withFrame(ctx, bound.frame, () => evalKeys(bound.expr, ctx));
      }
      if (!ctx.activeDeclarations.has(declaration)) {
        ctx.activeDeclarations.add(declaration);
        try {
          const fromSuper = evalSuperCallArguments(declaration, ctx);
          if (fromSuper) {
            return fromSuper;
          }
        } finally {
          ctx.activeDeclarations.delete(declaration);
        }
      }
    }
    if (ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration)) {
      if (ctx.activeDeclarations.has(declaration)) {
        return opaqueNode();
      }
      ctx.activeDeclarations.add(declaration);
      try {
        let node = declaration.initializer
          ? evalKeys(declaration.initializer, ctx)
          : emptyNode('exact');
        const mutations = ts.isVariableDeclaration(declaration)
          ? evalVariableMutations(declaration, ctx)
          : evalClassPropertyMutations(declaration, ctx);
        node = unionNodes(node, mutations);
        // A declaration with neither initializer nor mutations tells us nothing;
        // fall back to its declared type instead of claiming an empty value.
        if (node.children.size === 0 && node.analysis === 'exact' && !declaration.initializer) {
          return expandType(ctx.checker.getTypeOfSymbolAtLocation(symbol, at), ctx);
        }
        return node;
      } finally {
        ctx.activeDeclarations.delete(declaration);
      }
    }
    if (ts.isGetAccessorDeclaration(declaration)) {
      return evalFunctionReturns(declaration, ctx);
    }
  }
  return expandType(ctx.checker.getTypeOfSymbolAtLocation(symbol, at), ctx);
};

const evalObjectLiteral = (expr: ts.ObjectLiteralExpression, ctx: EvalContext): PropNode => {
  let node: PropNode = { children: new Map(), analysis: 'exact' };
  for (const member of expr.properties) {
    if (ts.isPropertyAssignment(member)) {
      const key = propertyKeyName(member.name);
      if (key !== undefined) {
        const child = evalKeys(member.initializer, ctx);
        const existing = node.children.get(key);
        node.children.set(key, existing ? unionNodes(existing, child) : child);
      }
    } else if (ts.isShorthandPropertyAssignment(member)) {
      const symbol = ctx.checker.getShorthandAssignmentValueSymbol(member);
      node.children.set(member.name.text, symbol ? evalSymbolValue(symbol, member, ctx) : opaqueNode());
    } else if (ts.isSpreadAssignment(member)) {
      node = unionNodes(node, evalKeys(member.expression, ctx));
    } else if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member)) {
      const key = propertyKeyName(member.name);
      if (key !== undefined) {
        node.children.set(key, evalFunctionReturns(member, ctx));
      }
    }
  }
  return node;
};

const lastIdentifierName = (expr: ts.Expression): string | undefined => {
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return expr.name.text;
  }
  return undefined;
};

const evalCallExpression = (expr: ts.CallExpression, ctx: EvalContext): PropNode => {
  const callee = expr.expression;

  if (ts.isPropertyAccessExpression(callee)) {
    // arr.map(cb) / arr.flatMap(cb) / box.derive(cb): the result's keys come
    // from the callback's return value (arrays flatten onto their elements).
    if (CALLBACK_RESULT_METHODS.has(callee.name.text) && expr.arguments.length >= 1) {
      const resolved = resolveFunctionLike(expr.arguments[0], ctx);
      if (resolved) {
        // The callback receives the receiver's content: bind its first
        // parameter to the receiver expression (arrays flatten onto elements,
        // so the receiver's node doubles as the element node).
        const bindings = new Map(resolved.frame?.bindings ?? []);
        const firstParam = resolved.fn.parameters[0];
        if (firstParam && ts.isIdentifier(firstParam.name) && !firstParam.dotDotDotToken) {
          bindings.set(firstParam, { expr: callee.expression, frame: ctx.currentFrame });
        }
        return withFrame(ctx, { bindings }, () => evalFunctionReturns(resolved.fn, ctx));
      }
      return typeFallback(expr, ctx);
    }
    // Lazy.any({ produce: () => ... }): evaluate the producer.
    if ((callee.name.text === 'any' || callee.name.text === 'anyValue') &&
        lastIdentifierName(callee.expression) === 'Lazy' &&
        expr.arguments.length >= 1 && ts.isObjectLiteralExpression(expr.arguments[0])) {
      for (const member of expr.arguments[0].properties) {
        if (ts.isPropertyAssignment(member) && propertyKeyName(member.name) === 'produce') {
          const producer = resolveFunctionLike(member.initializer, ctx);
          if (producer) {
            return withFrame(ctx, producer.frame, () => evalFunctionReturns(producer.fn, ctx));
          }
        }
        if (ts.isMethodDeclaration(member) && propertyKeyName(member.name) === 'produce') {
          return evalFunctionReturns(member, ctx);
        }
      }
      return opaqueNode();
    }
    // Box.fromValue(x) wraps x and resolves back to it at synth time.
    if (callee.name.text === 'fromValue' &&
        lastIdentifierName(callee.expression) === 'Box' && expr.arguments.length >= 1) {
      return evalKeys(expr.arguments[0], ctx);
    }
  }

  // General calls: inline the resolved declaration's body when available,
  // binding arguments so higher-order helpers stay analyzable.
  const signature = ctx.checker.getResolvedSignature(expr);
  const declaration = signature?.declaration;
  if (declaration && !ts.isJSDocSignature(declaration) &&
      (declaration as ts.FunctionLikeDeclaration).body) {
    const frame = bindArguments(declaration, expr, ctx.currentFrame);
    return withFrame(ctx, frame, () => evalFunctionReturns(declaration, ctx));
  }
  return typeFallback(expr, ctx);
};

/**
 * Evaluates which property keys (recursively) the given expression's value can
 * contain at synth time. Union semantics: conditionals contribute both branches.
 */
export const evalKeys = (expr: ts.Expression, ctx: EvalContext): PropNode => {
  if (ctx.depth >= MAX_EVAL_DEPTH) {
    return opaqueNode();
  }
  ctx.depth++;
  try {
    // Transparent wrappers
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) ||
        ts.isNonNullExpression(expr) || ts.isTypeAssertionExpression(expr) ||
        ts.isSatisfiesExpression(expr)) {
      return evalKeys(expr.expression, ctx);
    }
    if (ts.isObjectLiteralExpression(expr)) {
      return evalObjectLiteral(expr, ctx);
    }
    if (ts.isArrayLiteralExpression(expr)) {
      let node = emptyNode('exact');
      for (const element of expr.elements) {
        const value = ts.isSpreadElement(element) ? element.expression : element;
        if (ts.isOmittedExpression(value)) {
          continue;
        }
        node = unionNodes(node, evalKeys(value, ctx));
      }
      return node;
    }
    if (ts.isConditionalExpression(expr)) {
      return unionNodes(evalKeys(expr.whenTrue, ctx), evalKeys(expr.whenFalse, ctx));
    }
    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
        return unionNodes(evalKeys(expr.left, ctx), evalKeys(expr.right, ctx));
      }
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.CommaToken) {
        return evalKeys(expr.right, ctx);
      }
      return typeFallback(expr, ctx);
    }
    if (ts.isCallExpression(expr)) {
      return evalCallExpression(expr, ctx);
    }
    if (ts.isIdentifier(expr)) {
      if (expr.text === 'undefined') {
        return emptyNode('exact');
      }
      const symbol = resolveSymbol(expr, ctx);
      return symbol ? evalSymbolValue(symbol, expr, ctx) : typeFallback(expr, ctx);
    }
    if (ts.isPropertyAccessExpression(expr)) {
      const symbol = resolveSymbol(expr, ctx);
      return symbol ? evalSymbolValue(symbol, expr, ctx) : typeFallback(expr, ctx);
    }
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
      return emptyNode('exact');
    }
    if (ts.isLiteralExpression(expr) || ts.isTemplateExpression(expr) ||
        expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword ||
        expr.kind === ts.SyntaxKind.NullKeyword) {
      return emptyNode('exact');
    }
    return typeFallback(expr, ctx);
  } finally {
    ctx.depth--;
  }
};
