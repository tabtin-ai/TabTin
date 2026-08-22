/**
 * ad-hoc 一次性扫描：用 ESLint Linter API 把三条规则跑到真实目标文件上，
 * 看接入 root config 会触发多少 violation。
 *
 * 跑法（从仓库根）：
 *   node packages/prompt-contract/eslint-rules/__tests__/_ad-hoc-scan.mjs
 *
 * 不修改 root eslint.config.mjs / lint-baseline.json，安全无副作用。
 *
 * 用途：在 README + 汇报里给出"如果接入 root config 会产生 N 个 warning / error"
 * 的预估，让接入决策有数据支撑。
 */

import { Linter } from 'eslint'
import tsParser from '@typescript-eslint/parser'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import promptContractPlugin from '../index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')

// flat config files glob 是相对 cwd 解析的。统一 chdir 到仓库根，避免脚本从
// pnpm script (cwd=eslint-rules) vs 直接 node 跑 (cwd=repo root) 行为不一致。
process.chdir(REPO_ROOT)

const linter = new Linter()

/**
 * 跑一组目标文件，统计 violation 数量与样本
 *
 * @param {string} ruleId  譬如 'prompt-contract/no-inline-llm-prompt'
 * @param {string[]} relPaths  仓库相对路径数组
 * @param {string} severity  'warn' | 'error'
 */
function scanRule(ruleId, relPaths, severity = 'warn') {
  let total = 0
  /** @type {{file: string; line: number; message: string}[]} */
  const samples = []

  for (const rel of relPaths) {
    const abs = path.join(REPO_ROOT, rel)
    if (!fs.existsSync(abs)) continue
    let code
    try {
      code = fs.readFileSync(abs, 'utf-8')
    } catch {
      continue
    }
    // Linter.verify 在 flat config 模式下用 array form + files glob 匹配 filename。
    // 之前实测：array form + `files: ['**/*.{ts,tsx,...}']` + abspath filename 真
    // 能 match 命中（命中数与人工 grep 验证一致）。换成 single object 或 `**/*`
    // 通配后反而走到 "No matching configuration found" 分支。
    const messages = linter.verify(
      code,
      [
        {
          files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
          plugins: { 'prompt-contract': promptContractPlugin },
          languageOptions: {
            parser: tsParser,
            ecmaVersion: 2022,
            sourceType: 'module',
            parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
          },
          rules: { [ruleId]: severity },
        },
      ],
      { filename: abs },
    )
    // 过滤：只关心 prompt-contract 命名空间的真实命中
    // （ESLint Linter API 会一并报 "Unused eslint-disable directive" / "Definition for rule '...' not found"
    //  等环境 noise，跟本规则无关）
    const ours = messages.filter((m) => m.ruleId === ruleId)
    total += ours.length
    if (process.env.SCAN_DEBUG && messages.length > 0 && ours.length === 0) {
      console.log(`  DEBUG ${rel}: total ${messages.length} messages, none is ${ruleId}; first: ${messages[0].ruleId || '<no-rule>'} / ${messages[0].message.slice(0, 80)}`)
    }
    for (const m of ours.slice(0, 3)) {
      samples.push({
        file: rel,
        line: m.line,
        message: m.message.slice(0, 220),
      })
    }
  }

  return { total, samples }
}

function listFiles(dir, predicate) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (
        ent.name === 'node_modules' ||
        ent.name === 'dist' ||
        ent.name === 'build' ||
        ent.name === '__tests__' ||
        ent.name === '.test-dist'
      ) {
        continue
      }
      out.push(...listFiles(full, predicate))
    } else if (ent.isFile() && predicate(ent.name)) {
      out.push(path.relative(REPO_ROOT, full))
    }
  }
  return out
}

console.log('=== ad-hoc scan: prompt-contract 三条规则在真实仓库代码上的 violation 预估 ===\n')

// — 规则 2: tool-description-length —
console.log('[规则 2] prompt-contract/tool-description-length')
{
  const toolFiles = [
    ...listFiles(
      path.join(REPO_ROOT, 'packages', 'agent-runtime', 'src', 'tools'),
      (n) => n.endsWith('.ts') && !n.endsWith('.d.ts'),
    ),
    'packages/agent-runtime/src/capability/core/shell.ts',
  ]
  console.log(`  扫描文件数: ${toolFiles.length}`)
  const r = scanRule('prompt-contract/tool-description-length', toolFiles, 'warn')
  console.log(`  违例总数: ${r.total}`)
  for (const s of r.samples.slice(0, 8)) {
    console.log(`    ${s.file}:${s.line}  ${s.message}`)
  }
}

console.log('')

// — 规则 3: section-name-match —
console.log('[规则 3] prompt-contract/section-name-match')
{
  const sectionScope = [
    ...listFiles(
      path.join(REPO_ROOT, 'packages', 'agent-prompt', 'src'),
      (n) => n.endsWith('.ts') && !n.endsWith('.d.ts'),
    ),
    ...listFiles(
      path.join(REPO_ROOT, 'packages', 'agent-runtime', 'src'),
      (n) => n.endsWith('.ts') && !n.endsWith('.d.ts'),
    ),
  ]
  console.log(`  扫描文件数: ${sectionScope.length}`)
  const r = scanRule('prompt-contract/section-name-match', sectionScope, 'warn')
  console.log(`  违例总数: ${r.total}`)
  for (const s of r.samples.slice(0, 8)) {
    console.log(`    ${s.file}:${s.line}  ${s.message}`)
  }
}

console.log('')

// — 规则 1: no-inline-llm-prompt —
console.log('[规则 1] prompt-contract/no-inline-llm-prompt')
{
  // apps 目录较大，先扫几个关键 host
  const targets = [
    'apps/tabtin-electron/src/main',
    'apps/tabtin-electron/src/preload',
    'apps/tabtin-electron/src/renderer/src',
    'apps/tabtin-daemon/src',
    'apps/tabtin-cli/src',
  ]
  const appFiles = []
  for (const t of targets) {
    appFiles.push(
      ...listFiles(
        path.join(REPO_ROOT, t),
        (n) => /\.(ts|tsx)$/.test(n) && !n.endsWith('.d.ts'),
      ),
    )
  }
  console.log(`  扫描文件数: ${appFiles.length} (apps/tabtin-electron + daemon + cli)`)
  const r = scanRule('prompt-contract/no-inline-llm-prompt', appFiles, 'warn')
  console.log(`  违例总数: ${r.total}`)
  for (const s of r.samples.slice(0, 8)) {
    console.log(`    ${s.file}:${s.line}  ${s.message}`)
  }
}

console.log('\n=== scan done ===')
