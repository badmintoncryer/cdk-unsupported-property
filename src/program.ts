import * as ts from 'typescript';

/**
 * Creates a single ts.Program over all root files. Shared dependencies (core,
 * cross-module imports) are parsed once, and alpha modules resolve `aws-cdk-lib`
 * imports to built .d.ts files through the workspace's node_modules symlink.
 */
export const ANALYSIS_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  skipLibCheck: true,
  skipDefaultLibCheck: true,
  noEmit: true,
  allowJs: false,
  strict: false,
  types: [],
};

export const createAnalysisProgram = (rootFiles: string[], host?: ts.CompilerHost): ts.Program =>
  ts.createProgram(rootFiles, ANALYSIS_COMPILER_OPTIONS, host);
