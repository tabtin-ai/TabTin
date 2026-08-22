import { defineConfig } from 'tsup';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * SP build 配置 —— 多入口 + 不打包到单文件。
 *
 * 为什么 `bundle: false`：
 *   - dist 保留 src 的模块结构，让消费侧（Vite renderer / Electron main / Daemon）
 *     的 tree-shake 能跳过未使用的子模块
 *   - 关键场景：renderer 只 import 旧 API（OPERATION_CATEGORIES 等），不 import
 *     judge / normalize 等 Node-API 模块。`bundle: true` 时 dist/index.js 是
 *     单文件 bundle，所有顶层 `import 'node:fs'` 在 renderer build 阶段触发
 *     `__vite-browser-external` polyfill 失败
 *   - `bundle: false` 时 dist/path-normalize.js 等独立文件，renderer 没引用就
 *     不会被 vite 解析
 *
 * 为什么需要后处理：tsup `bundle: false` 不会自动给相对 import 加 `.js` 后缀，
 * 而 Node ESM 严格要求后缀；这里用 onSuccess 钩子做一次正则替换补齐。
 */
export default defineConfig({
  entry: ['src/**/*.ts', '!src/**/*.test.ts'],
  format: ['esm'],
  dts: true,
  bundle: false,
  clean: true,
  sourcemap: false,
  outDir: 'dist',
  external: [/^node:/],
  // 给 dist/*.js 的相对 import 自动补 `.js` 后缀（Node ESM 强制要求）。
  // tsup `bundle: false` 模式不会自动补，必须后处理。
  onSuccess: async () => {
    const distDir = path.resolve('dist');
    const srcDir = path.resolve('src');
    for (const f of fs.readdirSync(srcDir)) {
      if (f.endsWith('.json')) {
        fs.copyFileSync(path.join(srcDir, f), path.join(distDir, f));
      }
    }
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
      }
      return out;
    };
    const files = walk(distDir);
    // 匹配相对 import / export 中无后缀的路径，统一加 .js
    // 不动：含后缀的 / 第三方包 / node: 内置
    const re = /(\b(?:from|import)\s*\(?\s*["'])(\.\.?\/[^"']*?)(["']\s*\)?)/g;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      let out = src.replace(re, (_match, p1: string, p2: string, p3: string) => {
        if (/\.(?:[mc]?js|json)$/.test(p2)) return p1 + p2 + p3;
        return p1 + p2 + '.js' + p3;
      });
      // Node ESM 直跑 dist 时 JSON import 必须带 import attribute；Vite/Rollup
      // 消费 source 时无需该后处理，dist 侧补上即可。
      out = out.replace(
        /(\bfrom\s+["']\.\.?\/[^"']+\.json["'])(?!\s+with\s+\{\s*type:\s*["']json["']\s*\})/g,
        '$1 with { type: "json" }',
      );
      if (out !== src) fs.writeFileSync(f, out, 'utf8');
    }
  },
});
