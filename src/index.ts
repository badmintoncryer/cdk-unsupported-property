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

// 非同期でパターンにマッチするすべてのファイルを検索する関数
const findTypeScriptFiles = async (srcDir: string): Promise<string[]> => {
  return glob(`${srcDir}/**/*.generated.ts`);
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

const main = async () => {
  const directoryPath = process.argv[2]; // コマンドライン引数からディレクトリパスを取得
  if (!directoryPath) {
    console.error('Please provide the directory path');
    process.exit(1);
  }
  const allPropsDetails: CfnPropsDetails[] = [];

  try {
    const files = await findTypeScriptFiles(directoryPath);
    for (const file of files) {
      const propDetails = await extractCfnProperties(file);
      if (propDetails) {
        allPropsDetails.push(propDetails);
      }
    }
    console.log(JSON.stringify(allPropsDetails, null, 2));
  } catch (error) {
    console.error('Error:', error);
  }
};

void main();
