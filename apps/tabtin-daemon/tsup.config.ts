import { defineConfig } from 'tsup';
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
const tabtinDeps = Object.keys(pkg.dependencies ?? {}).filter(
  (d: string) => d.startsWith('@tabtin/'),
);
const bundledTabtinDeps = [...new Set([...tabtinDeps, '@tabtin/app-shell'])];

// @tabtin/security-policy 的 hardline 规则在运行时用
// `createRequire(import.meta.url)('./hardline-v3-rules.json')` 按相对路径加载。
// security-policy 自己的 dist 是 bundle:false，会把这份 JSON 拷在 dist 旁，所以它
// 自身（及 Electron 直接消费它的 dist）能解析到。但 daemon 这里 noExternal 把
// security-policy 重新打成单 bundle，createRequire 的 import.meta.url 变成 daemon
// 的产物文件 → 相对路径解析到 daemon 的产物目录，那里没有这份 JSON → 运行时
// `Cannot find module './hardline-v3-rules.json'`，daemon 直接启动失败。
//
// 修法：构建后把这份 JSON（从 security-policy 已构建的 dist 解析，保证是 SSoT 同一份）
// 拷到 daemon 所有产物目录（主 bundle 在 dist/，worker bundle 在 dist/workers/）。
// helper 幂等、与构建顺序无关——挂到每个 config 的 onSuccess，谁最后跑都能补齐两处。
function copyHardlineRules() {
  return async () => {
    const spDistDir = dirname(require.resolve('@tabtin/security-policy'));
    const src = join(spDistDir, 'hardline-v3-rules.json');
    for (const sub of ['', 'workers']) {
      const dstDir = join(__dirname, 'dist', sub);
      mkdirSync(dstDir, { recursive: true });
      copyFileSync(src, join(dstDir, 'hardline-v3-rules.json'));
    }
  };
}

// react / react-dom are peerDependencies of @tabtin/tabslide (and related packages).
// The headless entry path does not import React, but we declare them as external
// to prevent tsup from bundling them if a non-headless import sneaks into the
// dependency graph. Node.js daemon does not provide a React runtime.
const reactExternals = ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'];

// CJS packages that use `require('buffer')` etc. must be external to avoid
// tsup's ESM CJS-compat shim throwing "Dynamic require of X is not supported".
const cjsExternals = ['safer-buffer', 'iconv-lite', 'encoding'];

// pdfjs-dist / mammoth / xlsx 必须 external —— 它们是 CJS / 大型 native 风格依赖，
// tsup ESM bundle 会把 mammoth 内联导致 `Dynamic require of "stream"` 等运行时错误；
// 且把 200KB pdfjs / 600KB xlsx 全部塞进 worker bundle 会严重拖慢启动。
// 与 `@tabtin/local-docparse/workers` 配合：handlers 内部走 `await import('pdfjs-dist')`
// 等懒加载，运行时由 Node 自己解析到 hoisted node_modules（pnpm symlink 可达）。
const docParserExternals = ['pdfjs-dist', 'mammoth', 'xlsx'];

// canvas 是 jsdom 的可选依赖（用于图片渲染），daemon 的 mermaid 编译路径
// 只需要 jsdom 的 DOM API 不需要 canvas。canvas 的 .node 原生二进制在
// 当前环境未编译（pnpm optional dep），esbuild 无法打包 .node 文件。
const nativeExternals = ['canvas'];

// jsdom 由 @tabtin/agent-runtime 引入（mermaid 渲染需要无头 DOM）。它是重量级、
// 带「运行时相对加载数据文件」的库——其依赖 css-tree 运行时 `require('../data/patch.json')`，
// 一旦打进单 bundle，相对路径解析到 daemon 产物目录 → 运行时 MODULE_NOT_FOUND（H-11，与 H-3 同病根）。
// pnpm 严格布局下 css-tree 是 jsdom 的深层间接依赖、daemon 直接 external 它解析不到；
// 故与 pdfjs/mammoth/xlsx 同策略：把 jsdom 声明为 daemon 直接依赖（见 package.json）+ external，
// 运行时由 Node 从 node_modules 解析 jsdom 整棵（css-tree 的数据文件原封不动可达），顺带瘦 bundle。
const jsdomExternals = ['jsdom'];

// onnxruntime-node + @anush008/tokenizers 由 @tabtin/local-embedding 懒加载
// （语义双路召回，/#3306）。两者都是 .node 原生二进制 + 运行时动态 require，
// 无法打进 bundle；与 jsdom 同策略：声明为 daemon 直接依赖 + external，
// 运行时由 Node 从 node_modules 解析。
const embeddingExternals = ['onnxruntime-node', '@anush008/tokenizers'];

// Bundled workspace dependencies may still contain guarded CommonJS requires.
// All ESM entry points, including workers, need the same Node-compatible shim.
const esmRequireBanner =
  '#!/usr/bin/env node\n' +
  'import { createRequire as __createRequire } from "node:module"; ' +
  'const require = __createRequire(import.meta.url);';
const esmWorkerCompatBanner =
  '#!/usr/bin/env node\n' +
  'import { createRequire as __createRequire } from "node:module"; ' +
  'import { fileURLToPath as __fileURLToPath } from "node:url"; ' +
  'import { dirname as __pathDirname } from "node:path"; ' +
  'const require = __createRequire(import.meta.url); ' +
  'const __filename = __fileURLToPath(import.meta.url); ' +
  'const __dirname = __pathDirname(__filename);';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    dts: true,
    banner: { js: esmRequireBanner },
    noExternal: bundledTabtinDeps,
    external: ['electron', ...reactExternals, ...cjsExternals, ...docParserExternals, ...nativeExternals, ...jsdomExternals, ...embeddingExternals],
    esbuildOptions(options) {
      options.conditions = ['node', 'import'];
    },
    onSuccess: copyHardlineRules(),
  },
  {
    entry: { 'workers/doc-parser-worker': 'src/platform/content/document/doc-parser-worker.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    dts: false,
    banner: { js: esmWorkerCompatBanner },
    // worker bundle 也要 noExternal 把 @tabtin/local-docparse 打进来（它的 handlers 才是核心）
    noExternal: bundledTabtinDeps,
    // pdfjs / mammoth / xlsx 仍走 external，handlers 里的 `await import('pdfjs-dist')`
    // 在运行时 Node 解析（避免 worker bundle 翻倍且解决 mammoth CJS 跨格式问题）
    external: ['electron', ...reactExternals, ...cjsExternals, ...docParserExternals, ...nativeExternals, ...jsdomExternals, ...embeddingExternals],
    esbuildOptions(options) {
      options.conditions = ['node', 'import'];
    },
    onSuccess: copyHardlineRules(),
  },
]);
