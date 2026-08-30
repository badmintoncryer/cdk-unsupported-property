# CDK UNSUPPORTED PROPERTY

Creates a list of CloudFormation properties that cannot be configured through
AWS CDK L2 constructs, by statically analyzing the aws-cdk repository with the
TypeScript compiler API.

The result (`missingProperties.json`) is published at
[CDK Unsupported Property App](https://github.com/badmintoncryer/cdk-unsupported-property-app).

## Usage

1. Prepare a built AWS CDK repository:

```bash
git clone https://github.com/aws/aws-cdk.git
cd aws-cdk
yarn
yarn build
cd ../
```

2. Run the analysis:

```bash
git clone https://github.com/badmintoncryer/cdk-unsupported-property.git
cd cdk-unsupported-property
npm install
NODE_OPTIONS=--max-old-space-size=8192 npx ts-node src/index.ts ../aws-cdk/packages
# creates ./missingProperties.json
```

### Options

| Flag | Effect |
|---|---|
| `--out=<path>` | Output path (default `./missingProperties.json`) |
| `--exclusions=<path>` | Exclusions file (default `./exclusions.json`) |
| `--modules=s3,lambda` | Restrict analysis to specific services (mainly for testing) |
| `--include-deprecated` | Also report properties marked `@deprecated` in the L1 |

## How it works

One TypeScript `Program` is created over every `aws-cdk-lib/aws-*` module and
`@aws-cdk/aws-*-alpha` module. Three passes run on top of the type checker:

1. **L1 model** (`src/l1-model.ts`) — every `CfnXxxProps` interface in
   `*.generated.ts` files is expanded into a nested property tree (arrays and
   records flatten onto their element type), with `@deprecated` flags and
   `@see` doc links.
2. **L2 usage** (`src/callsites.ts`) — every `new CfnXxx(...)` call site is
   found by resolving the constructor symbol back to its generated class
   (any logical ID, aliased imports included). The property-set evaluator
   (`src/prop-eval.ts`) computes which keys each call site can produce,
   following helper functions, `.map()` / `.flatMap()` / Box `.derive()`
   callbacks, `Lazy.any()` producers, ternaries, spreads, local variable
   mutation flows (reassignment / member assignment / `push`), class
   properties assigned anywhere in the class, `Box.fromValue()` / `.set()`,
   and subclass `super(...)` arguments. Post-construction escape hatches
   (`cfn.prop = ...`, `addPropertyOverride('A.B', ...)`) are also counted.
3. **Compare** (`src/compare.ts`) — L1 paths absent from the union of
   everything the L2 can set are reported in dot notation.

### Confidence

Every finding carries a `confidence`:

- `high` — the surrounding values were fully analyzed (literals, resolved
  function bodies) or typed with exact interfaces; the property is genuinely
  not settable through the L2.
- `low` — the analysis lost track of a value on the path (dynamic code,
  unresolvable calls). The property is *probably* missing but needs a human
  look.

When a value can only be typed (e.g. a user-implementable `bind()` contract
returning a generated Property interface), all keys of the declared type count
as settable, since callers control the value.

### Exclusions

`exclusions.json` records properties that are intentionally not set via the
constructor but are still configurable, with the reason:

```json
{
  "exclusions": [
    { "propPattern": "(^|\\.)tags$|Tags$", "reason": "Configured via Tags.of() / TagManager" },
    { "construct": "aws-s3/CfnBucket", "prop": "notificationConfiguration",
      "reason": "Supported via bucket.addEventNotification()" }
  ]
}
```

Excluded findings appear under `excludedProps` with their reason instead of
`missingProps`.

## Output format

Legacy fields are unchanged; new fields are additive:

```json
{
  "module": "aws-s3",
  "name": "CfnBucket",
  "missingProps": ["metadataConfiguration"],
  "missingPropsDetailed": [
    { "path": "metadataConfiguration", "confidence": "high", "docLink": "http://docs.aws.amazon.com/..." }
  ],
  "excludedProps": [
    { "prop": "tags", "reason": "Configured via Tags.of() / TagManager" }
  ]
}
```

## Known limitations

- Values produced by genuinely dynamic code (computed keys, data driven by
  runtime state) cannot be analyzed; their subtrees are reported with
  `confidence: "low"`.
- A property set by an L2 with a hardcoded value (not user-configurable)
  still counts as "supported" — the tool measures what reaches
  CloudFormation, not configurability.
- Properties applied through separate resources or custom resources
  (e.g. S3 bucket notifications) need an entry in `exclusions.json`.
- `super(...)` argument resolution only sees subclasses inside the analyzed
  modules.

## Development

```bash
npx projen test                      # unit tests (in-memory fixtures)
CDK_REPO_PATH=~/git/aws-cdk npx projen test   # + golden tests against a real checkout
npx projen build                     # compile + lint + test
```
