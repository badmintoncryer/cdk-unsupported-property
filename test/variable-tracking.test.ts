import * as ts from '@typescript-eslint/typescript-estree';

// 変数宣言を収集する補助関数（テスト用にコピー）
const collectVariableDeclarations = (ast: any): Map<string, any> => {
  const varMap = new Map<string, any>();

  ts.simpleTraverse(ast, {
    enter(node) {
      if (node.type === 'VariableDeclaration') {
        for (const declarator of node.declarations) {
          if (declarator.id?.type === 'Identifier' &&
              declarator.init?.type === 'ObjectExpression') {
            varMap.set(declarator.id.name, declarator.init);
          }
        }
      }
    },
  });

  return varMap;
};

describe('Variable Tracking Feature', () => {
  describe('collectVariableDeclarations', () => {
    it('should collect simple variable declarations with object literals', () => {
      const code = `
        const config = {
          prop1: 'value1',
          prop2: 'value2'
        };
      `;

      const ast = ts.parse(code, {
        loc: true,
        comment: false,
      });

      const varMap = collectVariableDeclarations(ast);

      expect(varMap.size).toBe(1);
      expect(varMap.has('config')).toBe(true);

      const configNode = varMap.get('config');
      expect(configNode).toBeDefined();
      expect(configNode.type).toBe('ObjectExpression');
      expect(configNode.properties.length).toBe(2);
    });

    it('should collect multiple variable declarations', () => {
      const code = `
        const config1 = { a: 1 };
        const config2 = { b: 2 };
        let config3 = { c: 3 };
      `;

      const ast = ts.parse(code, {
        loc: true,
        comment: false,
      });

      const varMap = collectVariableDeclarations(ast);

      expect(varMap.size).toBe(3);
      expect(varMap.has('config1')).toBe(true);
      expect(varMap.has('config2')).toBe(true);
      expect(varMap.has('config3')).toBe(true);
    });

    it('should ignore non-object variable declarations', () => {
      const code = `
        const str = 'string';
        const num = 123;
        const arr = [1, 2, 3];
        const func = () => {};
        const obj = { valid: true };
      `;

      const ast = ts.parse(code, {
        loc: true,
        comment: false,
      });

      const varMap = collectVariableDeclarations(ast);

      // オブジェクトリテラルで初期化された変数のみ収集される
      expect(varMap.size).toBe(1);
      expect(varMap.has('obj')).toBe(true);
    });

    it('should handle nested object literals', () => {
      const code = `
        const config = {
          nested: {
            deep: {
              value: 'test'
            }
          }
        };
      `;

      const ast = ts.parse(code, {
        loc: true,
        comment: false,
      });

      const varMap = collectVariableDeclarations(ast);

      expect(varMap.size).toBe(1);
      expect(varMap.has('config')).toBe(true);

      const configNode = varMap.get('config');
      expect(configNode.properties.length).toBe(1);
      expect(configNode.properties[0].key.name).toBe('nested');
      expect(configNode.properties[0].value.type).toBe('ObjectExpression');
    });

    it('should handle empty objects', () => {
      const code = `
        const empty = {};
      `;

      const ast = ts.parse(code, {
        loc: true,
        comment: false,
      });

      const varMap = collectVariableDeclarations(ast);

      expect(varMap.size).toBe(1);
      expect(varMap.has('empty')).toBe(true);

      const emptyNode = varMap.get('empty');
      expect(emptyNode.properties.length).toBe(0);
    });
  });

  describe('AST Structure Validation', () => {
    it('should parse variable reference in property value', () => {
      const code = `
        const nestedConfig = { a: 1 };
        const mainConfig = {
          nested: nestedConfig
        };
      `;

      const ast = ts.parse(code, {
        loc: true,
        comment: false,
      });

      const varMap = collectVariableDeclarations(ast);

      expect(varMap.size).toBe(2);

      const mainConfigNode = varMap.get('mainConfig');
      expect(mainConfigNode).toBeDefined();
      expect(mainConfigNode.properties[0].value.type).toBe('Identifier');
      expect(mainConfigNode.properties[0].value.name).toBe('nestedConfig');
    });

    it('should parse spread syntax in object literal', () => {
      const code = `
        const base = { a: 1 };
        const extended = {
          ...base,
          b: 2
        };
      `;

      const ast = ts.parse(code, {
        loc: true,
        comment: false,
      });

      const varMap = collectVariableDeclarations(ast);

      expect(varMap.size).toBe(2);

      const extendedNode = varMap.get('extended');
      expect(extendedNode).toBeDefined();
      expect(extendedNode.properties.length).toBe(2);
      expect(extendedNode.properties[0].type).toBe('SpreadElement');
      expect(extendedNode.properties[0].argument.name).toBe('base');
    });
  });

  describe('Edge Cases', () => {
    it('should handle variables with same name in different scopes', () => {
      const code = `
        const config = { outer: true };

        function test() {
          const config = { inner: true };
        }
      `;

      const ast = ts.parse(code, {
        loc: true,
        comment: false,
      });

      const varMap = collectVariableDeclarations(ast);

      // 両方のconfigが収集される（最後のものが上書きされる）
      expect(varMap.has('config')).toBe(true);
    });

    it('should ignore undefined initializers', () => {
      const code = `
        let config;
        config = { a: 1 };
      `;

      const ast = ts.parse(code, {
        loc: true,
        comment: false,
      });

      const varMap = collectVariableDeclarations(ast);

      // 初期化子がない変数宣言は無視される
      expect(varMap.size).toBe(0);
    });
  });
});
