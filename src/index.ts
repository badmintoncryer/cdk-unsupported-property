// dependencies
import * as fs from 'fs';
import * as path from 'path';
import * as ts from '@typescript-eslint/typescript-estree';
import { glob } from 'glob';

// 非同期でパターンにマッチするすべてのファイルを検索する関数
const findTypeScriptFiles = async (srcDir: string): Promise<string[]> => {
  return glob(`${srcDir}/**/*.generated.ts`);
};

// TypeScriptファイルを解析し、CfnXxxPropsのプロパティを抽出する関数
const extractCfnProperties = async (filePath: string): Promise<string[]> => {
  const code = fs.readFileSync(filePath, 'utf8');
  const ast = ts.parse(code, {
    loc: true,
    tokens: true,
    comment: true,
    jsx: false,
    useJSXTextNode: false,
  });

  const properties: string[] = [];

  ts.simpleTraverse(ast, {
    enter(node) {
      if (
        node.type === 'TSInterfaceDeclaration' &&
        node.id.name.endsWith('Props')
      ) {
        node.body.body.forEach((prop: any) => {
          if (prop.type === 'TSPropertySignature') {
            properties.push(prop.key.name);
          }
        });
      }
    },
  });

  return properties;
};

const main = async () => {
  const directoryPath = process.argv[2]; // コマンドライン引数からディレクトリパスを取得
  if (!directoryPath) {
    console.error('Please provide the directory path');
    process.exit(1);
  }

  try {
    const files = await findTypeScriptFiles(directoryPath);
    for (const file of files) {
      const properties = await extractCfnProperties(file);
      console.log(`Properties in ${path.basename(file)}:`, properties);
    }
  } catch (error) {
    console.error('Error:', error);
  }
};

void main();
