import * as fs from 'fs';
import * as path from 'path';
import * as ts from '@typescript-eslint/typescript-estree';
import { glob } from 'glob';

interface PropertyInfo {
  name: string;
  nestedProps?: { [key: string]: PropertyInfo };
}

interface CfnPropsDetails {
  module: string;
  name: string;
  props: string[]; // トップレベルのプロパティ名リスト
  detailedProps?: { [key: string]: PropertyInfo }; // ネストされたプロパティの詳細情報
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

// 型定義を収集する補助関数
const collectTypeDefinitions = (ast: any): Map<string, any> => {
  const typeMap = new Map<string, any>();

  ts.simpleTraverse(ast, {
    enter(node) {
      // インターフェース定義
      if (node.type === 'TSInterfaceDeclaration' && node.id?.name) {
        typeMap.set(node.id.name, node);
      }
      // 型エイリアス定義
      else if (node.type === 'TSTypeAliasDeclaration' && node.id?.name) {
        typeMap.set(node.id.name, node);
      }
    },
  });

  return typeMap;
};

// 型名を抽出する補助関数（IdentifierとTSQualifiedNameに対応）
const extractTypeName = (typeName: any): string | undefined => {
  if (!typeName) return undefined;

  // 単純な識別子の場合（例: CustomRuleProperty）
  if (typeName.type === 'Identifier') {
    return typeName.name;
  }

  // 修飾名の場合（例: CfnApp.CustomRuleProperty）
  // TSQualifiedName { left: { type: 'Identifier', name: 'CfnApp' }, right: { type: 'Identifier', name: 'CustomRuleProperty' } }
  if (typeName.type === 'TSQualifiedName' && typeName.right?.type === 'Identifier') {
    return typeName.right.name; // 右側の名前を返す（CustomRuleProperty）
  }

  return undefined;
};

// Union型から有効な型を抽出する補助関数（undefined, null, IResolvableを除外）
const filterValidTypesFromUnion = (unionTypes: any[]): any[] => {
  return unionTypes.filter((t: any) => {
    // undefined, null を除外
    if (t.type === 'TSUndefinedKeyword' || t.type === 'TSNullKeyword') {
      return false;
    }
    // IResolvable を除外
    if (t.type === 'TSTypeReference' && t.typeName) {
      const typeName = extractTypeName(t.typeName);
      if (typeName === 'IResolvable') {
        return false;
      }
    }
    return true;
  });
};

// プロパティの型からネストされたプロパティを抽出する補助関数
const extractNestedPropsFromType = (
  typeAnnotation: any,
  typeMap: Map<string, any>,
  depth: number = 0,
  parentProp?: string,
  visited: Set<string> = new Set(),
): { [key: string]: PropertyInfo } | undefined => {
  const MAX_DEPTH = 3; // 最大ネスト深度
  if (depth >= MAX_DEPTH || !typeAnnotation) {
    return undefined;
  }

  // オプショナル型の場合、内部の型を取得
  let targetType = typeAnnotation;
  if (typeAnnotation.type === 'TSOptionalType') {
    targetType = typeAnnotation.typeAnnotation;
  }

  // Union型の場合、undefined/null/IResolvableを除外して最初の型を使用
  if (targetType.type === 'TSUnionType') {
    const validTypes = filterValidTypesFromUnion(targetType.types);
    if (validTypes.length > 0) {
      targetType = validTypes[0];
    }
  }

  // TypeReference（型参照）の場合、参照先の型定義を探す
  if (targetType.type === 'TSTypeReference' && targetType.typeName) {
    const typeName = extractTypeName(targetType.typeName);

    if (!typeName) {
      return undefined;
    }

    // ジェネリック型の型引数をチェック（Array<T>, Record<K,V> など）
    if (targetType.typeParameters?.params && targetType.typeParameters.params.length > 0) {
      // Array<T> の場合、最初の型引数を処理
      if (typeName === 'Array' && targetType.typeParameters.params[0]) {
        let elementType = targetType.typeParameters.params[0];

        // 型引数がUnion型の場合（Array<CustomRuleProperty | IResolvable>）、IResolvableなどを除外
        if (elementType.type === 'TSUnionType') {
          const validTypes = filterValidTypesFromUnion(elementType.types);
          if (validTypes.length > 0) {
            elementType = validTypes[0];
          }
        }

        if (elementType.type === 'TSTypeReference' && elementType.typeName) {
          const elementTypeName = extractTypeName(elementType.typeName);
          if (elementTypeName) {
            // 配列の要素型を再帰的に処理
            return extractNestedPropsFromType(elementType, typeMap, depth, parentProp, visited);
          }
        }
      }

      // Record<K, V> の場合、値の型（2番目の型引数）を処理
      if (typeName === 'Record' && targetType.typeParameters.params.length >= 2) {
        let valueType = targetType.typeParameters.params[1];

        // 型引数がUnion型の場合、IResolvableなどを除外
        if (valueType.type === 'TSUnionType') {
          const validTypes = filterValidTypesFromUnion(valueType.types);
          if (validTypes.length > 0) {
            valueType = validTypes[0];
          }
        }

        if (valueType.type === 'TSTypeReference' && valueType.typeName) {
          const valueTypeName = extractTypeName(valueType.typeName);
          if (valueTypeName) {
            // レコードの値型を再帰的に処理
            return extractNestedPropsFromType(valueType, typeMap, depth, parentProp, visited);
          }
        }
      }

      // その他のジェネリック型はスキップ
      return undefined;
    }

    // 循環参照の検出
    if (visited.has(typeName)) {
      return undefined;
    }

    // 型定義マップから参照先を探す
    const typeDefinition = typeMap.get(typeName);
    if (typeDefinition) {
      // 循環参照防止のためvisitedセットに追加
      const newVisited = new Set(visited);
      newVisited.add(typeName);

      // インターフェース定義の場合
      if (typeDefinition.type === 'TSInterfaceDeclaration') {
        return extractPropsFromInterfaceBody(typeDefinition.body, typeMap, depth, newVisited);
      }
      // 型エイリアスの場合
      else if (typeDefinition.type === 'TSTypeAliasDeclaration' && typeDefinition.typeAnnotation) {
        return extractNestedPropsFromType(typeDefinition.typeAnnotation, typeMap, depth, undefined, newVisited);
      }
    }
  }

  // TypeLiteral (オブジェクトリテラル型) の場合
  if (targetType.type === 'TSTypeLiteral') {
    return extractPropsFromInterfaceBody(targetType, typeMap, depth, visited);
  }

  return undefined;
};

// インターフェースまたはTypeLiteralのボディからプロパティを抽出
const extractPropsFromInterfaceBody = (
  body: any,
  typeMap: Map<string, any>,
  depth: number,
  visited: Set<string>,
): { [key: string]: PropertyInfo } | undefined => {
  const nestedProps: { [key: string]: PropertyInfo } = {};

  // TSInterfaceDeclaration.body は TSInterfaceBody型で、body.bodyにメンバーがある
  // TSTypeLiteral は members にメンバーがある
  const members = body.body || body.members || [];

  for (const member of members) {
    if (member.type === 'TSPropertySignature' && member.key?.type === 'Identifier') {
      const propName = member.key.name;
      const propInfo: PropertyInfo = { name: propName };

      // 再帰的にネストされたプロパティを抽出
      if (member.typeAnnotation?.typeAnnotation) {
        const nested = extractNestedPropsFromType(
          member.typeAnnotation.typeAnnotation,
          typeMap,
          depth + 1,
          undefined,
          visited,
        );
        if (nested && Object.keys(nested).length > 0) {
          propInfo.nestedProps = nested;
        }
      }

      nestedProps[propName] = propInfo;
    }
  }

  return Object.keys(nestedProps).length > 0 ? nestedProps : undefined;
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

    // 型定義を収集
    const typeMap = collectTypeDefinitions(ast);

    ts.simpleTraverse(ast, {
      enter(node) {
        if (node.type === 'TSInterfaceDeclaration' && node.id.name.endsWith('Props')) {
          const properties: string[] = [];
          const detailedProps: { [key: string]: PropertyInfo } = {};

          for (const prop of node.body.body) {
            if (prop.type === 'TSPropertySignature' && prop.key.type === 'Identifier') {
              const propName = prop.key.name;
              properties.push(propName);

              // プロパティの詳細情報を構築
              const propInfo: PropertyInfo = { name: propName };

              // 型アノテーションがある場合、ネストされたプロパティを抽出
              if (prop.typeAnnotation?.typeAnnotation) {
                const nested = extractNestedPropsFromType(prop.typeAnnotation.typeAnnotation, typeMap, 0, propName);
                if (nested && Object.keys(nested).length > 0) {
                  propInfo.nestedProps = nested;
                }
              }

              detailedProps[propName] = propInfo;
            }
          }

          if (properties.length > 0) {
            results.push({
              module: moduleName,
              name: node.id.name.replace('Props', ''),
              props: properties,
              detailedProps: detailedProps,
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

// オブジェクトリテラルからネストされたプロパティを抽出する補助関数
const extractNestedPropsFromObjectExpression = (objExpr: any, depth: number = 0): { [key: string]: PropertyInfo } | undefined => {
  const MAX_DEPTH = 3; // 最大ネスト深度
  if (depth >= MAX_DEPTH || !objExpr || objExpr.type !== 'ObjectExpression') {
    return undefined;
  }

  const nestedProps: { [key: string]: PropertyInfo } = {};

  for (const prop of objExpr.properties) {
    if (prop.type === 'Property' && prop.key.type === 'Identifier') {
      const propName = prop.key.name;
      const propInfo: PropertyInfo = { name: propName };

      // プロパティの値がオブジェクトリテラルの場合、再帰的に処理
      if (prop.value.type === 'ObjectExpression') {
        const nested = extractNestedPropsFromObjectExpression(prop.value, depth + 1);
        if (nested && Object.keys(nested).length > 0) {
          propInfo.nestedProps = nested;
        }
      }

      nestedProps[propName] = propInfo;
    }
    // スプレッド構文の場合もサポート（将来の拡張用）
    else if (prop.type === 'SpreadElement') {
      // スプレッド構文は現時点では無視（複雑になるため）
    }
  }

  return Object.keys(nestedProps).length > 0 ? nestedProps : undefined;
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
            const detailedProps: { [key: string]: PropertyInfo } = {};

            if (node.arguments.length > 2 && node.arguments[2].type === 'ObjectExpression') {
              const objExpr = node.arguments[2];

              for (const prop of objExpr.properties) {
                if (prop.type === 'Property' && prop.key.type === 'Identifier') {
                  const propName = prop.key.name;
                  properties.push(propName);

                  // プロパティの詳細情報を構築
                  const propInfo: PropertyInfo = { name: propName };

                  // プロパティの値がオブジェクトリテラルの場合、ネストされたプロパティを抽出
                  if (prop.value.type === 'ObjectExpression') {
                    const nested = extractNestedPropsFromObjectExpression(prop.value, 0);
                    if (nested && Object.keys(nested).length > 0) {
                      propInfo.nestedProps = nested;
                    }
                  }

                  detailedProps[propName] = propInfo;
                }
              }
            }

            if (properties.length > 0) {
              results.push({
                module: moduleName,
                name: node.callee.name,
                props: properties,
                detailedProps: detailedProps,
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

// ネストされたプロパティを再帰的に比較する補助関数（ドット記法でフラット化）
const compareNestedProps = (
  l1Props: { [key: string]: PropertyInfo } | undefined,
  l2Props: { [key: string]: PropertyInfo } | undefined,
  parentPath: string = '',
): string[] => {
  const missingPaths: string[] = [];

  if (!l1Props) {
    return missingPaths;
  }

  // L1の各プロパティについて
  for (const [propName, l1PropInfo] of Object.entries(l1Props)) {
    const currentPath = parentPath ? `${parentPath}.${propName}` : propName;

    // L2に同じプロパティがあるかチェック
    const l2PropInfo = l2Props?.[propName];

    if (!l2PropInfo) {
      // L2にプロパティがない場合は、このプロパティを欠落として記録
      // （トップレベルで既に検出されているはずなので、ここでは記録しない）
      continue;
    }

    // 両方にプロパティがある場合、ネストされたプロパティをチェック
    if (l1PropInfo.nestedProps) {
      const l1NestedKeys = Object.keys(l1PropInfo.nestedProps);
      const l2NestedKeys = l2PropInfo.nestedProps ? Object.keys(l2PropInfo.nestedProps) : [];

      // ネストされたプロパティの欠落を検出（ドット記法でパスを構築）
      const missingNestedProps = l1NestedKeys.filter(key => !l2NestedKeys.includes(key));
      for (const missingKey of missingNestedProps) {
        missingPaths.push(`${currentPath}.${missingKey}`);
      }

      // さらに深くネストされたプロパティを再帰的に比較
      const deeperMissing = compareNestedProps(l1PropInfo.nestedProps, l2PropInfo.nestedProps, currentPath);
      missingPaths.push(...deeperMissing);
    }
  }

  return missingPaths;
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
      // トップレベルのプロパティの欠落をチェック
      const missingTopLevelProps = l1Item.props.filter(prop => !l2Item.props.includes(prop));

      // ネストされたプロパティの欠落をチェック（ドット記法でフラット化）
      const missingNestedProps = compareNestedProps(l1Item.detailedProps, l2Item.detailedProps);

      // 全ての欠落プロパティを結合
      const allMissingProps = [...missingTopLevelProps, ...missingNestedProps];

      // 欠落しているプロパティがある場合のみ結果に追加
      if (allMissingProps.length > 0) {
        results.push({
          module: l1Item.module,
          name: l1Item.name,
          missingProps: allMissingProps,
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

    // 結果を整形
    const flattenedResults = results.flatMap(result =>
      result.missingProperties.map((prop: any) => ({
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
      if (missingCount > 0) {
        console.log(`${result.moduleName}: ${missingCount} constructs with missing properties`);
      }
    });
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
};

void main();