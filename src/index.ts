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


const extractModuleName = (filePath: string): string => {
  const parts = filePath.split(path.sep);
  const libIndex = parts.indexOf('lib');
  return parts[libIndex - 1];
};

// TypeScriptファイルを解析し、CfnXxxPropsのプロパティを抽出する関数
const extractCfnProperties = async (filePath: string): Promise<CfnPropsDetails | null> => {
  const code = fs.readFileSync(filePath, 'utf8');
  const ast = ts.parse(code, {
    loc: true,
    tokens: true,
    comment: true,
    jsx: false,
    useJSXTextNode: false,
  });

  let result: CfnPropsDetails | null = null;

  ts.simpleTraverse(ast, {
    enter(node) {
      if (node.type === 'TSInterfaceDeclaration' && node.id.name.endsWith('Props')) {
        const properties = node.body.body.map((prop: any) => prop.key.name);
        const moduleName = extractModuleName(filePath);
        result = {
          module: moduleName,
          name: node.id.name,
          props: properties,
        };
      }
    },
  });

  return result;
};

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

const main = async () => {
  const directoryPath = process.argv[2]; // コマンドライン引数からディレクトリパスを取得
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
        l1Properties.push(propDetails);
      }
    }

    const l2Files = await findManualTypeScriptFiles(directoryPath);
    for (const file of l2Files) {
      const cfnDetails = await extractCfnConstructorProperties(file);
      l2Properties.push(...cfnDetails);
    }
    // JSONで結果を表示または保存
    console.log(JSON.stringify(l2Properties, null, 2));
    // console.log(JSON.stringify(l1Properties, null, 2));
  } catch (error) {
    console.error('Error:', error);
  }
};

void main();
