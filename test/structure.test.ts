import { analyzeFixture } from './fixture';
import { findExclusion, loadExclusions } from '../src/exclusions';
import { buildReports } from '../src/report';

const FOO_GENERATED = `
export declare class CfnWidget {
  constructor(scope: any, id: string, props?: CfnWidgetProps);
}
export interface CfnWidgetProps {
  readonly one?: string;
  readonly two?: string;
  readonly three?: string;
  /**
   * Old stuff.
   * @deprecated use three
   * @see http://docs.aws.amazon.com/foo#legacy
   */
  readonly legacy?: string;
}
`;

const BAR_GENERATED = `
export declare class CfnWidget {
  constructor(scope: any, id: string, props?: CfnWidgetProps);
}
export interface CfnWidgetProps {
  readonly barOnly?: string;
}
`;

describe('structural behavior', () => {
  test('multiple call sites union, alias imports, any logical ID', () => {
    const fixture = analyzeFixture({
      '/virt/aws-foo/lib/foo.generated.ts': FOO_GENERATED,
      '/virt/aws-foo/lib/a.ts': `
import { CfnWidget } from './foo.generated';
new CfnWidget({} as any, 'Default', { one: '1' });
`,
      '/virt/aws-foo/lib/b.ts': `
import { CfnWidget as Renamed } from './foo.generated';
new Renamed({} as any, 'SomethingElse', { two: '2' });
`,
    });
    const usage = fixture.usages.get('aws-foo/CfnWidget')!;
    expect(usage.callSiteCount).toBe(2);
    expect(fixture.missingPaths('aws-foo/CfnWidget')).toEqual(['three']);
  });

  test('same class name in another service module stays isolated', () => {
    const fixture = analyzeFixture({
      '/virt/aws-foo/lib/foo.generated.ts': FOO_GENERATED,
      '/virt/aws-foo/lib/impl.ts': `
import { CfnWidget } from './foo.generated';
new CfnWidget({} as any, 'R', { one: '1' });
`,
      '/virt/aws-bar/lib/bar.generated.ts': BAR_GENERATED,
      '/virt/aws-bar/lib/impl.ts': `
import { CfnWidget } from './bar.generated';
import { CfnWidget as FooWidget } from '../../aws-foo/lib/foo.generated';
new CfnWidget({} as any, 'R', { barOnly: 'x' });
// Cross-service instantiation must not count towards aws-foo's coverage:
new FooWidget({} as any, 'R', { one: '1', two: '2', three: '3' });
`,
    });
    // foo's coverage comes only from foo's own module files.
    expect(fixture.missingPaths('aws-foo/CfnWidget')).toEqual(['three', 'two']);
    expect(fixture.missingPaths('aws-bar/CfnWidget')).toEqual([]);
  });

  test('deprecated props are skipped by default and reported on demand', () => {
    const fixture = analyzeFixture({
      '/virt/aws-foo/lib/foo.generated.ts': FOO_GENERATED,
      '/virt/aws-foo/lib/impl.ts': `
import { CfnWidget } from './foo.generated';
new CfnWidget({} as any, 'R', { one: '1', two: '2', three: '3' });
`,
    });
    expect(fixture.missingPaths('aws-foo/CfnWidget')).toEqual([]);
    expect(fixture.missingPaths('aws-foo/CfnWidget', { includeDeprecated: true })).toEqual(['legacy']);
    const finding = fixture.missing('aws-foo/CfnWidget', { includeDeprecated: true })[0];
    expect(finding.docLink).toBe('http://docs.aws.amazon.com/foo#legacy');
  });

  test('constructor parameters resolve through subclass super() calls', () => {
    const fixture = analyzeFixture({
      '/virt/aws-foo/lib/foo.generated.ts': FOO_GENERATED,
      '/virt/aws-foo/lib/base.ts': `
import { CfnWidget } from './foo.generated';
export class BaseWidget {
  constructor(scope: any, additionalProps: any) {
    new CfnWidget(this, 'Resource', {
      one: '1',
      ...additionalProps,
    });
  }
}
`,
      '/virt/aws-foo/lib/sub.ts': `
import { BaseWidget } from './base';
export class SubWidget extends BaseWidget {
  constructor(scope: any) {
    super(scope, { two: '2' });
  }
}
`,
    });
    expect(fixture.missingPaths('aws-foo/CfnWidget')).toEqual(['three']);
  });
});

describe('exclusions and reporting', () => {
  test('exclusion rules match by construct, prop, and pattern', () => {
    const rules = [
      { construct: 'aws-foo/CfnWidget', prop: 'one', reason: 'method-based', pattern: undefined },
      { propPattern: '(^|\\.)tags$|Tags$', reason: 'tag manager', pattern: /(^|\.)tags$|Tags$/ },
    ];
    expect(findExclusion(rules, 'aws-foo/CfnWidget', 'one')).toBe('method-based');
    expect(findExclusion(rules, 'aws-bar/CfnOther', 'one')).toBeUndefined();
    expect(findExclusion(rules, 'aws-bar/CfnOther', 'tags')).toBe('tag manager');
    expect(findExclusion(rules, 'aws-bar/CfnOther', 'nested.tags')).toBe('tag manager');
    expect(findExclusion(rules, 'aws-bar/CfnOther', 'copyTags')).toBe('tag manager');
    expect(findExclusion(rules, 'aws-bar/CfnOther', 'tagsList')).toBeUndefined();
  });

  test('repo exclusions.json loads and excludes tags', () => {
    const rules = loadExclusions(`${__dirname}/../exclusions.json`);
    expect(rules.length).toBeGreaterThanOrEqual(2);
    expect(findExclusion(rules, 'aws-anything/CfnAny', 'tags')).toBeTruthy();
  });

  test('reports keep the legacy shape, alpha naming, and excluded props', () => {
    const fixture = analyzeFixture({
      '/virt/aws-cdk-lib/aws-foo/lib/foo.generated.ts': FOO_GENERATED,
      '/virt/@aws-cdk/aws-foo-alpha/lib/impl.ts': `
import { CfnWidget } from '../../../aws-cdk-lib/aws-foo/lib/foo.generated';
new CfnWidget({} as any, 'R', { one: '1' });
`,
    });
    const reports = buildReports(
      fixture.model,
      fixture.usages,
      [{ construct: 'aws-foo/CfnWidget', prop: 'two', reason: 'covered elsewhere', pattern: undefined }],
      { includeDeprecated: false },
    );
    expect(reports).toHaveLength(1);
    expect(reports[0].module).toBe('aws-foo-alpha');
    expect(reports[0].name).toBe('CfnWidget');
    expect(reports[0].missingProps).toEqual(['three']);
    expect(reports[0].missingPropsDetailed[0].confidence).toBe('high');
    expect(reports[0].excludedProps).toEqual([{ prop: 'two', reason: 'covered elsewhere' }]);
  });
});
