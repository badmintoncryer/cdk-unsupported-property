import * as fs from 'fs';

export interface ExclusionRule {
  /** Limit the rule to one construct, e.g. `aws-s3/CfnBucket`. Omit for global rules. */
  construct?: string;
  /** Exact property path match, e.g. `notificationConfiguration`. */
  prop?: string;
  /** Regular expression tested against the property path. */
  propPattern?: string;
  reason: string;
}

export interface CompiledExclusion extends ExclusionRule {
  pattern?: RegExp;
}

export const loadExclusions = (filePath: string): CompiledExclusion[] => {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { exclusions?: ExclusionRule[] };
  return (parsed.exclusions ?? []).map(rule => ({
    ...rule,
    pattern: rule.propPattern ? new RegExp(rule.propPattern) : undefined,
  }));
};

/** Returns the reason of the first matching exclusion rule, if any. */
export const findExclusion = (
  rules: CompiledExclusion[],
  constructKey: string,
  propPath: string,
): string | undefined => {
  for (const rule of rules) {
    if (rule.construct && rule.construct !== constructKey) {
      continue;
    }
    if (rule.prop !== undefined && rule.prop === propPath) {
      return rule.reason;
    }
    if (rule.pattern?.test(propPath)) {
      return rule.reason;
    }
  }
  return undefined;
};
