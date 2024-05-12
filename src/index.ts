// dependencies
import * as fs from 'fs';
import * as path from 'path';
import * as ts from '@typescript-eslint/typescript-estree';
import { glob } from 'glob';

interface CfnPropsDetails {
  module: string;
  name: string;
  props: string[];
}

// 自動生成されたTypeScriptファイルを検索する関数
const findGeneratedTypeScriptFiles = async (srcDir: string): Promise<string[]> => {
  return glob(`${srcDir}/**/*.generated.ts`);
};

// 手動作成されたTypeScriptファイルを検索する関数
const findManualTypeScriptFiles = async (srcDir: string): Promise<string[]> => {
  return glob(`${srcDir}/**/*.ts`, {
    ignore: `${srcDir}/**/*.generated.ts`,
  });
};

// aws-cdk-lib/aws-route53/lib/record-set.ts という文字列を前提に、aws-route53を返す関数
const extractModuleName = (filePath: string): string => {
  const parts = filePath.split(path.sep);
  const libIndex = parts.indexOf('lib');
  return parts[libIndex - 1];
};

// CfnXxxPropsのプロパティを抽出する関数
const extractCfnProperties = async (filePath: string): Promise<CfnPropsDetails[]> => {
  const code = fs.readFileSync(filePath, 'utf8');
  const ast = ts.parse(code, {
    loc: true,
    tokens: true,
    comment: true,
    jsx: false,
    useJSXTextNode: false,
  });

  let results: CfnPropsDetails[] = [];

  ts.simpleTraverse(ast, {
    enter(node) {
      if (node.type === 'TSInterfaceDeclaration' && node.id.name.endsWith('Props')) {
        const properties = node.body.body.map((prop: any) => {
          if (prop.type === 'TSPropertySignature' && prop.key.type === 'Identifier') {
            return prop.key.name;
          }
          return null; // 非識別子プロパティは無視
        }).filter(propName => propName !== null); // nullを除去

        const moduleName = extractModuleName(filePath);
        results.push({
          module: moduleName,
          name: node.id.name.replace('Props', ''),
          props: properties,
        });
      }
    },
  });

  return results;
};

// L2コンストラクにおけるL1コンストラクタへの引数を抽出する関数
const extractCfnConstructorProperties = async (filePath: string): Promise<CfnPropsDetails[]> => {
  const code = fs.readFileSync(filePath, 'utf8');
  const ast = ts.parse(code, {
    loc: true,
    tokens: true,
    comment: true,
    jsx: false,
    useJSXTextNode: false,
  });

  const results: CfnPropsDetails[] = [];

  ts.simpleTraverse(ast, {
    enter(node) {
      if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && node.callee.name.startsWith('Cfn')) {
        // Check if the second argument is a literal with value 'Resource'
        if (node.arguments.length > 1 && node.arguments[1].type === 'Literal' && node.arguments[1].value === 'Resource') {
          const moduleName = extractModuleName(filePath);
          const properties: string[] = [];
          if (node.arguments.length > 2 && node.arguments[2].type === 'ObjectExpression') {
            node.arguments[2].properties.forEach((prop: any) => {
              if (prop.type === 'Property') {
                properties.push(prop.key.name);
              }
            });
          }
          results.push({
            module: moduleName,
            name: node.callee.name,
            props: properties,
          });
        }
      }
    },
  });

  return results;
};

const compareProps = (l1: CfnPropsDetails[], l2: CfnPropsDetails[]) => {
  const results: any[] = [];

  l1.forEach(l1Item => {
    const l2Item = l2.find(item => item.module === l1Item.module && item.name.replace('Cfn', '') === l1Item.name.replace('Cfn', ''));
    if (l2Item) {
      const missingProps = l1Item.props.filter(prop => !l2Item.props.includes(prop));
      if (missingProps.length > 0) {
        results.push({
          module: l1Item.module,
          name: l1Item.name,
          missingProps: missingProps,
        });
      }
    }
  });

  return results;
};

const main = async () => {
  const directoryPath = process.argv[2];
  if (!directoryPath) {
    console.error('Please provide the directory path');
    process.exit(1);
  }
  const l1Properties: CfnPropsDetails[] = [];
  const l2Properties: CfnPropsDetails[] = [];

  try {
    const l1Files = await findGeneratedTypeScriptFiles(directoryPath);
    for (const file of l1Files) {
      const propDetails = await extractCfnProperties(file);
      if (propDetails) {
        l1Properties.push(...propDetails);
      }
    }

    const l2Files = await findManualTypeScriptFiles(directoryPath);
    for (const file of l2Files) {
      const cfnDetails = await extractCfnConstructorProperties(file);
      l2Properties.push(...cfnDetails);
    }

    const missingProperties = compareProps(l1Properties, l2Properties)
      .sort((a, b) => {
        const moduleCompare = a.module.localeCompare(b.module);
        if (moduleCompare !== 0) {
          return moduleCompare;
        }
        return a.name.localeCompare(b.name);
      });
    fs.writeFileSync('missingProperties.json', JSON.stringify(missingProperties, null, 2), 'utf8');
  } catch (error) {
    console.error('Error:', error);
  }
};

void main();
