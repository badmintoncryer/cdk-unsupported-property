import * as ts from 'typescript';
import { isGeneratedFile, moduleOfPath, serviceName } from './discover';
import { detectOverrideCall, detectPropertyAssignment } from './post-ctor';
import { emptyNode, EvalContext, evalKeys, unionNodes } from './prop-eval';
import { L2Usage } from './types';

export interface ScanTarget {
  file: string;
  /** Analyzed module basename, e.g. `aws-s3` or `aws-route53resolver-alpha` */
  moduleName: string;
}

const usageKey = (homeModule: string, cfnName: string): string => `${homeModule}/${cfnName}`;

/** Resolves a `new Xxx(...)` callee to a generated Cfn class, if it is one. */
const resolveCfnConstructor = (
  callee: ts.Expression,
  checker: ts.TypeChecker,
): { cfnName: string; homeModule: string } | undefined => {
  let symbol = checker.getSymbolAtLocation(callee);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  for (const declaration of symbol?.declarations ?? []) {
    if (!ts.isClassDeclaration(declaration) || !declaration.name) {
      continue;
    }
    const fileName = declaration.getSourceFile().fileName;
    if (isGeneratedFile(fileName) && declaration.name.text.startsWith('Cfn')) {
      const homeModule = moduleOfPath(fileName);
      if (homeModule) {
        return { cfnName: declaration.name.text, homeModule };
      }
    }
  }
  return undefined;
};

/**
 * Scans implementation files for every way L2 code sets L1 properties:
 * `new CfnXxx(...)` call sites (any logical ID), post-construction assignments,
 * and property overrides. Results are unioned per Cfn class.
 *
 * Only call sites living in the Cfn class's own service module (stable or alpha
 * counterpart) are counted, mirroring the "which L2 wraps this L1" question.
 */
export const scanCallSites = (
  program: ts.Program,
  targets: ScanTarget[],
  ctx: EvalContext,
): Map<string, L2Usage> => {
  const checker = program.getTypeChecker();
  if (ctx.scanFiles.length === 0) {
    ctx.scanFiles = targets
      .map(t => program.getSourceFile(t.file))
      .filter((sf): sf is ts.SourceFile => sf !== undefined);
  }
  const usages = new Map<string, L2Usage>();

  const usageFor = (homeModule: string, cfnName: string): L2Usage => {
    const key = usageKey(homeModule, cfnName);
    let usage = usages.get(key);
    if (!usage) {
      usage = {
        homeModule,
        cfnName,
        supported: emptyNode('exact'),
        overridePaths: [],
        sourceModules: new Set(),
        callSiteCount: 0,
      };
      usages.set(key, usage);
    }
    return usage;
  };

  for (const target of targets) {
    const sourceFile = program.getSourceFile(target.file);
    if (!sourceFile) {
      continue;
    }
    const sameService = (homeModule: string): boolean =>
      serviceName(homeModule) === serviceName(target.moduleName);

    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) {
        const cfn = resolveCfnConstructor(node.expression, checker);
        if (cfn && sameService(cfn.homeModule)) {
          const usage = usageFor(cfn.homeModule, cfn.cfnName);
          const propsArg = node.arguments && node.arguments.length >= 3 ? node.arguments[2] : undefined;
          const propsNode = propsArg ? evalKeys(propsArg, ctx) : emptyNode('exact');
          usage.supported = unionNodes(usage.supported, propsNode);
          usage.sourceModules.add(target.moduleName);
          usage.callSiteCount++;
        }
      } else if (ts.isBinaryExpression(node)) {
        const assignment = detectPropertyAssignment(node, checker);
        if (assignment && sameService(assignment.target.homeModule)) {
          const valueNode = evalKeys(assignment.value, ctx);
          // Only literal-derived assignments prove capability. Type-inferred
          // values here are usually escape-hatch copies of the existing data
          // (e.g. the IMDSv2 aspect spreading `...data`), which would blanket
          // the whole property tree as supported.
          if (valueNode.analysis === 'exact') {
            const usage = usageFor(assignment.target.homeModule, assignment.target.cfnName);
            const child = usage.supported.children.get(assignment.prop);
            usage.supported.children.set(
              assignment.prop,
              child ? unionNodes(child, valueNode) : valueNode,
            );
            usage.sourceModules.add(target.moduleName);
          }
        }
      } else if (ts.isCallExpression(node)) {
        const override = detectOverrideCall(node, checker);
        if (override && sameService(override.target.homeModule)) {
          const usage = usageFor(override.target.homeModule, override.target.cfnName);
          usage.overridePaths.push(override.path);
          usage.sourceModules.add(target.moduleName);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return usages;
};
