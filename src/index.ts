import * as fs from 'fs';
import * as path from 'path';
import * as ts from '@typescript-eslint/typescript-estree';
import { glob } from 'glob';

interface CfnPropsDetails {
  module: string;
  name: string;
  props: string[];
}

interface DirectoryConfig {
  alphaDir: string;
  cdkLibDir: string;
}

// L1定義（generated.ts）ファイルを検索する関数
const findGeneratedTypeScriptFiles = async (config: DirectoryConfig, moduleType: string): Promise<string[]> => {
  if (moduleType === 'alpha') {
    // alphaモジュールの場合、対応するaws-cdk-libのgenerated.tsを探す
    const alphaModuleName = path.basename(config.alphaDir).replace('-alpha', '');
    return glob(`${config.cdkLibDir}/${alphaModuleName}/**/*.generated.ts`);
  }
  return glob(`${config.cdkLibDir}/**/*.generated.ts`);
};

// L2実装ファイルを検索する関数
const findManualTypeScriptFiles = async (config: DirectoryConfig, moduleType: string): Promise<string[]> => {
  const searchDir = moduleType === 'alpha' ? config.alphaDir : config.cdkLibDir;
  return glob(`${searchDir}/**/*.ts`, {
    ignore: `${searchDir}/**/*.generated.ts`,
  });
};

// モジュール名を抽出する関数を改善
const extractModuleName = (filePath: string, config: DirectoryConfig): string => {
  const parts = filePath.split(path.sep);

  // alphaモジュールの場合
  if (filePath.includes(config.alphaDir)) {
    const moduleName = path.basename(config.alphaDir).replace('-alpha', '');
    return moduleName.replace('aws-', '');
  }

  // aws-cdk-libの場合
  const libIndex = parts.indexOf('lib');
  if (libIndex > 0) {
    return parts[libIndex - 1].replace('aws-', '');
  }

  // aws-cdk-lib直下のモジュールの場合
  const moduleNameIndex = parts.findIndex(part => part.startsWith('aws-'));
  if (moduleNameIndex >= 0) {
    return parts[moduleNameIndex].replace('aws-', '');
  }

  throw new Error(`Could not extract module name from path: ${filePath}`);
};

// L1プロパティを抽出する関数は変更なし
const extractCfnProperties = async (filePath: string, config: DirectoryConfig): Promise<CfnPropsDetails[]> => {
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
          return null;
        }).filter(propName => propName !== null);

        const moduleName = extractModuleName(filePath, config);
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

// L2コンストラクタのプロパティ抽出関数も同様に設定を受け取るように修正
const extractCfnConstructorProperties = async (filePath: string, config: DirectoryConfig): Promise<CfnPropsDetails[]> => {
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
        if (node.arguments.length > 1 && node.arguments[1].type === 'Literal' && node.arguments[1].value === 'Resource') {
          const moduleName = extractModuleName(filePath, config);
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

// 比較関数は変更なし
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
  const alphaDir = process.argv[2];
  const cdkLibDir = process.argv[3];

  if (!alphaDir || !cdkLibDir) {
    console.error('Please provide both alpha module directory and aws-cdk-lib directory paths');
    console.error('Usage: ts-node script.ts <alpha-module-dir> <aws-cdk-lib-dir>');
    process.exit(1);
  }

  const config: DirectoryConfig = {
    alphaDir,
    cdkLibDir,
  };

  const l1Properties: CfnPropsDetails[] = [];
  const l2Properties: CfnPropsDetails[] = [];

  try {
    // alphaモジュールのL1定義を取得
    const l1Files = await findGeneratedTypeScriptFiles(config, 'alpha');
    for (const file of l1Files) {
      const propDetails = await extractCfnProperties(file, config);
      if (propDetails) {
        l1Properties.push(...propDetails);
      }
    }

    // alphaモジュールのL2実装を取得
    const l2Files = await findManualTypeScriptFiles(config, 'alpha');
    for (const file of l2Files) {
      const cfnDetails = await extractCfnConstructorProperties(file, config);
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

    const outputPath = path.join(process.cwd(), 'missingProperties.json');
    fs.writeFileSync(outputPath, JSON.stringify(missingProperties, null, 2), 'utf8');
    console.log(`Results written to ${outputPath}`);
  } catch (error) {
    console.error('Error:', error);
  }
};

void main();