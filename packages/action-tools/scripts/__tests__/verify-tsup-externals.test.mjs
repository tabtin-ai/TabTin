/**
 * verify-tsup-externals 单测
 *
 * 关键不变量：
 *   1. 注释行匹配：能识别 esbuild 标准的 commonJS shim 注释格式
 *   2. native 特征检测：gypfile / binary / postinstall 关键词 / .node 文件 / bin 非 JS
 *   3. monorepo 内部包跳过：@tabtin/* 不应被报错
 *   4. 端到端：当前 action-tools dist（fresh build 后）verify 通过
 *
 * 这个 mjs 测试由 vitest 直接跑（vitest 4 支持 .mjs），加到 packages/action-tools
 * 的测试目录里走标准 vitest run。
 */

import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const scriptPath = path.resolve(__dirname, '../verify-tsup-externals.mjs')
const packageRoot = path.resolve(__dirname, '../..')
const distRoot = path.join(packageRoot, 'dist')

describe('verify-tsup-externals', () => {
  it('在 fresh dist 上应通过（零 inline native 包）', async () => {
    // 假设：调用方先跑了 pnpm build，dist 是 fresh 的
    // 如果 dist 不存在，跳过这条测试
    try {
      await fs.stat(distRoot)
    } catch {
      return // dist 不存在，跳过
    }

    const result = spawnSync('node', [scriptPath], {
      encoding: 'utf8',
      cwd: packageRoot,
    })
    if (result.status !== 0) {
      // 失败时打印输出便于调试
      console.error('verify-tsup-externals output:\n', result.stdout, '\n', result.stderr)
    }
    expect(result.status).toBe(0)
  })

  it('能识别注入式构造的 native 包并 fail', async () => {
    // 在 tmp 目录里造一个假 dist + 假 node_modules，让脚本应该报错
    const tmp = await fs.mkdtemp(path.join(packageRoot, '.test-fixture-'))
    try {
      // 假 dist chunk：模拟 esbuild __commonJS shim 注释格式
      const fakeDist = path.join(tmp, 'dist')
      await fs.mkdir(fakeDist, { recursive: true })
      // 注意 ../../node_modules/.pnpm/<pkg>/node_modules/<pkg>/lib 形态
      // 我们的脚本用相对到 packageRoot 解析包名 → 保留这个结构
      const fakeChunk = `// some preamble
// ../../node_modules/.pnpm/fake-native-pkg@1.0.0/node_modules/fake-native-pkg/lib/index.js
var require_lib = __commonJS({
  "../../node_modules/.pnpm/fake-native-pkg@1.0.0/node_modules/fake-native-pkg/lib/index.js"(exports, module) {
    module.exports.binPath = require('node:path').join(__dirname, '../bin/fake');
  }
});
`
      await fs.writeFile(path.join(fakeDist, 'chunk-test.js'), fakeChunk, 'utf8')

      // 假 package.json（local node_modules 模拟）
      const fakeNm = path.join(tmp, 'node_modules', 'fake-native-pkg')
      await fs.mkdir(path.join(fakeNm, 'bin'), { recursive: true })
      // bin/ 下放一个非 JS 文件（典型预编译二进制）
      await fs.writeFile(path.join(fakeNm, 'bin', 'fake'), '#!/bin/sh\necho fake\n', { mode: 0o755 })
      await fs.writeFile(
        path.join(fakeNm, 'package.json'),
        JSON.stringify({
          name: 'fake-native-pkg',
          version: '1.0.0',
          gypfile: true,
        }, null, 2),
        'utf8',
      )

      // 假 packageRoot + scripts 目录
      await fs.writeFile(
        path.join(tmp, 'package.json'),
        JSON.stringify({ name: 'fake-action-tools', dependencies: { 'fake-native-pkg': '1.0.0' } }),
        'utf8',
      )
      const fakeScriptsDir = path.join(tmp, 'scripts')
      await fs.mkdir(fakeScriptsDir, { recursive: true })
      // 复制 verify-tsup-externals.mjs 到 fixture（脚本内 packageRoot 算法基于 __dirname/..）
      const original = await fs.readFile(scriptPath, 'utf8')
      await fs.writeFile(path.join(fakeScriptsDir, 'verify-tsup-externals.mjs'), original, 'utf8')

      const result = spawnSync(
        'node',
        [path.join(fakeScriptsDir, 'verify-tsup-externals.mjs')],
        { encoding: 'utf8', cwd: tmp },
      )

      expect(result.status).toBe(1)
      // 输出应该提到 fake-native-pkg
      const combined = result.stdout + result.stderr
      expect(combined).toMatch(/fake-native-pkg/)
      // 应该提到至少一个原因
      expect(combined).toMatch(/gypfile|bin\/.*non-JS/)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it('monorepo @tabtin/* 内部包应跳过（即使被 inline 也不算 offender）', async () => {
    // 用同样的 fixture 套路，但包名是 @tabtin/fake-internal
    const tmp = await fs.mkdtemp(path.join(packageRoot, '.test-fixture-'))
    try {
      const fakeDist = path.join(tmp, 'dist')
      await fs.mkdir(fakeDist, { recursive: true })
      const fakeChunk = `// ../../node_modules/.pnpm/@tabtin+fake-internal@1.0.0/node_modules/@tabtin/fake-internal/lib/index.js
var require_lib = __commonJS({
  "../../node_modules/.pnpm/@tabtin+fake-internal@1.0.0/node_modules/@tabtin/fake-internal/lib/index.js"(exports, module) {
    module.exports = {};
  }
});
`
      await fs.writeFile(path.join(fakeDist, 'chunk-test.js'), fakeChunk, 'utf8')

      await fs.writeFile(
        path.join(tmp, 'package.json'),
        JSON.stringify({ name: 'fake-action-tools' }),
        'utf8',
      )
      const fakeScriptsDir = path.join(tmp, 'scripts')
      await fs.mkdir(fakeScriptsDir, { recursive: true })
      const original = await fs.readFile(scriptPath, 'utf8')
      await fs.writeFile(path.join(fakeScriptsDir, 'verify-tsup-externals.mjs'), original, 'utf8')

      const result = spawnSync(
        'node',
        [path.join(fakeScriptsDir, 'verify-tsup-externals.mjs')],
        { encoding: 'utf8', cwd: tmp },
      )

      // monorepo 内部包应被跳过 → exit 0
      expect(result.status).toBe(0)
      const combined = result.stdout + result.stderr
      expect(combined).toContain('found 1 packages inlined')
      expect(combined).toMatch(/OK/i)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})
