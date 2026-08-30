/**
 * How the key set of a {@link PropNode} was derived.
 *
 * - `exact`: from literal analysis (object literals, resolved function bodies).
 *   Absence of a key is a reliable signal.
 * - `type-inferred`: from the static (declared) type of an expression. The key set
 *   is an over-approximation for well-typed code, so absence is still meaningful.
 * - `opaque`: the value could not be analyzed at all. Absence means nothing.
 */
export type Analysis = 'exact' | 'type-inferred' | 'opaque';

/** A node in the tree of property keys an expression can produce at synth time. */
export interface PropNode {
  children: Map<string, PropNode>;
  analysis: Analysis;
}

/** One property of an L1 (CfnXxxProps) interface, with its nested tree. */
export interface L1Property {
  name: string;
  deprecated: boolean;
  docLink?: string;
  children: Map<string, L1Property>;
}

/** An L1 construct extracted from a `*.generated.ts` file. */
export interface L1Construct {
  /** Module directory name owning the generated file, e.g. `aws-s3` */
  homeModule: string;
  /** Class name, e.g. `CfnBucket` */
  cfnName: string;
  props: Map<string, L1Property>;
}

/** Union of everything the L2 code sets on a given Cfn resource. */
export interface L2Usage {
  homeModule: string;
  cfnName: string;
  /** Union across all call sites; children are top-level props. */
  supported: PropNode;
  /** Raw paths recorded from addPropertyOverride()/addOverride(), CFN-cased. */
  overridePaths: string[];
  /** Analyzed-module basenames (e.g. `aws-route53resolver-alpha`) with call sites. */
  sourceModules: Set<string>;
  callSiteCount: number;
}

export interface MissingProp {
  path: string;
  confidence: 'high' | 'low';
  docLink?: string;
}

export interface ExcludedProp {
  prop: string;
  reason: string;
}

/** One entry of missingProperties.json (legacy fields + additive extensions). */
export interface ConstructReport {
  module: string;
  name: string;
  missingProps: string[];
  missingPropsDetailed: MissingProp[];
  excludedProps?: ExcludedProp[];
}
