import * as path from 'path';
import * as ts from 'typescript';
import { scanCallSites, ScanTarget } from '../src/callsites';
import { CompareOptions, compareConstruct } from '../src/compare';
import { isGeneratedFile } from '../src/discover';
import { extractL1Model } from '../src/l1-model';
import { ANALYSIS_COMPILER_OPTIONS, createAnalysisProgram } from '../src/program';
import { createEvalContext } from '../src/prop-eval';
import { L1Construct, L2Usage, MissingProp } from '../src/types';

export interface Fixture {
  program: ts.Program;
  model: Map<string, L1Construct>;
  usages: Map<string, L2Usage>;
  missing: (key: string, options?: Partial<CompareOptions>) => MissingProp[];
  missingPaths: (key: string, options?: Partial<CompareOptions>) => string[];
}

/**
 * Compiles an in-memory fixture (file path -> source) and runs the pipeline.
 * File paths must contain an `aws-*` module segment, e.g.
 * `/virt/aws-foo/lib/foo.generated.ts`. Every non-generated .ts file is
 * scanned as an implementation file of its module.
 */
export const analyzeFixture = (files: Record<string, string>): Fixture => {
  const normalized = new Map(Object.entries(files).map(([p, c]) => [path.normalize(p), c]));
  const virtualDirs = new Set<string>();
  for (const filePath of normalized.keys()) {
    let dir = path.dirname(filePath);
    while (dir !== path.dirname(dir)) {
      virtualDirs.add(dir);
      dir = path.dirname(dir);
    }
  }
  const baseHost = ts.createCompilerHost(ANALYSIS_COMPILER_OPTIONS);
  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists: f => normalized.has(path.normalize(f)) || baseHost.fileExists(f),
    readFile: f => normalized.get(path.normalize(f)) ?? baseHost.readFile(f),
    directoryExists: d => virtualDirs.has(path.normalize(d)) ||
      (baseHost.directoryExists?.(d) ?? false),
    realpath: f => (normalized.has(path.normalize(f)) ? f : (baseHost.realpath?.(f) ?? f)),
    getSourceFile: (f, langVersion, onError, shouldCreate) => {
      const content = normalized.get(path.normalize(f));
      if (content !== undefined) {
        return ts.createSourceFile(f, content, langVersion, true);
      }
      return baseHost.getSourceFile(f, langVersion, onError, shouldCreate);
    },
    writeFile: () => {},
  };

  const rootFiles = [...normalized.keys()];
  const program = createAnalysisProgram(rootFiles, host);

  const generated = new Set(rootFiles.filter(isGeneratedFile));
  const targets: ScanTarget[] = rootFiles
    .filter(f => !isGeneratedFile(f))
    .map(f => {
      const moduleName = f.split(path.sep).find(seg => seg.startsWith('aws-'));
      if (!moduleName) {
        throw new Error(`Fixture file path must contain an aws-* segment: ${f}`);
      }
      return { file: f, moduleName };
    });

  const model = extractL1Model(program, generated);
  const ctx = createEvalContext(program.getTypeChecker());
  const usages = scanCallSites(program, targets, ctx);

  const missing = (key: string, options?: Partial<CompareOptions>): MissingProp[] => {
    const l1 = model.get(key);
    const usage = usages.get(key);
    if (!l1) {
      throw new Error(`No L1 construct ${key}; have: ${[...model.keys()].join(', ')}`);
    }
    if (!usage) {
      throw new Error(`No L2 usage for ${key}; have: ${[...usages.keys()].join(', ')}`);
    }
    return compareConstruct(l1, usage, { includeDeprecated: false, ...options });
  };

  return {
    program,
    model,
    usages,
    missing,
    missingPaths: (key, options) => missing(key, options).map(m => m.path).sort(),
  };
};
