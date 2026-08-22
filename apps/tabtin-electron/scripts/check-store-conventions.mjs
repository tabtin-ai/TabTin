import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CATEGORY_PATTERN = /\/\*\*\s*@store-category\s+(domain|session|ui|prefs)\s*\*\//
const STORE_ROOT = 'apps/tabtin-electron/src/renderer/src/stores'
const TS_STORE_FILE = /\.ts$/i

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(scriptDir, '..')
const repoRoot = path.resolve(packageRoot, '..', '..')

function parseArgs(argv) {
  const args = {
    staged: false,
    baseRef: process.env.STORE_CONVENTIONS_BASE_REF || null,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      args.help = true
      continue
    }
    if (arg === '--staged') {
      args.staged = true
      continue
    }
    if (arg === '--base-ref') {
      args.baseRef = argv[i + 1] ?? null
      i += 1
      continue
    }
    if (arg.startsWith('--base-ref=')) {
      args.baseRef = arg.slice('--base-ref='.length) || null
    }
  }
  return args
}

function printHelp() {
  console.log(`用法:
  pnpm --filter tabtin-electron check:store-conventions
  pnpm --filter tabtin-electron check:store-conventions -- --staged
  pnpm --filter tabtin-electron check:store-conventions -- --base-ref origin/main

说明:
  - 默认模式：只检查当前工作区新增的 store 文件（已跟踪新增 + 未跟踪文件）
  - --staged：只检查已暂存的新增 store 文件
  - --base-ref：检查相对指定 git 基线新增的 store 文件，适合 CI / PR 场景
  - STORE_CONVENTIONS_BASE_REF：可作为 --base-ref 的默认值
`)
}

function runGit(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function parseNameStatusOutput(output) {
  if (!output) return []
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split(/\s+/)
      return {
        status,
        relativePath: rest.join(' '),
      }
    })
}

function listAddedFiles(options) {
  const collected = new Map()

  const addEntry = (entry) => {
    if (entry.status !== 'A') return
    if (!TS_STORE_FILE.test(entry.relativePath)) return
    collected.set(entry.relativePath, entry)
  }

  if (options.staged) {
    for (const entry of parseNameStatusOutput(
      runGit(['diff', '--cached', '--name-status', '--diff-filter=A', '--', STORE_ROOT]),
    )) {
      addEntry(entry)
    }
  } else if (options.baseRef) {
    for (const entry of parseNameStatusOutput(
      runGit(['diff', '--name-status', '--diff-filter=A', `${options.baseRef}...HEAD`, '--', STORE_ROOT]),
    )) {
      addEntry(entry)
    }
  } else {
    for (const entry of parseNameStatusOutput(
      runGit(['diff', '--name-status', '--diff-filter=A', 'HEAD', '--', STORE_ROOT]),
    )) {
      addEntry(entry)
    }

    const untracked = runGit(['ls-files', '--others', '--exclude-standard', '--', STORE_ROOT])
    if (untracked) {
      for (const relativePath of untracked.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
        if (!TS_STORE_FILE.test(relativePath)) continue
        collected.set(relativePath, { status: 'A', relativePath })
      }
    }
  }

  return [...collected.values()]
    .filter((entry) => TS_STORE_FILE.test(entry.relativePath))
}

function isStoreLikeSource(relativePath, source) {
  if (relativePath.includes('/__tests__/') || relativePath.endsWith('.test.ts')) return false
  const baseName = path.basename(relativePath, '.ts')
  if (!baseName.startsWith('use') && !baseName.endsWith('Store')) return false

  return (
    source.includes('create(')
    || source.includes('create<')
    || source.includes('createStore(')
    || source.includes('persist(')
    || source.includes('persist<')
    || /export\s+\{\s*use[A-Z][A-Za-z0-9_]*\s*\}\s+from/.test(source)
    || /export\s+const\s+use[A-Z][A-Za-z0-9_]*\s*=/.test(source)
  )
}

function hasTopCategoryAnnotation(source) {
  const topChunk = source.split(/\r?\n/).slice(0, 20).join('\n')
  return CATEGORY_PATTERN.test(topChunk)
}

function usesPersist(source) {
  return source.includes('persist(') || source.includes('persist<')
}

function hasVersionField(source) {
  return /\bversion\s*:\s*/.test(source)
}

function hasMigrateField(source) {
  return /\bmigrate\s*[:=]/.test(source) || /\bmigrate\s*\(/.test(source)
}

function checkPersistKeyFormat(source) {
  const nameMatch = source.match(/name\s*:\s*['"]([^'"]+)['"]/)
  if (!nameMatch) return true
  const key = nameMatch[1]
  return /^tabtin-(domain|session|ui|prefs)-/.test(key)
}

function hasPartializeField(source) {
  return /\bpartialize\s*[:=]/.test(source)
}

function checkRegistryZeroImport(violations) {
  const registryAbsPath = path.join(repoRoot, STORE_ROOT, 'persist-key-registry.ts')
  if (!fs.existsSync(registryAbsPath)) return
  const registrySource = fs.readFileSync(registryAbsPath, 'utf-8')
  const importMatches = registrySource.match(/^import\s+(?!type\b)/gm)
  if (importMatches && importMatches.length > 0) {
    violations.push(
      `persist-key-registry.ts: must not have runtime imports (found ${importMatches.length}), only type imports allowed`,
    )
  }
}

function main() {
  const cli = parseArgs(process.argv.slice(2))
  if (cli.help) {
    printHelp()
    return
  }

  const violations = []

  checkRegistryZeroImport(violations)

  const addedFiles = listAddedFiles({ staged: cli.staged, baseRef: cli.baseRef })

  for (const entry of addedFiles) {
    const absolutePath = path.join(repoRoot, entry.relativePath)
    const source = fs.readFileSync(absolutePath, 'utf8')

    if (!isStoreLikeSource(entry.relativePath, source)) continue

    if (!hasTopCategoryAnnotation(source)) {
      violations.push(`${entry.relativePath}: missing top-of-file @store-category annotation`)
    }

    if (usesPersist(source) && !hasVersionField(source)) {
      violations.push(`${entry.relativePath}: persist store is missing a version field`)
    }

    if (usesPersist(source) && hasVersionField(source) && !hasMigrateField(source)) {
      violations.push(`${entry.relativePath}: persist store has version but missing migrate`)
    }

    if (usesPersist(source) && !checkPersistKeyFormat(source)) {
      violations.push(`${entry.relativePath}: persist key must match tabtin-{category}-{name} format`)
    }

    if (usesPersist(source) && !hasPartializeField(source)) {
      violations.push(`${entry.relativePath}: persist store is missing partialize`)
    }
  }

  if (violations.length === 0) {
    if (addedFiles.length === 0) {
      const hint = cli.baseRef
        ? `自 ${cli.baseRef} 以来没有新增 store 文件。`
        : '当前工作区没有新增 store 文件；如需检查分支增量，请传 --base-ref。'
      console.log(`[check-store-conventions] ${hint}`)
    } else {
      const mode = cli.staged
        ? '已暂存新增文件'
        : (cli.baseRef ? `自 ${cli.baseRef} 以来的新增文件` : '当前工作区新增文件')
      console.log(`[check-store-conventions] 检查通过：${mode}。`)
    }
    return
  }

  console.error('[check-store-conventions] 发现以下违规项：')
  for (const violation of violations) {
    console.error(`- ${violation}`)
  }
  process.exit(1)
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[check-store-conventions] 执行失败：${message}`)
  process.exit(1)
}
