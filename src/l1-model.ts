import * as ts from 'typescript';
import { moduleOfPath } from './discover';
import { filterUnionParts } from './prop-eval';
import { L1Construct, L1Property } from './types';

const MAX_DEPTH = 10;

const docLinkOf = (decl: ts.Declaration): string | undefined => {
  // @see URLs are parsed by TS as name references, not tag comments, so read
  // them from the raw leading trivia instead of the structured JSDoc tags.
  const match = decl.getFullText().match(/@see\s+(https?:\/\/\S+)/);
  return match?.[1];
};

const isDeprecated = (decl: ts.Declaration): boolean =>
  ts.getJSDocDeprecatedTag(decl) !== undefined;

const isDefaultLibSymbol = (symbol: ts.Symbol | undefined): boolean => {
  const declarations = symbol?.declarations ?? [];
  return declarations.length > 0 &&
    declarations.every(d => d.getSourceFile().hasNoDefaultLib);
};

const PRIMITIVE_FLAGS =
  ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.EnumLike |
  ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void | ts.TypeFlags.Never;

/** Builds the nested L1 property tree for a type, flattening arrays/records. */
const buildChildren = (
  type: ts.Type,
  checker: ts.TypeChecker,
  depth: number,
  visiting: Set<number>,
): Map<string, L1Property> => {
  const children = new Map<string, L1Property>();
  const typeId = (type as any).id as number;
  if (depth >= MAX_DEPTH || visiting.has(typeId)) {
    return children;
  }
  visiting.add(typeId);
  try {
    const parts = filterUnionParts(type);
    // Unions mixing primitives and objects (`IBucketRef | string`) are scalars.
    if (parts.some(part => part.flags & PRIMITIVE_FLAGS)) {
      return children;
    }

    for (const part of parts) {
      if (part.flags & (PRIMITIVE_FLAGS | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
        continue;
      }
      // Arrays/tuples/records flatten onto their element type. This must come
      // before the default-lib check: `Array` itself is a default-lib symbol.
      const numberIndex = checker.getIndexTypeOfType(part, ts.IndexKind.Number);
      const stringIndex = checker.getIndexTypeOfType(part, ts.IndexKind.String);
      const target = numberIndex ?? stringIndex;
      if (!target && isDefaultLibSymbol(part.symbol)) {
        continue;
      }
      if (target) {
        for (const [name, prop] of buildChildren(target, checker, depth + 1, visiting)) {
          if (!children.has(name)) {
            children.set(name, prop);
          }
        }
        continue;
      }
      for (const propSymbol of checker.getPropertiesOfType(part)) {
        if (children.has(propSymbol.getName())) {
          continue;
        }
        const declaration = propSymbol.valueDeclaration ?? propSymbol.declarations?.[0];
        if (!declaration) {
          continue;
        }
        const propType = checker.getTypeOfSymbolAtLocation(propSymbol, declaration);
        children.set(propSymbol.getName(), {
          name: propSymbol.getName(),
          deprecated: isDeprecated(declaration),
          docLink: docLinkOf(declaration),
          children: buildChildren(propType, checker, depth + 1, visiting),
        });
      }
    }
    return children;
  } finally {
    visiting.delete(typeId);
  }
};

/**
 * Extracts every `CfnXxxProps` interface from the given generated source files
 * into a property-tree model. Keys are `${homeModule}/${cfnName}`.
 */
export const extractL1Model = (
  program: ts.Program,
  generatedFiles: Set<string>,
): Map<string, L1Construct> => {
  const checker = program.getTypeChecker();
  const model = new Map<string, L1Construct>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!generatedFiles.has(sourceFile.fileName)) {
      continue;
    }
    const homeModule = moduleOfPath(sourceFile.fileName);
    if (!homeModule) {
      continue;
    }
    for (const statement of sourceFile.statements) {
      if (!ts.isInterfaceDeclaration(statement)) {
        continue;
      }
      const match = statement.name.text.match(/^(Cfn\w+)Props$/);
      if (!match) {
        continue;
      }
      const cfnName = match[1];
      const props = new Map<string, L1Property>();
      for (const member of statement.members) {
        if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name) || !member.type) {
          continue;
        }
        const propType = checker.getTypeFromTypeNode(member.type);
        props.set(member.name.text, {
          name: member.name.text,
          deprecated: isDeprecated(member),
          docLink: docLinkOf(member),
          children: buildChildren(propType, checker, 0, new Set()),
        });
      }
      if (props.size > 0) {
        model.set(`${homeModule}/${cfnName}`, { homeModule, cfnName, props });
      }
    }
  }
  return model;
};
