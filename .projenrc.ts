import { typescript } from 'projen';
const project = new typescript.TypeScriptProject({
  defaultReleaseBranch: 'main',
  name: 'cdk-unsupported-property',
  projenrcTs: true,
  codeCov: true,
  releaseWorkflow: false,

  deps: ['glob', 'typescript'], /* Runtime dependencies of this module. */
  // description: undefined,  /* The description is just a string that helps people understand the purpose of the package. */
  devDeps: ['@types/glob'], /* Build dependencies for this module. */
  // packageName: undefined,  /* The "name" in package.json. */

  tsconfig: {
    compilerOptions: {
      skipLibCheck: true,
    },
  },
});

// The TypeScript compiler API requires bitwise flag checks (ts.TypeFlags etc.)
project.eslint?.addRules({ 'no-bitwise': 'off' });

// Fix strip-ansi ESM/CommonJS compatibility issue
project.package.addField('resolutions', {
  'strip-ansi': '^6.0.1',
  'string-width': '^4.2.3',
});

project.synth();