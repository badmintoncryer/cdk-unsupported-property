import * as ts from '@typescript-eslint/typescript-estree';
import * as fs from 'fs';
import * as path from 'path';

// 対象の関数をテスト用に抽出
const extractCfnConstructorProperties = (filePath: string): { name: string; props: string[] }[] => {
  try {
    const code = fs.readFileSync(filePath, 'utf8');
    const ast = ts.parse(code, {
      loc: true,
      tokens: true,
      comment: true,
      jsx: false,
      useJSXTextNode: false,
    });

    const results: { name: string; props: string[] }[] = [];

    ts.simpleTraverse(ast, {
      enter(node: any) {
        if (node.type === 'NewExpression' &&
            node.callee.type === 'MemberExpression' &&
            node.callee.property.type === 'Identifier' &&
            node.callee.property.name === 'CfnDistribution') {

          const properties: string[] = [];
          if (node.arguments.length > 2 && node.arguments[2].type === 'ObjectExpression') {
            // 直接指定されたプロパティを処理
            node.arguments[2].properties.forEach((prop: any) => {
              if (prop.type === 'Property' && prop.key.type === 'Identifier') {
                properties.push(prop.key.name);
              }
              // スプレッド演算子で展開されたプロパティを処理
              else if (prop.type === 'SpreadElement' && prop.argument.type === 'Identifier') {
                // スプレッド演算子で使用されている変数名を取得
                const spreadVarName = prop.argument.name;
                
                // このスコープ内でスプレッド変数の宣言を探す
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
              name: 'CfnDistribution',
              props: properties,
            });
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

describe('Spread Operator Support Tests', () => {
  test('should detect properties from spread operators', () => {
    const fixtureFile = path.join(__dirname, 'fixtures', 'spread-operator-test.ts');
    const result = extractCfnConstructorProperties(fixtureFile);
    
    // 2つのCfnDistributionコンストラクトが検出されること
    expect(result.length).toBe(2);
    
    // 両方のコンストラクトで'distributionConfig'プロパティが検出されること
    expect(result[0].props).toContain('distributionConfig');
    expect(result[1].props).toContain('distributionConfig');
  });
});