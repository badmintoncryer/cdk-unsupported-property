import { runAnalysis } from '../src/cli';
import { ConstructReport } from '../src/types';

/**
 * Regression tests against a real aws-cdk checkout. Set CDK_REPO_PATH to the
 * repository root (built, per the README) to enable them, e.g.:
 *   CDK_REPO_PATH=~/git/aws-cdk npx projen test
 */
const cdkRepo = process.env.CDK_REPO_PATH;
const describeGolden = cdkRepo ? describe : describe.skip;

jest.setTimeout(600_000);

describeGolden('golden analysis of real aws-cdk modules', () => {
  let reports: ConstructReport[];
  const byName = (module: string, name: string): ConstructReport | undefined =>
    reports.find(r => r.module === module && r.name === name);

  beforeAll(async () => {
    const result = await runAnalysis({
      packagesDir: `${cdkRepo}/packages`,
      outPath: '/dev/null',
      exclusionsPath: `${__dirname}/../exclusions.json`,
      includeDeprecated: false,
      services: new Set(['s3', 'lambda', 'iam', 'route53resolver', 'ec2']),
    });
    reports = result.reports;
  });

  test('s3 CfnBucket: helper-rendered configs are not false positives', () => {
    const bucket = byName('aws-s3', 'CfnBucket')!;
    expect(bucket).toBeDefined();
    expect(bucket.missingProps).not.toContain('corsConfiguration.corsRules');
    expect(bucket.missingProps.filter(p => p.startsWith('inventoryConfigurations.'))).toEqual([]);
    // tags are excluded with a reason instead of reported.
    expect(bucket.missingProps).not.toContain('tags');
    expect(bucket.excludedProps?.some(e => e.prop === 'tags')).toBe(true);
  });

  test('lambda CfnFunction: environment variables are supported', () => {
    const fn = byName('aws-lambda', 'CfnFunction');
    if (fn) {
      expect(fn.missingProps).not.toContain('environment.variables');
      expect(fn.missingProps).not.toContain('tracingConfig');
    }
  });

  test('route53resolver alpha: map-rendered rules are not false positives', () => {
    const group = byName('aws-route53resolver-alpha', 'CfnFirewallRuleGroup');
    if (group) {
      expect(group.missingProps).not.toContain('firewallRules.action');
      expect(group.missingProps).not.toContain('firewallRules.blockOverrideDnsType');
    }
  });

  test('iam CfnRole: inline policies are supported', () => {
    const role = byName('aws-iam', 'CfnRole');
    if (role) {
      expect(role.missingProps.filter(p => p.startsWith('policies'))).toEqual([]);
    }
  });

  test('ec2 CfnLaunchTemplate: genuinely unset data props are reported', () => {
    const template = byName('aws-ec2', 'CfnLaunchTemplate')!;
    expect(template).toBeDefined();
    expect(template.missingProps).toContain('launchTemplateData.disableApiStop');
  });

  test('every finding carries a confidence level', () => {
    for (const report of reports) {
      expect(report.missingPropsDetailed).toHaveLength(report.missingProps.length);
      for (const detail of report.missingPropsDetailed) {
        expect(['high', 'low']).toContain(detail.confidence);
      }
    }
  });
});
