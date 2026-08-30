import { analyzeFixture, Fixture } from './fixture';

/**
 * One CfnThing with one prop per evaluation pattern. Every nested Property
 * type has `keepA` (set by the L2 fixture) and `dropB` (never set), so each
 * pattern should report exactly `<prop>.dropB` when analysis succeeds.
 */
const GENERATED = `
export interface IResolvable { resolve(): any; }
export interface IThingRef { thingRef: { name: string }; }
export declare class CfnThing {
  constructor(scope: any, id: string, props?: CfnThingProps);
  addPropertyOverride(path: string, value: any): void;
}
export interface CfnThingProps {
  readonly direct?: CfnThing.NestedProperty | IResolvable;
  readonly viaHelper?: CfnThing.NestedProperty | IResolvable;
  readonly viaMap?: Array<CfnThing.NestedProperty | IResolvable> | IResolvable;
  readonly viaHof?: Array<CfnThing.NestedProperty | IResolvable> | IResolvable;
  readonly viaLazy?: CfnThing.NestedProperty | IResolvable;
  readonly viaTernary?: CfnThing.NestedProperty | IResolvable;
  readonly viaSpreadVar?: CfnThing.NestedProperty | IResolvable;
  readonly viaTypedParam?: CfnThing.NestedProperty | IResolvable;
  readonly viaOpaque?: CfnThing.NestedProperty | IResolvable;
  readonly viaLet?: CfnThing.NestedProperty | IResolvable;
  readonly viaPush?: Array<CfnThing.NestedProperty | IResolvable> | IResolvable;
  readonly viaBox?: CfnThing.NestedProperty | IResolvable;
  readonly viaStash?: CfnThing.NestedProperty | IResolvable;
  readonly viaAssign?: CfnThing.NestedProperty | IResolvable;
  readonly viaOverride?: CfnThing.NestedProperty | IResolvable;
  readonly scalarRef?: IThingRef | string;
  readonly neverSet?: string;
}
export declare namespace CfnThing {
  interface NestedProperty {
    readonly keepA?: string;
    readonly dropB?: string;
  }
}
`;

const IMPL = `
import { CfnThing } from './foo.generated';

class Lazy {
  static any(options: { produce: () => any }): any { return options; }
}
class Box<T> {
  static fromValue<T>(value: T): Box<T> { return new Box(); }
  set(value: T): void {}
}
interface DataShape { readonly keepA?: string; }
declare function externalOpaque(): any;

const renderHelper = () => ({ keepA: 'h' });
function hof<T, U>(xs: readonly T[] | undefined, fn: (t: T) => U): U[] | undefined {
  return xs?.map(fn);
}

export class Thing {
  private stash!: { keepA?: string };
  private boxed = Box.fromValue<any>(undefined);

  constructor(scope: any, rules: Array<{ keepA: string }>, data: DataShape) {
    this.stash = { keepA: 's' };
    this.boxed.set({ keepA: 'b' });

    let flow: any;
    if (scope) {
      flow = {};
      flow.keepA = 'f';
    }
    const arr: any[] = [];
    arr.push({ keepA: 'p' });
    const spreadSrc = { keepA: 'q' };

    const resource = new CfnThing(this, 'SomeLogicalId', {
      direct: { keepA: 'a' },
      viaHelper: renderHelper(),
      viaMap: rules.map(r => ({ keepA: r.keepA })),
      viaHof: hof(rules, r => ({ keepA: r.keepA })),
      viaLazy: Lazy.any({ produce: () => ({ keepA: 'z' }) }),
      viaTernary: scope ? { keepA: 'y' } : undefined,
      viaSpreadVar: { ...spreadSrc },
      viaTypedParam: data,
      viaOpaque: externalOpaque(),
      viaLet: flow,
      viaPush: arr,
      viaBox: this.boxed,
      viaStash: this.stash,
      scalarRef: 'name',
    });
    resource.viaAssign = { keepA: 'w' };
    resource.addPropertyOverride('ViaOverride.KeepA', 'o');
  }
}
`;

describe('property evaluation patterns', () => {
  let fixture: Fixture;
  let paths: string[];

  beforeAll(() => {
    fixture = analyzeFixture({
      '/virt/aws-foo/lib/foo.generated.ts': GENERATED,
      '/virt/aws-foo/lib/thing.ts': IMPL,
    });
    paths = fixture.missingPaths('aws-foo/CfnThing');
  });

  test('call sites are found regardless of the logical ID literal', () => {
    expect(fixture.usages.get('aws-foo/CfnThing')?.callSiteCount).toBe(1);
  });

  test.each([
    ['direct object literal', 'direct'],
    ['helper function call', 'viaHelper'],
    ['array map with inline callback', 'viaMap'],
    ['higher-order helper with callback parameter', 'viaHof'],
    ['Lazy.any producer', 'viaLazy'],
    ['ternary branch', 'viaTernary'],
    ['spread of a local literal', 'viaSpreadVar'],
    ['let reassignment and member assignment', 'viaLet'],
    ['array built via push()', 'viaPush'],
    ['Box.fromValue + set()', 'viaBox'],
    ['class property assigned in constructor', 'viaStash'],
    ['post-construction assignment', 'viaAssign'],
  ])('%s: only the unset nested key is missing', (_label, prop) => {
    expect(paths).toContain(`${prop}.dropB`);
    expect(paths).not.toContain(prop);
    expect(paths).not.toContain(`${prop}.keepA`);
  });

  test('data-only interface types expand to their declared keys', () => {
    // DataShape declares keepA only, so dropB is missing with high confidence.
    const finding = fixture.missing('aws-foo/CfnThing').find(m => m.path === 'viaTypedParam.dropB');
    expect(finding?.confidence).toBe('high');
    expect(paths).not.toContain('viaTypedParam.keepA');
  });

  test('unresolvable values yield low-confidence findings', () => {
    const findings = fixture.missing('aws-foo/CfnThing').filter(m => m.path.startsWith('viaOpaque.'));
    expect(findings.map(f => f.path).sort()).toEqual(['viaOpaque.dropB', 'viaOpaque.keepA']);
    for (const finding of findings) {
      expect(finding.confidence).toBe('low');
    }
  });

  test('literal-derived findings carry high confidence', () => {
    const finding = fixture.missing('aws-foo/CfnThing').find(m => m.path === 'direct.dropB');
    expect(finding?.confidence).toBe('high');
  });

  test('addPropertyOverride covers its path case-insensitively', () => {
    expect(paths).not.toContain('viaOverride');
    expect(paths).not.toContain('viaOverride.keepA');
    expect(paths).toContain('viaOverride.dropB');
  });

  test('IXxxRef | string unions are scalars, not nested structures', () => {
    expect(paths.filter(p => p.startsWith('scalarRef'))).toEqual([]);
  });

  test('top-level props never set are reported', () => {
    expect(paths).toContain('neverSet');
  });
});
