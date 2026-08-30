import { CompareOptions, compareConstruct } from './compare';
import { CompiledExclusion, findExclusion } from './exclusions';
import { ConstructReport, ExcludedProp, L1Construct, L2Usage, MissingProp } from './types';

/**
 * Joins the L1 model with the scanned L2 usages into report entries.
 * Only constructs that have an L2 usage and at least one missing property
 * are reported. Legacy fields (`module`, `name`, `missingProps`) keep their
 * historical shape; details and exclusions are additive.
 */
export const buildReports = (
  l1Model: Map<string, L1Construct>,
  usages: Map<string, L2Usage>,
  exclusions: CompiledExclusion[],
  options: CompareOptions,
): ConstructReport[] => {
  const reports: ConstructReport[] = [];

  for (const [key, l1] of l1Model) {
    const usage = usages.get(key);
    if (!usage) {
      continue; // no L2 wraps this construct
    }
    const findings = compareConstruct(l1, usage, options);
    const missing: MissingProp[] = [];
    const excluded: ExcludedProp[] = [];
    for (const finding of findings) {
      const reason = findExclusion(exclusions, key, finding.path);
      if (reason) {
        excluded.push({ prop: finding.path, reason });
      } else {
        missing.push(finding);
      }
    }
    if (missing.length === 0) {
      continue;
    }
    const alphaModule = [...usage.sourceModules].filter(m => m.endsWith('-alpha')).sort()[0];
    reports.push({
      module: alphaModule ?? usage.homeModule,
      name: l1.cfnName,
      missingProps: missing.map(m => m.path),
      missingPropsDetailed: missing,
      ...(excluded.length > 0 ? { excludedProps: excluded } : {}),
    });
  }

  return reports.sort((a, b) =>
    a.module.localeCompare(b.module) || a.name.localeCompare(b.name));
};
