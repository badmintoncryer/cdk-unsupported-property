# CDK UNSUPPORTED PROPERTY

Creating a list of CloudFormation arguments that are not supported in the L2 construct.

## Usage

1. Prepare the AWS CDK repository

```bash
git clone https://github.com/aws/aws-cdk.git
cd aws-cdk
yarn
yarn build
cd ../
```

2. prepare ts-node

```bash
npm install -g ts-node
```

3. Execute cdk-unsupported-property

```bash
git clone https://github.com/badmintoncryer/cdk-unsupported-property.git
cd cdk-unsupported-property
npm install
ts-node src/index.ts ../aws-cdk/packages/aws-cdk-lib
// create `missingProperties.json`
```
