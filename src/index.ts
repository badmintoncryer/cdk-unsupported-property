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
  moduleName: string;
  modulePath: string;
}

interface ModuleAnalysisResult {
  moduleName: string;
  missingProperties: any[];
  errors?: string[];
}

// alphaモジュールを検索する関数
const findAlphaModules = async (baseDir: string): Promise<string[]> => {
  const pattern = path.join(baseDir, 'aws-*-alpha');
  const alphaModules = await glob(pattern);
  console.log(`Found alpha modules: ${alphaModules.length}`);
  return alphaModules;
};

// L1定義（generated.ts）ファイルを検索する関数
const findGeneratedTypeScriptFiles = async (config: DirectoryConfig): Promise<string[]> => {
  // alphaモジュール名から対応するCDK Libモジュール名を取得
  const moduleName = config.moduleName
    .replace('-alpha', '')
    .replace('aws-', '');

  // aws-cdk-lib内の対応するパスを構築
  const cdkLibModulePath = path.join(config.cdkLibDir, 'aws-' + moduleName);
  console.log(`Looking for generated files in: ${cdkLibModulePath}`);

  // generated.tsファイルを検索
  const pattern = path.join(cdkLibModulePath, '**', '*.generated.ts');
  const files = await glob(pattern);
  console.log(`Found ${files.length} generated files for ${moduleName}`);
  return files;
};

// L2実装ファイルを検索する関数
const findManualTypeScriptFiles = async (config: DirectoryConfig): Promise<string[]> => {
  console.log(`Looking for L2 files in: ${config.modulePath}`);
  const pattern = path.join(config.modulePath, '**', '*.ts');
  const ignorePatterns = [
    path.join(config.modulePath, '**', '*.generated.ts'),
    path.join(config.modulePath, '**', '*.d.ts'),
    path.join(config.modulePath, '**/test/**'),
    path.join(config.modulePath, '**/__tests__/**'),
    path.join(config.modulePath, '**/node_modules/**'),
  ];

  const files = await glob(pattern, { ignore: ignorePatterns });
  console.log(`Found ${files.length} L2 implementation files`);
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
              node.arguments[2].properties.forEach((prop: any) => {
                if (prop.type === 'Property' && prop.key.type === 'Identifier') {
                  properties.push(prop.key.name);
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
const analyzeModule = async (config: DirectoryConfig): Promise<ModuleAnalysisResult> => {
  console.log(`\nAnalyzing module: ${config.moduleName}`);

  const l1Properties: CfnPropsDetails[] = [];
  const l2Properties: CfnPropsDetails[] = [];

  // L1定義の解析
  const l1Files = await findGeneratedTypeScriptFiles(config);
  console.log(`Processing ${l1Files.length} L1 definition files`);

  for (const file of l1Files) {
    const propDetails = await extractCfnProperties(file);
    if (propDetails.length > 0) {
      console.log(`Found ${propDetails.length} L1 property definitions in ${path.basename(file)}`);
      l1Properties.push(...propDetails);
    }
  }

  // L2実装の解析
  const l2Files = await findManualTypeScriptFiles(config);
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
    moduleName: config.moduleName,
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

const main = async () => {
  const awsCdkDir = process.argv[2];
  const cdkLibDir = process.argv[3];

  if (!awsCdkDir || !cdkLibDir) {
    console.error('Please provide both @aws-cdk and aws-cdk-lib directory paths');
    console.error('Usage: ts-node script.ts <@aws-cdk-dir> <aws-cdk-lib-dir>');
    process.exit(1);
  }

  // ディレクトリの存在確認
  if (!fs.existsSync(awsCdkDir) || !fs.existsSync(cdkLibDir)) {
    console.error('One or both of the specified directories do not exist:');
    console.error(`@aws-cdk dir: ${awsCdkDir} (exists: ${fs.existsSync(awsCdkDir)})`);
    console.error(`aws-cdk-lib dir: ${cdkLibDir} (exists: ${fs.existsSync(cdkLibDir)})`);
    process.exit(1);
  }

  try {
    console.log('Starting analysis...');
    console.log(`@aws-cdk directory: ${awsCdkDir}`);
    console.log(`aws-cdk-lib directory: ${cdkLibDir}`);

    // alphaモジュールの一覧を取得
    const alphaModulePaths = await findAlphaModules(awsCdkDir);
    console.log(`\nFound ${alphaModulePaths.length} alpha modules to analyze`);

    // 各モジュールを解析
    const results: ModuleAnalysisResult[] = [];
    for (const modulePath of alphaModulePaths) {
      try {
        const moduleConfig: DirectoryConfig = {
          awsCdkDir,
          cdkLibDir,
          moduleName: path.basename(modulePath),
          modulePath: modulePath,
        };
        const result = await analyzeModule(moduleConfig);
        results.push(result);
      } catch (error) {
        console.error(`Error analyzing ${modulePath}:`, error);
      }
    }

    // 結果を整形して出力
    const outputResult = results.reduce((acc, result) => {
      acc[result.moduleName] = result.missingProperties;
      return acc;
    }, {} as Record<string, any>);

    const outputPath = path.join(process.cwd(), 'missingProperties.json');
    fs.writeFileSync(outputPath, JSON.stringify(outputResult, null, 2), 'utf8');
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