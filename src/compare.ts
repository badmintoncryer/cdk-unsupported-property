import { L1Construct, L1Property, L2Usage, MissingProp, PropNode } from './types';

export interface CompareOptions {
  includeDeprecated: boolean;
}

const normalizePath = (segments: string[]): string =>
  segments.map(s => s.toLowerCase()).join('.');

/**
 * Walks the L1 property tree and reports every path the L2 usage union cannot
 * produce. Only the shallowest missing level of a branch is reported.
 *
 * Confidence is decided by the container node consulted for the lookup:
 * `exact` / `type-inferred` key sets are treated as complete (high confidence),
 * `opaque` means the analysis lost track of the value (low confidence).
 */
export const compareConstruct = (
  l1: L1Construct,
  usage: L2Usage,
  options: CompareOptions,
): MissingProp[] => {
  const missing: MissingProp[] = [];
  const overridePaths = usage.overridePaths.map(p => normalizePath(p.split('.')));

  const coveredByOverride = (norm: string): boolean => overridePaths.includes(norm);
  const hasDeeperOverride = (norm: string): boolean =>
    overridePaths.some(p => p.startsWith(`${norm}.`));

  const includeProp = (prop: L1Property): boolean =>
    options.includeDeprecated || !prop.deprecated;

  /** Reports L1 paths under an override-covered prefix that no override sets. */
  const walkOverridesOnly = (l1Props: Map<string, L1Property>, prefix: string[]): void => {
    for (const [name, l1Prop] of l1Props) {
      if (!includeProp(l1Prop)) {
        continue;
      }
      const segments = [...prefix, name];
      const norm = normalizePath(segments);
      if (coveredByOverride(norm)) {
        continue;
      }
      if (hasDeeperOverride(norm)) {
        if (l1Prop.children.size > 0) {
          walkOverridesOnly(l1Prop.children, segments);
        }
        continue;
      }
      missing.push({ path: segments.join('.'), confidence: 'high', docLink: l1Prop.docLink });
    }
  };

  const walk = (
    l1Props: Map<string, L1Property>,
    container: PropNode,
    prefix: string[],
  ): void => {
    for (const [name, l1Prop] of l1Props) {
      if (!includeProp(l1Prop)) {
        continue;
      }
      const segments = [...prefix, name];
      const child = container.children.get(name);
      if (!child) {
        const norm = normalizePath(segments);
        if (coveredByOverride(norm)) {
          continue;
        }
        if (hasDeeperOverride(norm)) {
          walkOverridesOnly(l1Prop.children, segments);
          continue;
        }
        missing.push({
          path: segments.join('.'),
          confidence: container.analysis === 'opaque' ? 'low' : 'high',
          docLink: l1Prop.docLink,
        });
        continue;
      }
      if (l1Prop.children.size > 0) {
        walk(l1Prop.children, child, segments);
      }
    }
  };

  walk(l1.props, usage.supported, []);
  return missing;
};
