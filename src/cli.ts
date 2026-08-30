import * as fs from 'fs';
import * as path from 'path';
import { scanCallSites, ScanTarget } from './callsites';
import { discoverModules, isGeneratedFile, listLibFiles, ModuleRef, serviceName } from './discover';
import { loadExclusions } from './exclusions';
import { extractL1Model } from './l1-model';
import { createAnalysisProgram } from './program';
import { createEvalContext } from './prop-eval';
import { buildReports } from './report';

export interface CliOptions {
  packagesDir: string;
  outPath: string;
  exclusionsPath: string;
  includeDeprecated: boolean;
  /** Restrict analysis to these service names (e.g. `s3,lambda`). Mainly for tests. */
  services?: Set<string>;
}

export const parseArgs = (argv: string[]): CliOptions | undefined => {
  const positional: string[] = [];
  const options = {
    outPath: path.join(process.cwd(), 'missingProperties.json'),
    exclusionsPath: path.join(process.cwd(), 'exclusions.json'),
    includeDeprecated: false,
    services: undefined as Set<string> | undefined,
  };
  for (const arg of argv) {
    if (arg === '--include-deprecated') {
      options.includeDeprecated = true;
    } else if (arg.startsWith('--out=')) {
      options.outPath = path.resolve(arg.slice('--out='.length));
    } else if (arg.startsWith('--exclusions=')) {
      options.exclusionsPath = path.resolve(arg.slice('--exclusions='.length));
    } else if (arg.startsWith('--modules=')) {
      options.services = new Set(arg.slice('--modules='.length).split(',').map(s => serviceName(s.trim())));
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    } else {
      console.error(`Unknown option: ${arg}`);
      return undefined;
    }
  }
  if (positional.length !== 1) {
    console.error('Usage: ts-node src/index.ts <aws-cdk-repo>/packages [--out=path] [--exclusions=path] [--modules=s3,lambda] [--include-deprecated]');
    return undefined;
  }
  return { packagesDir: path.resolve(positional[0]), ...options };
};

export interface AnalysisResult {
  reports: ReturnType<typeof buildReports>;
  l1Count: number;
  usageCount: number;
}

/** Runs the full pipeline. Exported for the golden e2e tests. */
export const runAnalysis = async (options: CliOptions): Promise<AnalysisResult> => {
  const { stable, alpha } = discoverModules(options.packagesDir);
  const wanted = (module: ModuleRef): boolean =>
    !options.services || options.services.has(serviceName(module.name));
  const modules = [...stable, ...alpha].filter(wanted);
  if (modules.length === 0) {
    throw new Error(`No modules found under ${options.packagesDir}`);
  }
  console.log(`Analyzing ${modules.length} modules (${alpha.filter(wanted).length} alpha)`);

  const targets: ScanTarget[] = [];
  const generatedFiles = new Set<string>();
  for (const module of modules) {
    for (const file of await listLibFiles(module.dir)) {
      if (isGeneratedFile(file)) {
        generatedFiles.add(file);
      } else {
        targets.push({ file, moduleName: module.name });
      }
    }
  }
  console.log(`Creating TypeScript program (${targets.length} implementation files, ${generatedFiles.size} generated files)`);
  const started = Date.now();
  const program = createAnalysisProgram([...generatedFiles, ...targets.map(t => t.file)]);
  console.log(`Program created in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  console.log('Extracting L1 property model...');
  const l1Model = extractL1Model(program, generatedFiles);
  console.log(`Found ${l1Model.size} L1 constructs`);

  console.log('Scanning L2 call sites...');
  const ctx = createEvalContext(program.getTypeChecker());
  const usages = scanCallSites(program, targets, ctx);
  console.log(`Found usages for ${usages.size} Cfn classes`);

  const exclusions = loadExclusions(options.exclusionsPath);
  const reports = buildReports(l1Model, usages, exclusions, {
    includeDeprecated: options.includeDeprecated,
  });
  return { reports, l1Count: l1Model.size, usageCount: usages.size };
};

export const runCli = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    process.exitCode = 1;
    return;
  }
  try {
    const { reports } = await runAnalysis(options);
    fs.writeFileSync(options.outPath, JSON.stringify(reports, null, 2), 'utf8');
    const totalMissing = reports.reduce((sum, r) => sum + r.missingProps.length, 0);
    const lowConfidence = reports.reduce(
      (sum, r) => sum + r.missingPropsDetailed.filter(m => m.confidence === 'low').length, 0);
    console.log(`\nResults written to ${options.outPath}`);
    console.log(`${reports.length} constructs with missing properties, ` +
      `${totalMissing} properties total (${lowConfidence} low confidence)`);
  } catch (error) {
    console.error('Analysis failed:', error);
    process.exitCode = 1;
  }
};
