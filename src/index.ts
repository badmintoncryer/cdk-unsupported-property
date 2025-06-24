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
  awsCdkDir: string;
  cdkLibDir: string;
}

interface ModuleAnalysisResult {
  moduleName: string;
  missingProperties: any[];
  errors?: string[];
}

// すべてのモジュールを検索する関数
const findAllModules = async (config: DirectoryConfig): Promise<{
  alphaModules: string[];
  cdkLibModules: string[];
}> => {
  // alphaモジュールを検索
  const alphaPattern = path.join(config.awsCdkDir, 'aws-*-alpha');
  const alphaModules = await glob(alphaPattern);

  // aws-cdk-libモジュールを検索
  const cdkLibPattern = path.join(config.cdkLibDir, 'aws-*');
  const cdkLibModules = await glob(cdkLibPattern);

  console.log(`Found ${alphaModules.length} alpha modules and ${cdkLibModules.length} CDK lib modules`);

  return {
    alphaModules,
    cdkLibModules,
  };
};

// generated.tsファイルを検索する関数
const findGeneratedTypeScriptFiles = async (modulePath: string): Promise<string[]> => {
  console.log(`Looking for generated files in: ${modulePath}`);
  const pattern = path.join(modulePath, '**', '*.generated.ts');
  const files = await glob(pattern);
  console.log(`Found ${files.length} generated files`);
  return files;
};

// 実装ファイルを検索する関数
const findImplementationFiles = async (modulePath: string): Promise<string[]> => {
  console.log(`Looking for implementation files in: ${modulePath}`);
  const pattern = path.join(modulePath, '**', '*.ts');
  const ignorePatterns = [
    path.join(modulePath, '**', '*.generated.ts'),
    path.join(modulePath, '**', '*.d.ts'),
    path.join(modulePath, '**/test/**'),
    path.join(modulePath, '**/__tests__/**'),
    path.join(modulePath, '**/node_modules/**'),
  ];

  const files = await glob(pattern, { ignore: ignorePatterns });
  console.log(`Found ${files.length} implementation files`);
  return files;
};

// モジュール名を抽出する関数
const extractModuleName = (filePath: string): string => {
  const parts = filePath.split(path.sep);
  const awsModuleIndex = parts.findIndex(part => part.startsWith('aws-'));
  if (awsModuleIndex !== -1) {
    return parts[awsModuleIndex]
      .replace('-alpha', '')
      .replace('aws-', '');
  }
  throw new Error(`Could not extract module name from path: ${filePath}`);
};

// L1プロパティを抽出する関数
const extractCfnProperties = async (filePath: string): Promise<CfnPropsDetails[]> => {
  try {
    const code = fs.readFileSync(filePath, 'utf8');
    const ast = ts.parse(code, {
      loc: true,
      tokens: true,
      comment: true,
      jsx: false,
      useJSXTextNode: false,
    });

    let results: CfnPropsDetails[] = [];
    const moduleName = extractModuleName(filePath);

    ts.simpleTraverse(ast, {
      enter(node) {
        if (node.type === 'TSInterfaceDeclaration' && node.id.name.endsWith('Props')) {
          const properties = node.body.body
            .filter((prop: any) => prop.type === 'TSPropertySignature' && prop.key.type === 'Identifier')
            .map((prop: any) => prop.key.name);

          if (properties.length > 0) {
            results.push({
              module: moduleName,
              name: node.id.name.replace('Props', ''),
              props: properties,
            });
          }
        }
      },
    });

    return results;
  } catch (error) {
    console.error(`Error extracting properties from ${filePath}:`, error);
    return [];
  }
};

// L2コンストラクタのプロパティ抽出関数
const extractCfnConstructorProperties = async (filePath: string): Promise<CfnPropsDetails[]> => {
  try {
    const code = fs.readFileSync(filePath, 'utf8');
    const ast = ts.parse(code, {
      loc: true,
      tokens: true,
      comment: true,
      jsx: false,
      useJSXTextNode: false,
    });

    const results: CfnPropsDetails[] = [];
    const moduleName = extractModuleName(filePath);

    ts.simpleTraverse(ast, {
      enter(node) {
        if (node.type === 'NewExpression' &&
            node.callee.type === 'Identifier' &&
            node.callee.name.startsWith('Cfn')) {

          if (node.arguments.length > 1 &&
              node.arguments[1].type === 'Literal' &&
              node.arguments[1].value === 'Resource') {

            const properties: string[] = [];
            if (node.arguments.length > 2 && node.arguments[2].type === 'ObjectExpression') {
              // 直接指定されたプロパティを処理
              node.arguments[2].properties.forEach((prop: any) => {
                if (prop.type === 'Property' && prop.key.type === 'Identifier') {
                  properties.push(prop.key.name);
                } /* eslint-disable-next-line brace-style */
                else if (prop.type === 'SpreadElement' && prop.argument.type === 'Identifier') {
                  // スプレッド演算子で使用されている変数名を取得
                  const spreadVarName = prop.argument.name;
                  
                  // このスコープ内でスプレッド変数の宣言を探す
                  // 単純に同じファイル内の変数宣言を探す方法
                  ts.simpleTraverse(ast, {
                    enter(scopeNode) {
                      // 変数宣言を探す
                      if (scopeNode.type === 'VariableDeclarator' && 
                          scopeNode.id.type === 'Identifier' && 
                          scopeNode.id.name === spreadVarName &&
                          scopeNode.init && 
                          scopeNode.init.type === 'ObjectExpression') {
                        
                        // 変数の中身（オブジェクトのプロパティ）を取得
                        scopeNode.init.properties.forEach((spreadProp: any) => {
                          if (spreadProp.type === 'Property' && 
                              spreadProp.key.type === 'Identifier') {
                            properties.push(spreadProp.key.name);
                          }
                        });
                      }
                    }
                  });
                }
              });
            }

            if (properties.length > 0) {
              results.push({
                module: moduleName,
                name: node.callee.name,
                props: properties,
              });
            }
          }
        }
      },
    });

    return results;
  } catch (error) {
    console.error(`Error extracting constructor properties from ${filePath}:`, error);
    return [];
  }
};

// 単一モジュールの解析を行う関数
const analyzeModule = async (modulePath: string, l1Path: string): Promise<ModuleAnalysisResult> => {
  console.log(`\nAnalyzing module: ${path.basename(modulePath)}`);

  const l1Properties: CfnPropsDetails[] = [];
  const l2Properties: CfnPropsDetails[] = [];

  // L1定義の解析
  const l1Files = await findGeneratedTypeScriptFiles(l1Path);
  console.log(`Processing ${l1Files.length} L1 definition files`);

  for (const file of l1Files) {
    const propDetails = await extractCfnProperties(file);
    if (propDetails.length > 0) {
      console.log(`Found ${propDetails.length} L1 property definitions in ${path.basename(file)}`);
      l1Properties.push(...propDetails);
    }
  }

  // L2実装の解析
  const l2Files = await findImplementationFiles(modulePath);
  console.log(`Processing ${l2Files.length} L2 implementation files`);

  for (const file of l2Files) {
    const cfnDetails = await extractCfnConstructorProperties(file);
    if (cfnDetails.length > 0) {
      console.log(`Found ${cfnDetails.length} L2 constructor implementations in ${path.basename(file)}`);
      l2Properties.push(...cfnDetails);
    }
  }

  // 比較
  const missingProperties = compareProps(l1Properties, l2Properties)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    moduleName: path.basename(modulePath),
    missingProperties,
  };
};

// プロパティ比較関数
const compareProps = (l1: CfnPropsDetails[], l2: CfnPropsDetails[]) => {
  const results: any[] = [];

  l1.forEach(l1Item => {
    const l2Item = l2.find(item =>
      item.module === l1Item.module &&
      item.name.replace('Cfn', '') === l1Item.name.replace('Cfn', ''),
    );

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

// alphaモジュールのL1パスを解決する関数
const resolveL1PathForAlpha = (config: DirectoryConfig, alphaModulePath: string): string => {
  const moduleName = path.basename(alphaModulePath)
    .replace('-alpha', '')
    .replace('aws-', '');
  return path.join(config.cdkLibDir, 'aws-' + moduleName);
};

const main = async () => {
  const packagesDir = process.argv[2];

  if (!packagesDir) {
    console.error('Please provide the packages directory path');
    console.error('Usage: ts-node script.ts <packages-dir>');
    process.exit(1);
  }

  // 必要なディレクトリパスを構築
  const awsCdkDir = path.join(packagesDir, '@aws-cdk');
  const cdkLibDir = path.join(packagesDir, 'aws-cdk-lib');

  // ディレクトリの存在確認
  if (!fs.existsSync(awsCdkDir) || !fs.existsSync(cdkLibDir)) {
    console.error('Required directories do not exist:');
    console.error(`@aws-cdk dir: ${awsCdkDir} (exists: ${fs.existsSync(awsCdkDir)})`);
    console.error(`aws-cdk-lib dir: ${cdkLibDir} (exists: ${fs.existsSync(cdkLibDir)})`);
    process.exit(1);
  }

  const config: DirectoryConfig = {
    awsCdkDir,
    cdkLibDir,
  };

  try {
    console.log('Starting analysis...');
    console.log(`@aws-cdk directory: ${awsCdkDir}`);
    console.log(`aws-cdk-lib directory: ${cdkLibDir}`);

    // すべてのモジュールを検索
    const { alphaModules, cdkLibModules } = await findAllModules(config);

    // 各モジュールを解析
    const results: ModuleAnalysisResult[] = [];

    // alphaモジュールの解析
    for (const modulePath of alphaModules) {
      try {
        const l1Path = resolveL1PathForAlpha(config, modulePath);
        const result = await analyzeModule(modulePath, l1Path);
        results.push(result);
      } catch (error) {
        console.error(`Error analyzing alpha module ${modulePath}:`, error);
      }
    }

    // CDK Libモジュールの解析
    for (const modulePath of cdkLibModules) {
      try {
        const result = await analyzeModule(modulePath, modulePath);
        results.push(result);
      } catch (error) {
        console.error(`Error analyzing CDK lib module ${modulePath}:`, error);
      }
    }

    // 結果を従来形式に整形
    const flattenedResults = results.flatMap(result =>
      result.missingProperties.map(prop => ({
        module: result.moduleName,
        name: prop.name,
        missingProps: prop.missingProps,
      })),
    );

    const outputPath = path.join(process.cwd(), 'missingProperties.json');
    fs.writeFileSync(outputPath, JSON.stringify(flattenedResults, null, 2), 'utf8');
    console.log(`\nResults written to ${outputPath}`);

    // サマリーの出力
    console.log('\nAnalysis Summary:');
    results.forEach(result => {
      const missingCount = result.missingProperties.length;
      console.log(`${result.moduleName}: ${missingCount} constructs with missing properties`);
    });
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
};

void main();