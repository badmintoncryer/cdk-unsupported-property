import * as ts from 'typescript';
import { isGeneratedFile, moduleOfPath } from './discover';

export interface CfnClassRef {
  cfnName: string;
  homeModule: string;
}

/** Resolves a type to the generated Cfn class it declares, if any. */
export const cfnClassOfType = (type: ts.Type): CfnClassRef | undefined => {
  const declarations = type.symbol?.declarations ?? [];
  for (const declaration of declarations) {
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

export interface PropertyAssignmentHit {
  target: CfnClassRef;
  prop: string;
  value: ts.Expression;
}

/** Detects `cfnResource.someProp = value` escape-hatch style assignments. */
export const detectPropertyAssignment = (
  node: ts.BinaryExpression,
  checker: ts.TypeChecker,
): PropertyAssignmentHit | undefined => {
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !ts.isPropertyAccessExpression(node.left)) {
    return undefined;
  }
  const receiverType = checker.getTypeAtLocation(node.left.expression);
  const target = cfnClassOfType(receiverType);
  if (!target) {
    return undefined;
  }
  return { target, prop: node.left.name.text, value: node.right };
};

export interface OverrideHit {
  target: CfnClassRef;
  /** CFN-cased dotted path, e.g. `LoggingConfiguration.DestinationConfigs` */
  path: string;
}

/** Detects addPropertyOverride('A.B', ...) / addOverride('Properties.A.B', ...). */
export const detectOverrideCall = (
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): OverrideHit | undefined => {
  if (!ts.isPropertyAccessExpression(node.expression) || node.arguments.length < 1) {
    return undefined;
  }
  const method = node.expression.name.text;
  const pathArg = node.arguments[0];
  if (!ts.isStringLiteral(pathArg)) {
    return undefined;
  }
  let path: string | undefined;
  if (method === 'addPropertyOverride') {
    path = pathArg.text;
  } else if (method === 'addOverride' && pathArg.text.startsWith('Properties.')) {
    path = pathArg.text.slice('Properties.'.length);
  }
  if (!path) {
    return undefined;
  }
  const receiverType = checker.getTypeAtLocation(node.expression.expression);
  const target = cfnClassOfType(receiverType);
  if (!target) {
    return undefined;
  }
  return { target, path };
};
