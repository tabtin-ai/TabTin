import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/manifest.ts',
    'src/headless.ts',
    'src/types/public.ts',
    'src/errors/public.ts',
    'src/manifest/public.ts',
    'src/runtime/public.ts',
    'src/tools/public.ts',
    'src/impl/public.ts',
    'src/adapters/public.ts',
    'src/cdp/public.ts',
    'src/registration.ts',
    'src/utils/oss-upload.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  // **关键 #1：external `@vscode/ripgrep`** —— 该包 `lib/index.js` 用
  // `path.join(__dirname, '../bin/rg')` 计算二进制位置。bundle 进 chunk 后
  // `__dirname` 被替换成 dist chunk 所在目录，算出 `packages/action-tools/bin/rg`
  // (不存在)。external 后运行时通过真实 node_modules 解析，bundled rg 路径正确。
  external: ['@vscode/ripgrep'],

  // **关键 #2：banner 注入真实 createRequire** —— esbuild 给 ESM 输出注入的
  // `__require` polyfill 长这样：
  //
  //   var __require = (typeof require !== "undefined" ? require : ...)
  //
  // 但纯 ESM 环境（node --input-type=module / Electron renderer 走 mjs 路径 /
  // packaged Electron 部分场景）里**全局 `require` 不存在**，polyfill 直接 fall
  // through 到一个 throw "Dynamic require of X is not supported" 的 Proxy。
  //
  // 结果：external 化的 `@vscode/ripgrep` 在 dist 里是 `__require("@vscode/
  // ripgrep")`，但这个 __require 在 ESM 环境抛错，被 grep_search 的 try/catch
  // 吞掉，fall through 到 `which rg`，受限 PATH 下死锁——P0 修复名义上做了，
  // 实际仍然失败。
  //
  // 修法：banner 在每个 dist chunk 顶部注入用 `createRequire(import.meta.url)`
  // 派生的真实 require，覆盖 esbuild 的破 polyfill。`import.meta.url` 是当前
  // ESM module 的 URL，createRequire 基于它的 node_modules 解析路径正确。
  //
  // 这条与 verify-tsup-externals.mjs 是双保险：external 让物理路径正确，
  // banner 让 ESM require 真能跑。
  banner: {
    js: `import { createRequire as __createRequireFromTsupBanner } from 'node:module'; const require = __createRequireFromTsupBanner(import.meta.url);`,
  },
});
