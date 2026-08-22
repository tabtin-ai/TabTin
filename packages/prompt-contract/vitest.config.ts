import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ESLint 规则测试用 ESLint 内置 RuleTester（不是 vitest），单独由
    // eslint-rules/package.json scripts.test 调起；vitest 不要扫
    exclude: ['eslint-rules/**', 'node_modules/**', 'dist/**'],
  },
});
