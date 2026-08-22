import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = path.join(packageDir, 'src')
const distDir = path.join(packageDir, 'dist')
const require = createRequire(path.join(packageDir, 'package.json'))
const tscJs = require.resolve('typescript/lib/tsc.js')
const copyScript = path.resolve(packageDir, '../../scripts/shared/copy-static-assets.mjs')

function findCssFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) return findCssFiles(entryPath)
    return path.extname(entry.name).toLowerCase() === '.css' ? [entryPath] : []
  })
}

function runPackageBuild() {
  // 直接用 node 跑 tsc + copy 脚本，等价于 `pnpm run build`，
  // 避免 Windows 上 execFileSync('pnpm.cmd') 触发 EINVAL。
  execFileSync(process.execPath, [tscJs, '-p', 'tsconfig.json'], {
    cwd: packageDir,
    stdio: 'inherit',
  })
  execFileSync(process.execPath, [copyScript, 'src', 'dist', 'css'], {
    cwd: packageDir,
    stdio: 'inherit',
  })
}

fs.rmSync(distDir, { force: true, recursive: true })
runPackageBuild()

const sourceCssFiles = findCssFiles(sourceDir)
assert.ok(sourceCssFiles.length > 0, '预期 src 中至少有一个 CSS 资源')

for (const sourcePath of sourceCssFiles) {
  const relativePath = path.relative(sourceDir, sourcePath)
  const distPath = path.join(distDir, relativePath)
  assert.ok(fs.existsSync(distPath), `dist 缺少 CSS 资源：${relativePath}`)
  assert.equal(
    fs.readFileSync(distPath, 'utf8'),
    fs.readFileSync(sourcePath, 'utf8'),
    `dist CSS 内容不匹配：${relativePath}`,
  )
}

console.log(`[tabdoc-ui] 已验证 ${sourceCssFiles.length} 个 CSS 资源进入 dist`)
