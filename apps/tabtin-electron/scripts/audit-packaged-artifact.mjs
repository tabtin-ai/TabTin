#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const MAX_HITS_PER_RULE = 50
const TEXT_SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.css', '.html'])
const SECRET_SCAN_EXTENSIONS = new Set([
  '.cjs', '.env', '.html', '.js', '.json', '.key', '.mjs', '.pem', '.properties',
  '.sh', '.txt', '.yaml', '.yml',
])
export const REQUIRED_PACKAGED_ARTIFACT_SIGNAL_RULES = [
  {
    name: 'glass overlay background token',
    signals: ['glass-bg-overlay'],
  },
  {
    name: 'overlay backdrop blur utility',
    signals: ['overlay-backdrop-blur'],
  },
  {
    name: 'TabDoc cover crop artifact signal ',
    signals: ['coverCropTitle', 'coverCropDragLabel', '调整封面取景', '拖动封面调整取景', 'coverPositionX'],
  },
]

function parseArgs(argv) {
  const parsed = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (current === '--') {
      continue
    }
    if (!current.startsWith('--')) {
      parsed._.push(current)
      continue
    }
    const key = current.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      parsed[key] = 'true'
      continue
    }
    parsed[key] = value
    index += 1
  }
  return parsed
}

function walkFiles(root) {
  const out = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || !existsSync(current)) continue
    const st = statSync(current)
    if (st.isDirectory()) {
      for (const entry of readdirSync(current)) {
        stack.push(join(current, entry))
      }
    } else if (st.isFile()) {
      out.push(current)
    }
  }
  return out
}

function findFiles(root, predicate) {
  if (!existsSync(root)) return []
  return walkFiles(root).filter(predicate)
}

function findFirst(root, predicate) {
  if (!existsSync(root)) return undefined
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    const st = statSync(current)
    if (predicate(current, st)) return current
    if (st.isDirectory()) {
      for (const entry of readdirSync(current)) {
        stack.push(join(current, entry))
      }
    }
  }
  return undefined
}

function normalizePath(path) {
  return path.split(sep).join('/').replace(/\\/g, '/')
}

function isPackagedEnvFile(path) {
  const name = basename(normalizePath(path)).toLowerCase()
  return name === '.env' || name.startsWith('.env.') || name === 'secrets.env'
}

function shouldScanSecretContent(path) {
  return isPackagedEnvFile(path) || SECRET_SCAN_EXTENSIONS.has(extname(path).toLowerCase())
}

const PRIVATE_KEY_HEADER_RE = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/
const PRIVATE_KEY_PEM_BLOCK_RE =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\s]{32,}-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/

function looksLikeEmbeddedPrivateKey(path, text) {
  if (PRIVATE_KEY_PEM_BLOCK_RE.test(text)) {
    return true
  }
  const ext = extname(normalizePath(path)).toLowerCase()
  // .pem/.key 只要出现 PEM 头就拦；JS 依赖里出现头字符串（如 jose 解析器）不算私钥。
  return ['.pem', '.key', '.p8'].includes(ext) && PRIVATE_KEY_HEADER_RE.test(text)
}

export function findPackagedSecretMaterial(entries) {
  const findings = []

  for (const entry of entries) {
    const path = normalizePath(entry.path)
    const text = typeof entry.text === 'string' ? entry.text : ''

    if (isPackagedEnvFile(path)) findings.push({ path, rule: 'env-file' })
    if (looksLikeEmbeddedPrivateKey(path, text)) {
      findings.push({ path, rule: 'private-key' })
    }
    if (
      /(?:SOURCEMAP_UPLOAD_KEY|SENTRY_AUTH_TOKEN)\s*=\s*["']?[A-Za-z0-9][A-Za-z0-9._-]{15,}/.test(text) ||
      /\bsntry[su]_[A-Za-z0-9._-]{16,}\b/.test(text)
    ) {
      findings.push({ path, rule: 'upload-token' })
    }
  }

  return findings
}

function readAsarHeader(asarPath) {
  const fd = readFileSync(asarPath)
  if (fd.length < 16) {
    throw new Error(`app.asar too small: ${asarPath}`)
  }

  const pickleHeaderSize = fd.readUInt32LE(0)
  let jsonStart
  let jsonEnd
  let dataOffset

  if (pickleHeaderSize === 4) {
    const payloadSize = fd.readUInt32LE(4)
    const headerSize = fd.readUInt32LE(12)
    jsonStart = 16
    jsonEnd = jsonStart + headerSize
    dataOffset = 8 + payloadSize
  } else {
    const headerStart = 4
    const headerEnd = headerStart + pickleHeaderSize
    if (headerEnd > fd.length) {
      throw new Error(`invalid app.asar header size: ${pickleHeaderSize}`)
    }
    const pickle = fd.subarray(headerStart, headerEnd)
    const jsonSize = pickle.readUInt32LE(4)
    jsonStart = headerStart + 8
    jsonEnd = jsonStart + jsonSize
    dataOffset = headerEnd
  }

  if (jsonEnd > fd.length || dataOffset > fd.length) {
    throw new Error(`invalid app.asar header bounds: jsonEnd=${jsonEnd}, dataOffset=${dataOffset}, size=${fd.length}`)
  }

  const header = JSON.parse(fd.subarray(jsonStart, jsonEnd).toString('utf8'))
  const files = []

  function visit(node, prefix) {
    for (const [name, child] of Object.entries(node.files || {})) {
      const nextPath = prefix ? `${prefix}/${name}` : name
      if (child.files) {
        visit(child, nextPath)
      } else {
        files.push({
          path: nextPath,
          size: Number(child.size || 0),
          offset: child.offset == null ? undefined : Number(child.offset),
        })
      }
    }
  }

  visit(header, '')
  return { buffer: fd, dataOffset, files }
}

function readAsarEntry(asar, entry) {
  if (typeof entry.offset !== 'number' || !Number.isFinite(entry.offset)) return Buffer.alloc(0)
  return asar.buffer.subarray(asar.dataOffset + entry.offset, asar.dataOffset + entry.offset + entry.size)
}

function isSkillAttachmentExamplesPath(path) {
  const normalized = normalizePath(path).toLowerCase()
  if (/\/skills\/[^/]+\/examples(\/|$)/.test(normalized)) return true
  if (normalized.includes('/bundled-skills/') && /\/examples(\/|$)/.test(normalized)) return true
  if (normalized.includes('/package-skills/') && /\/examples(\/|$)/.test(normalized)) return true
  return false
}

export function hasForbiddenDirectory(path) {
  const normalized = normalizePath(path)
  const allowSkillExamples = isSkillAttachmentExamplesPath(normalized)
  const parts = normalized.split('/').map((part) => part.toLowerCase())
  return parts.some((part) => {
    if (allowSkillExamples && part === 'examples') return false
    return (
      part === '__tests__' ||
      part === 'test' ||
      part === 'tests' ||
      part === 'example' ||
      part === 'examples' ||
      part === 'benchmark' ||
      part === 'benchmarks' ||
      part === 'browser-test' ||
      part === 'system-test' ||
      part === 'fixture' ||
      part === 'fixtures' ||
      part === '.pytest_cache' ||
      part === '.github'
    )
  })
}

function isForbiddenSourceFile(path) {
  const lower = path.toLowerCase()
  if (lower.endsWith('.tsbuildinfo')) return true
  if (lower.endsWith('.map')) return true
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return true
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(lower)) return true
  if (/\/playwright\.config\.[cm]?[jt]s$/.test(lower)) return true
  return false
}

function isForbiddenTemplateSource(path) {
  const lower = path.toLowerCase()
  return lower.includes('tabsite-templates/') && (
    lower.includes('/src/') ||
    lower.endsWith('/vite.config.ts') ||
    lower.endsWith('/tsconfig.json')
  )
}

export function isNestedBuildOutputPath(path) {
  const normalized = normalizePath(path).toLowerCase()
  return normalized === 'app.asar/out/out' || normalized.startsWith('app.asar/out/out/')
}

export function shouldBlockSourceMapReference(path) {
  const normalized = normalizePath(path).toLowerCase()
  // Third-party package sourceMappingURL comments are noisy and expensive to
  // rewrite on Windows. The .map files themselves are still removed; blocking
  // here focuses the policy on first-party packaged code and app resources.
  return !normalized.includes('/node_modules/')
}

/**
 * True only for emitted public map links (path ending in .map, or data: URL).
 * Rejects TypeScript/Monaco worker codegen like writeComment(`//# sourceMappingURL=${ce}`)
 * and quote-state desync leftovers on minified single-line bundles .
 */
export function isEmittedSourceMapComment(comment) {
  const lineMatch = comment.match(/^\/\/[#@]\s*sourceMappingURL=(\S*)/)
  const blockMatch = comment.match(/^\/\*[#@]\s*sourceMappingURL=(\S*?)(?:\s*\*\/)?\s*$/)
  const url = (lineMatch || blockMatch)?.[1] || ''
  if (!url || /\$\{/.test(url) || /[`'"()]/.test(url)) return false
  return url.startsWith('data:') || /\.map(?:$|\?)/.test(url)
}

export function hasPublicSourceMapReference(text) {
  // Scan comments instead of raw text: TypeScript's worker contains the literal
  // `writeComment("//# sourceMappingURL=...")`, which is code, not a public map link.
  let quote = null
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (quote === '`' && char === '$' && text[index + 1] === '{') {
        // Enter ${...} so nested quotes/backticks do not close the outer template early.
        index += 2
        let depth = 1
        let exprQuote = null
        let exprEscaped = false
        for (; index < text.length; index += 1) {
          const exprChar = text[index]
          if (exprQuote) {
            if (exprEscaped) {
              exprEscaped = false
            } else if (exprChar === '\\') {
              exprEscaped = true
            } else if (exprChar === exprQuote) {
              exprQuote = null
            }
            continue
          }
          if (exprChar === '"' || exprChar === "'" || exprChar === '`') {
            exprQuote = exprChar
            continue
          }
          if (exprChar === '{') depth += 1
          else if (exprChar === '}') {
            depth -= 1
            if (depth === 0) break
          }
        }
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char !== '/') continue

    const next = text[index + 1]
    if (next === '/') {
      const end = text.indexOf('\n', index + 2)
      const comment = text.slice(index, end === -1 ? text.length : end)
      if (isEmittedSourceMapComment(comment)) return true
      index = end === -1 ? text.length : end
    } else if (next === '*') {
      const end = text.indexOf('*/', index + 2)
      const comment = text.slice(index, end === -1 ? text.length : end + 2)
      if (isEmittedSourceMapComment(comment)) return true
      index = end === -1 ? text.length : end + 1
    }
  }
  return false
}

// Worker threads 的 ESM loader 无法从 asar 虚拟文件系统加载脚本，因此 out/main/*.mjs
// 全量 unpack（见 package.json build.asarUnpack）。unpacked 文件的相对 import 也必须
// 落在 unpacked 目录内，否则打包版 worker 启动即 ERR_MODULE_NOT_FOUND（#3767：
// worker 引用共享 chunk protocol-*.mjs，但 chunk 留在 asar 里）。
// 只认 .mjs 结尾的 specifier：Rollup chunkFileNames=[name]-[hash].mjs，chunk 间真实
// 相对引用必以 .mjs 收尾；不带后缀的相对路径全是第三方 bundle 内嵌字符串（误报源）。
export function extractRelativeEsmImports(text) {
  const specifiers = new Set()
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+\.mjs)["']/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    specifiers.add(match[1])
  }
  return [...specifiers]
}

/** Literal ESM imports only. Rollup's output must not resolve product dependencies at runtime. */
export function extractEsmImportSpecifiers(text) {
  const specifiers = new Set()
  const source = String(text || '')
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') index += 2
        else if (source[index] === quote) {
          index += 1
          break
        } else index += 1
      }
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index + 2)
      if (index === -1) break
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end === -1 ? source.length : end + 2
      continue
    }
    if (
      source.startsWith('import', index) &&
      !/[\w$]/.test(source[index - 1] || '') &&
      !/[\w$]/.test(source[index + 6] || '')
    ) {
      const statementEnd = source.indexOf(';', index + 6)
      const statement = source.slice(index, statementEnd === -1 ? source.length : statementEnd)
      const match = statement.match(/^import\s*(?:\(\s*)?["']([^"']+)["']/) ||
        statement.match(/\bfrom\s*["']([^"']+)["']/)
      if (match) specifiers.add(match[1])
      index += 6
      continue
    }
    index += 1
  }
  return [...specifiers]
}

export function extractLiteralRuntimeSpecifiers(text) {
  const source = String(text || '')
  const specifiers = new Set(extractEsmImportSpecifiers(source))
  const pattern = /\brequire(?:\.resolve)?\(\s*["']([^"']+)["']\s*\)/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    specifiers.add(match[1])
  }

  const createRequireFactories = new Set(['createRequire'])
  const namedImportPattern = /\bimport\s*\{([^}]+)\}\s*from\s*(['"])node:module\2/g
  while ((match = namedImportPattern.exec(source)) !== null) {
    for (const binding of match[1].split(',')) {
      const bindingMatch = binding.trim().match(/^createRequire(?:\s+as\s+([A-Za-z_$][\w$]*))?$/)
      if (bindingMatch) createRequireFactories.add(bindingMatch[1] || 'createRequire')
    }
  }

  const requireAliases = new Set()
  for (const factory of createRequireFactories) {
    const escapedFactory = factory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const aliasPattern = new RegExp(
      `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escapedFactory}\\s*\\(`,
      'g',
    )
    let aliasMatch
    while ((aliasMatch = aliasPattern.exec(source)) !== null) {
      requireAliases.add(aliasMatch[1])
    }
  }
  for (const alias of requireAliases) {
    const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const callPattern = new RegExp(
      `\\b${escapedAlias}(?:\\.resolve)?\\s*\\(\\s*(['"])([^'"]+)\\1`,
      'g',
    )
    let callMatch
    while ((callMatch = callPattern.exec(source)) !== null) {
      specifiers.add(callMatch[2])
    }
  }
  return [...specifiers]
}

const NODE_BUILTIN_SPECIFIERS = new Set(
  builtinModules.flatMap((specifier) => [specifier, specifier.replace(/^node:/, '')]),
)

// Packaged utility processes run inside Electron, not the Node version that happens to
// execute this audit. Electron 41 embeds Node 24, where node:sqlite is a built-in, while
// older packaging hosts do not report this experimental module via builtinModules.
const ELECTRON_RUNTIME_BUILTIN_SPECIFIERS = new Set(['sqlite'])

export function isNodeBuiltinSpecifier(specifier, hostBuiltinSpecifiers = NODE_BUILTIN_SPECIFIERS) {
  const normalized = String(specifier || '').replace(/^node:/, '')
  return hostBuiltinSpecifiers.has(normalized) || ELECTRON_RUNTIME_BUILTIN_SPECIFIERS.has(normalized)
}

function packageNameFromSpecifier(specifier) {
  const parts = String(specifier || '').split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

const OPTIONAL_RUNTIME_SPECIFIER_ALTERNATIVES = new Map([
  ['react-pdf/package.json', ['pdfjs-dist']],
])

export function findUnresolvedPackagedRuntimeImports(codeFiles, availablePaths) {
  const normalizedPaths = (availablePaths || []).map((path) => normalizePath(path))
  const hasPackagedModule = (packageName) => {
    const packagePrefix = `node_modules/${packageName}/`
    return normalizedPaths.some((candidate) => candidate.startsWith(packagePrefix))
  }
  const issues = []
  for (const { path, text } of codeFiles || []) {
    for (const specifier of extractLiteralRuntimeSpecifiers(text)) {
      if (
        specifier.startsWith('./') ||
        specifier.startsWith('../') ||
        specifier.startsWith('/') ||
        specifier === 'electron' ||
        isNodeBuiltinSpecifier(specifier)
      ) continue

      const packageName = packageNameFromSpecifier(specifier)
      const packagedAlternative = (OPTIONAL_RUNTIME_SPECIFIER_ALTERNATIVES.get(specifier) || [])
        .some(hasPackagedModule)
      if (!hasPackagedModule(packageName) && !packagedAlternative) {
        issues.push(`${normalizePath(path)} → missing runtime package ${JSON.stringify(packageName)} (${specifier})`)
      }
    }
  }
  return issues
}

/**
 * Stripe OAuth uses this utility-process entry. Its complete ESM import graph must live in
 * app.asar.unpacked and may only depend on relative chunks plus Electron's Node built-ins.
 * Otherwise a clean user machine would need npm/npx or an independently installed mcp-remote.
 *
 * @param {string[]} unpackedPaths paths relative to app.asar.unpacked
 * @param {(path: string) => string} readText
 */
export function findBundledMcpRemoteHostIssues(unpackedPaths, readText) {
  const entryPath = 'out/main/mcp-remote-host-process.mjs'
  const normalizedPaths = new Set(unpackedPaths.map((path) => normalizePath(path).replace(/^\//, '')))
  if (!normalizedPaths.has(entryPath)) {
    return [`missing app.asar.unpacked/${entryPath}`]
  }

  const issues = []
  const pending = [entryPath]
  const visited = new Set()
  while (pending.length > 0) {
    const currentPath = pending.pop()
    if (!currentPath || visited.has(currentPath)) continue
    visited.add(currentPath)

    const text = readText(currentPath)
    for (const specifier of extractEsmImportSpecifiers(text)) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const targetPath = resolveRelativeSpecifier(currentPath, specifier)
        if (!normalizedPaths.has(targetPath)) {
          issues.push(`${currentPath} → missing ${specifier}`)
        } else if (extname(targetPath).toLowerCase() === '.mjs') {
          pending.push(targetPath)
        }
        continue
      }
      if (!isNodeBuiltinSpecifier(specifier)) {
        issues.push(`${currentPath} → bare runtime import ${JSON.stringify(specifier)}`)
      }
    }
  }
  return issues
}

/** Relative .js imports used by workspace package dist (tsup chunks), e.g. `./chunk-E3XO57H6.js`. */
export function extractRelativeJsImports(text) {
  const specifiers = new Set()
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+\.js)["']/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    specifiers.add(match[1])
  }
  return [...specifiers]
}

export function resolveRelativeSpecifier(fromPath, specifier) {
  const normalizedFrom = String(fromPath || '').replace(/\\/g, '/').replace(/^\//, '')
  const dirParts = normalizedFrom.split('/')
  dirParts.pop()
  const parts = String(specifier || '').split('/')
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') dirParts.pop()
    else dirParts.push(part)
  }
  return dirParts.join('/')
}

/**
 * asar 内 @tabtin/<pkg>/dist entry 引用的相对 .js（含 tsup chunk）必须存在。
 * @param {string[]} asarPaths paths inside app.asar (no app.asar/ prefix)
 * @param {(path: string) => string} readText load file contents by asar path
 */
export function findUnresolvedTabtinDistRelativeImports(asarPaths, readText) {
  const present = new Set(
    (asarPaths || []).map((p) => String(p || '').replace(/\\/g, '/').replace(/^\//, '')),
  )
  const unresolved = []
  for (const entryPath of present) {
    if (!entryPath.startsWith('node_modules/@tabtin/')) continue
    if (!/\/dist\/[^/]+\.js$/.test(entryPath)) continue
    if (/(^|\/)chunk-[^/]+\.js$/.test(entryPath)) continue
    let text = ''
    try {
      text = String(readText(entryPath) || '')
    } catch {
      continue
    }
    for (const specifier of extractRelativeJsImports(text)) {
      const resolved = resolveRelativeSpecifier(entryPath, specifier)
      if (!present.has(resolved)) {
        unresolved.push(`${entryPath} → ${specifier}`)
      }
    }
  }
  return unresolved
}

export function shouldRequirePackagedPythonRuntime(profile) {
  const normalizedProfile = String(profile || '').toLowerCase()
  return normalizedProfile === 'preprod' || normalizedProfile === 'production'
}

export function packagedPythonRuntimePlatform(target, arch) {
  const normalizedTarget = String(target || '').toLowerCase()
  const normalizedArch = normalizeTargetArch(arch) || String(arch || '').toLowerCase()
  if (!normalizedArch) return ''
  if (normalizedTarget === 'mac' || normalizedTarget === 'darwin') return `darwin-${normalizedArch}`
  if (normalizedTarget === 'win' || normalizedTarget === 'windows' || normalizedTarget === 'win32') {
    return `win32-${normalizedArch}`
  }
  if (normalizedTarget === 'linux') return `linux-${normalizedArch}`
  return ''
}

export function findMissingPackagedPythonRuntime(paths, options = {}) {
  const normalized = (paths || []).map((path) => normalizePath(path))
  const manifestPath = normalized.find((path) => /(^|\/)native\/tabtin-python-runtime\/manifest\.json$/.test(path))
  if (!manifestPath) {
    return ['native/tabtin-python-runtime/manifest.json']
  }

  const readText = typeof options.readText === 'function' ? options.readText : null
  if (!readText) {
    return [`${manifestPath} (unable to read manifest)`]
  }

  let manifest
  try {
    manifest = JSON.parse(String(readText(manifestPath) || ''))
  } catch {
    return [`${manifestPath} (invalid JSON)`]
  }

  const platform = packagedPythonRuntimePlatform(options.target, options.arch)
  const entry = platform && manifest?.platforms?.[platform]
  const archiveName = typeof entry?.archiveName === 'string' ? entry.archiveName : ''
  if (!archiveName) {
    return [
      platform
        ? `${manifestPath} (missing platforms.${platform}.archiveName)`
        : `${manifestPath} (unable to resolve target platform for archiveName)`,
    ]
  }

  const archivePath = `native/tabtin-python-runtime/${archiveName}`
  if (!normalized.some((path) => path === archivePath || path.endsWith(`/${archivePath}`))) {
    return [archivePath]
  }
  return []
}

export function shouldBlockEmbeddedOfficeRuntime(_target, profile) {
  const normalizedProfile = String(profile || '').toLowerCase()
  const isDistributableProfile = normalizedProfile === 'preprod' || normalizedProfile === 'production'
  return (
    isDistributableProfile &&
    process.env.TABTIN_ENABLE_PACKAGED_OFFICE_PREVIEW_RUNTIME !== '1'
  )
}

export function shouldBlockMacNonDarwinNativePath(path) {
  const normalized = normalizePath(path).toLowerCase()
  if (normalized.includes('/node_modules/@nut-tree-fork/libnut-linux/')) return true
  if (normalized.includes('/node_modules/@nut-tree-fork/libnut-win32/')) return true
  if (normalized.endsWith('.dll') || normalized.endsWith('.exe')) return true
  return false
}

function createRequiredArtifactSignalTracker(rules = REQUIRED_PACKAGED_ARTIFACT_SIGNAL_RULES) {
  const hits = new Map()

  return {
    scan(path, text) {
      if (!text) return
      for (const rule of rules) {
        if (hits.has(rule.name)) continue
        const matched = rule.signals.find((signal) => text.includes(signal))
        if (matched) {
          hits.set(rule.name, { signal: matched, path })
        }
      }
    },
    missing() {
      return rules
        .filter((rule) => !hits.has(rule.name))
        .map((rule) => `${rule.name}: expected one of ${rule.signals.join(', ')}`)
    },
    summary() {
      return rules
        .map((rule) => {
          const hit = hits.get(rule.name)
          return hit
            ? `${rule.name}=${hit.signal} (${hit.path})`
            : `${rule.name}=missing`
        })
        .join('; ')
    },
  }
}

export function findMissingRequiredArtifactSignals(texts, rules = REQUIRED_PACKAGED_ARTIFACT_SIGNAL_RULES) {
  const tracker = createRequiredArtifactSignalTracker(rules)
  const list = Array.isArray(texts) ? texts : [texts]
  list.forEach((text, index) => tracker.scan(`text[${index}]`, String(text || '')))
  return tracker.missing()
}

function scanRequiredArtifactSignals({ asar, appAsarPath, unpackedRoot, resourcesRoot }) {
  const tracker = createRequiredArtifactSignalTracker()

  for (const entry of asar.files) {
    if (!TEXT_SCAN_EXTENSIONS.has(extname(entry.path).toLowerCase())) continue
    tracker.scan(`app.asar/${entry.path}`, readAsarEntry(asar, entry).toString('utf8'))
  }

  for (const path of existsSync(unpackedRoot) ? walkFiles(unpackedRoot) : []) {
    if (!TEXT_SCAN_EXTENSIONS.has(extname(path).toLowerCase())) continue
    tracker.scan(normalizePath(`app.asar.unpacked/${relative(unpackedRoot, path)}`), readFileSync(path, 'utf8'))
  }

  for (const path of walkFiles(resourcesRoot)) {
    if (path === appAsarPath || path.startsWith(unpackedRoot)) continue
    if (!TEXT_SCAN_EXTENSIONS.has(extname(path).toLowerCase())) continue
    tracker.scan(normalizePath(relative(resourcesRoot, path)), readFileSync(path, 'utf8'))
  }

  return {
    missing: tracker.missing(),
    summary: tracker.summary(),
  }
}

function shouldAuditMacNativePayload(target) {
  const normalizedTarget = String(target || '').toLowerCase()
  return normalizedTarget === 'mac' || normalizedTarget === 'darwin'
}

export function shouldAuditWindowsNativePayload(target) {
  const normalizedTarget = String(target || '').toLowerCase()
  return normalizedTarget === 'win' || normalizedTarget === 'windows' || normalizedTarget === 'win32'
}

// -----------------------------------------------------------------------------
// macOS 目标架构原生资产校验
//
// macOS 按 CPU 架构分「双包」（arm64 / x64）。多个原生依赖按架构分包，
// cross-build（如 arm64 机器打 x64 包）时目标架构的原生二进制可能整体缺失，
// 或架构错误（x64 包里躺着 arm64 的 .node）。这里在 mac 目标构建时校验：
//   1. 关键原生资产是否存在；
//   2. 其 Mach-O 架构是否与目标架构一致。
// 架构判定不 shell out `file`（要能在 CI / 无 file 命令环境跑），直接读文件头。
// -----------------------------------------------------------------------------

const CPU_TYPE_X86_64 = 0x01000007
const CPU_TYPE_ARM64 = 0x0100000c
const MH_MAGIC_64 = 0xfeedfacf
const MH_CIGAM_64 = 0xcffaedfe
const MH_MAGIC = 0xfeedface
const MH_CIGAM = 0xcefaedfe
const FAT_MAGIC = 0xcafebabe
const FAT_CIGAM = 0xbebafeca

/**
 * 读 Mach-O 文件头判定架构，返回 'x64' | 'arm64' | 'universal' | 'unknown'。
 * - fat / universal（magic 0xcafebabe / 0xbebafeca）→ 'universal'（含目标 arch，接受）
 * - thin Mach-O：读 cputype，x86_64=0x01000007 → 'x64'，arm64=0x0100000C → 'arm64'
 * - 其余（非 Mach-O / 头不完整）→ 'unknown'
 */
export function machoArchOf(buffer) {
  if (!buffer || buffer.length < 8) return 'unknown'
  const beMagic = buffer.readUInt32BE(0)
  const leMagic = buffer.readUInt32LE(0)

  // fat / universal 头以大端存储 magic；两种字节序都接受。
  if (beMagic === FAT_MAGIC || beMagic === FAT_CIGAM) return 'universal'

  let cputype
  if (leMagic === MH_MAGIC_64 || leMagic === MH_MAGIC) {
    // 现代 darwin 原生二进制：小端 magic，cputype 同为小端。
    cputype = buffer.readUInt32LE(4)
  } else if (beMagic === MH_MAGIC_64 || beMagic === MH_MAGIC) {
    cputype = buffer.readUInt32BE(4)
  } else if (leMagic === MH_CIGAM_64 || leMagic === MH_CIGAM) {
    cputype = buffer.readUInt32BE(4)
  } else if (beMagic === MH_CIGAM_64 || beMagic === MH_CIGAM) {
    cputype = buffer.readUInt32LE(4)
  } else {
    return 'unknown'
  }

  if (cputype === CPU_TYPE_X86_64) return 'x64'
  if (cputype === CPU_TYPE_ARM64) return 'arm64'
  return 'unknown'
}

/** 归一化各种 arch 写法到 'x64' | 'arm64'，无法识别返回 undefined。 */
export function normalizeTargetArch(value) {
  const normalized = String(value || '').toLowerCase().trim()
  if (normalized === 'x64' || normalized === 'x86_64' || normalized === 'amd64' || normalized === 'intel') {
    return 'x64'
  }
  if (
    normalized === 'arm64' ||
    normalized === 'aarch64' ||
    normalized === 'apple' ||
    normalized === 'silicon' ||
    normalized === 'apple-silicon'
  ) {
    return 'arm64'
  }
  return undefined
}

/**
 * 打包 audit 用：判断 tabtin-filegen 是否匹配目标 arch。
 * actualArch 来自 machoArchOf。
 */
export function evaluateMacPackagedFilegen({
  exists,
  executable,
  actualArch,
  targetArch,
  relPath,
  profile,
}) {
  const required = profile === 'preprod' || profile === 'production'
  if (!exists) {
    return {
      level: required ? 'critical' : 'warning',
      hits: [`缺少内置 tabtin-filegen：${relPath}`],
    }
  }
  const hits = []
  if (!executable) {
    hits.push(`tabtin-filegen 不可执行：${relPath}`)
  }
  if (actualArch === 'unknown') {
    hits.push(`无法识别 tabtin-filegen Mach-O 架构：${relPath}`)
  } else if (actualArch !== 'universal' && actualArch !== targetArch) {
    hits.push(`tabtin-filegen 架构不匹配：${relPath} 期望 ${targetArch} 实为 ${actualArch}`)
  }
  return { level: 'critical', hits }
}

/**
 * 关键原生资产清单（在 app.asar.unpacked/node_modules/ 下）。可配置区分「必需」与「可选」：
 * - required=true → 缺失即 critical fail（避免重演 ：Intel 包缺 ripgrep-darwin-x64）
 * - required=false → 整个依赖没装按 warning（产品裁剪，不误伤），但装了却坏（缺架构目录 /
 *   架构不匹配）仍按 critical。
 * 规格字段：
 * - pkgDir(arch)：其存在与否表示「依赖是否安装」
 * - files(arch)：需按名精确校验的 Mach-O 文件（相对 pkgDir），可标 executable
 * - archDir(arch)：架构编码在子目录里（如 onnxruntime / node-pty），该子目录须存在；支持单段 `*` 通配
 * - scan：在定位目录下扫描 .node/.dylib/rg 并逐个校验架构
 * - scanMustFind：已安装却扫不到任何原生二进制时是否算失败（架构名包已装却空 → true）
 */
export const MAC_NATIVE_ARCH_ASSET_SPECS = [
  {
    id: '@vscode/ripgrep ',
    required: true,
    pkgDir: (arch) => `@vscode/ripgrep-darwin-${arch}`,
    files: () => [{ rel: 'bin/rg', executable: true }],
  },
  {
    id: '@img/sharp',
    required: false,
    pkgDir: (arch) => `@img/sharp-darwin-${arch}`,
    scan: true,
    scanMustFind: true,
  },
  {
    id: '@napi-rs/canvas',
    required: false,
    pkgDir: (arch) => `@napi-rs/canvas-darwin-${arch}`,
    scan: true,
    scanMustFind: true,
  },
  {
    id: 'onnxruntime-node',
    required: false,
    pkgDir: () => 'onnxruntime-node',
    archDir: (arch) => `bin/napi-*/darwin/${arch}`,
    scan: true,
    scanMustFind: false,
  },
  {
    id: 'node-pty',
    required: false,
    pkgDir: () => 'node-pty',
    archDir: (arch) => `prebuilds/darwin-${arch}`,
    // : 打包产物没有 build/Release（--ignore-scripts 跳过 electron-rebuild），
    // 运行时用的就是 prebuilds 里的 spawn-helper；缺 exec 位 → posix_spawnp EACCES
    // → 打包版终端秒退。此处强校验存在 + 可执行 + 架构匹配。
    files: (arch) => [{ rel: `prebuilds/darwin-${arch}/spawn-helper`, executable: true }],
    scan: true,
    scanMustFind: false,
  },
]

export const WINDOWS_NATIVE_ASSET_SPECS = [
  {
    id: 'node-pty',
    required: true,
    pkgDir: () => 'node-pty',
    files: (arch) => [{ rel: `prebuilds/win32-${arch}/conpty.node` }],
  },
]

/**
 * 纯决策函数：给定 spec、目标 arch 与已解析的 presence，判定该资产是 ok / warning / critical。
 * presence 字段：
 * - installed：依赖是否安装（pkgDir 是否存在）
 * - archPayloadPresent：spec.archDir 对应的架构子目录是否存在（无 archDir 时为 undefined）
 * - machoFiles：[{ path, arch }]，arch 由 machoArchOf 得出
 * - missingFiles：files 中期望却不存在的路径
 * - nonExecutable：标了 executable 却不可执行的路径
 */
export function classifyMacNativeAsset(spec, arch, presence) {
  const messages = []

  if (!presence.installed) {
    return {
      level: spec.required ? 'critical' : 'warning',
      messages: [
        spec.required
          ? `缺少必需原生依赖：${spec.pkgDir(arch)}（目标架构 ${arch}）`
          : `未打入可选原生依赖：${spec.pkgDir(arch)}（目标架构 ${arch}，按裁剪处理）`,
      ],
    }
  }

  if (spec.archDir && presence.archPayloadPresent === false) {
    return {
      level: 'critical',
      messages: [`已安装但缺目标架构目录：${spec.pkgDir(arch)}/${spec.archDir(arch)}`],
    }
  }

  for (const path of presence.missingFiles ?? []) {
    messages.push(`缺少关键资产：${path}`)
  }
  for (const path of presence.nonExecutable ?? []) {
    messages.push(`关键资产不可执行：${path}`)
  }

  const machoFiles = presence.machoFiles ?? []
  if (
    spec.scanMustFind &&
    machoFiles.length === 0 &&
    (presence.missingFiles ?? []).length === 0
  ) {
    messages.push(`已安装但未找到任何原生二进制（.node/.dylib）：${spec.pkgDir(arch)}`)
  }

  for (const file of machoFiles) {
    if (file.arch === 'unknown') {
      messages.push(`无法识别 Mach-O 架构：${file.path}`)
    } else if (file.arch !== 'universal' && file.arch !== arch) {
      messages.push(`架构不匹配：${file.path} 期望 ${arch} 实为 ${file.arch}`)
    }
  }

  return { level: messages.length > 0 ? 'critical' : 'ok', messages }
}

function resolveMacNativeAssetPresence(spec, arch, io) {
  const pkgDir = spec.pkgDir(arch)
  if (!io.dirExists(pkgDir)) return { installed: false }

  const presence = { installed: true, machoFiles: [], missingFiles: [], nonExecutable: [] }

  if (spec.files) {
    for (const file of spec.files(arch)) {
      const rel = `${pkgDir}/${file.rel}`
      if (!io.fileExists(rel)) {
        presence.missingFiles.push(rel)
        continue
      }
      if (file.executable && !io.isExecutable(rel)) {
        presence.nonExecutable.push(rel)
      }
      presence.machoFiles.push({ path: rel, arch: machoArchOf(io.readHead(rel)) })
    }
  }

  let scanDirs = [pkgDir]
  if (spec.archDir) {
    scanDirs = io.resolveArchDirs(pkgDir, spec.archDir(arch))
    presence.archPayloadPresent = scanDirs.length > 0
  }

  if (spec.scan) {
    for (const dir of scanDirs) {
      for (const filePath of io.listMachoFiles(dir)) {
        presence.machoFiles.push({ path: filePath, arch: machoArchOf(io.readHead(filePath)) })
      }
    }
  }

  return presence
}

/**
 * 遍历清单，聚合 critical / warning 命中。io 为可注入的文件系统访问器（便于单测）。
 */
export function evaluateMacNativeArchAssets(arch, io, specs = MAC_NATIVE_ARCH_ASSET_SPECS) {
  const criticalHits = []
  const warningHits = []
  for (const spec of specs) {
    const presence = resolveMacNativeAssetPresence(spec, arch, io)
    const { level, messages } = classifyMacNativeAsset(spec, arch, presence)
    const decorated = messages.map((message) => `[${spec.id}] ${message}`)
    if (level === 'critical') criticalHits.push(...decorated)
    else if (level === 'warning') warningHits.push(...decorated)
  }
  return { criticalHits, warningHits }
}

function resolveWindowsNativeAssetPresence(spec, arch, io) {
  const pkgDir = spec.pkgDir(arch)
  if (!io.dirExists(pkgDir)) return { installed: false }

  const presence = { installed: true, missingFiles: [] }
  for (const file of spec.files?.(arch) ?? []) {
    const rel = `${pkgDir}/${file.rel}`
    if (!io.fileExists(rel)) {
      presence.missingFiles.push(rel)
    }
  }
  return presence
}

export function evaluateWindowsNativeAssets(arch, io, specs = WINDOWS_NATIVE_ASSET_SPECS) {
  const criticalHits = []
  const warningHits = []
  for (const spec of specs) {
    const presence = resolveWindowsNativeAssetPresence(spec, arch, io)
    const messages = []
    if (!presence.installed) {
      messages.push(
        spec.required
          ? `缺少必需原生依赖：${spec.pkgDir(arch)}（目标架构 ${arch}）`
          : `未打入可选原生依赖：${spec.pkgDir(arch)}（目标架构 ${arch}，按裁剪处理）`,
      )
    } else {
      for (const path of presence.missingFiles ?? []) {
        messages.push(`缺少关键资产：${path}`)
      }
    }
    const decorated = messages.map((message) => `[${spec.id}] ${message}`)
    if (spec.required) criticalHits.push(...decorated)
    else warningHits.push(...decorated)
  }
  return { criticalHits, warningHits }
}

function readHeadBytes(absPath, length = 32) {
  let fd
  try {
    fd = openSync(absPath, 'r')
    const buffer = Buffer.alloc(length)
    const bytesRead = readSync(fd, buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // ignore close failures
      }
    }
  }
}

function isMachoFileName(path) {
  const name = basename(path).toLowerCase()
  return name === 'rg' || name.endsWith('.node') || name.endsWith('.dylib')
}

function matchArchSegment(segment) {
  if (!segment.includes('*')) return (name) => name === segment
  const escaped = segment
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  const re = new RegExp(`^${escaped}$`)
  return (name) => re.test(name)
}

function resolveArchDirs(nmRoot, pkgDir, pattern) {
  const segments = pattern.split('/').filter(Boolean)
  let current = [pkgDir]
  for (const segment of segments) {
    const matcher = matchArchSegment(segment)
    const next = []
    for (const relBase of current) {
      let entries = []
      try {
        entries = readdirSync(join(nmRoot, ...relBase.split('/')))
      } catch {
        entries = []
      }
      for (const name of entries) {
        if (!matcher(name)) continue
        const relChild = `${relBase}/${name}`
        try {
          if (statSync(join(nmRoot, ...relChild.split('/'))).isDirectory()) next.push(relChild)
        } catch {
          // ignore unreadable entries
        }
      }
    }
    current = next
  }
  return current
}

function createNativeArchIo(nmRoot) {
  const abs = (rel) => join(nmRoot, ...rel.split('/'))
  return {
    dirExists: (rel) => {
      try {
        return statSync(abs(rel)).isDirectory()
      } catch {
        return false
      }
    },
    fileExists: (rel) => {
      try {
        return statSync(abs(rel)).isFile()
      } catch {
        return false
      }
    },
    isExecutable: (rel) => {
      try {
        const st = statSync(abs(rel))
        return st.isFile() && (st.mode & 0o111) !== 0
      } catch {
        return false
      }
    },
    readHead: (rel) => readHeadBytes(abs(rel)),
    resolveArchDirs: (pkgDir, pattern) => resolveArchDirs(nmRoot, pkgDir, pattern),
    listMachoFiles: (relDir) =>
      findFiles(abs(relDir), (path) => isMachoFileName(path)).map((path) =>
        normalizePath(relative(nmRoot, path)),
      ),
  }
}

function inferMacTargetArch(appBundle) {
  if (!appBundle) return undefined
  const executable = findMacExecutable(appBundle)
  if (!executable) return undefined
  const arch = machoArchOf(readHeadBytes(executable))
  return arch === 'x64' || arch === 'arm64' ? arch : undefined
}

export function parseGoBuildInfo(output) {
  const values = {}
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\s*build\s+(GOOS|GOARCH|vcs\.revision)=(.+)$/)
    if (match) values[match[1]] = match[2].trim()
  }
  return {
    goos: values.GOOS || '',
    goarch: values.GOARCH || '',
    revision: values['vcs.revision'] || '',
  }
}

export function evaluatePackagedGoCliProvenance({
  buildInfo,
  expectedRevision,
  expectedGoos,
  expectedGoarch,
}) {
  const parsed = parseGoBuildInfo(buildInfo)
  const hits = []
  if (!parsed.revision) {
    hits.push('CLI 构建信息缺少 vcs.revision，无法证明来自当前 release')
  } else if (expectedRevision && parsed.revision !== expectedRevision) {
    hits.push(`CLI 源码版本不匹配：期望 ${expectedRevision}，实际 ${parsed.revision}`)
  }
  if (expectedGoos && parsed.goos !== expectedGoos) {
    hits.push(`CLI 目标系统不匹配：期望 ${expectedGoos}，实际 ${parsed.goos || 'unknown'}`)
  }
  if (expectedGoarch && parsed.goarch !== expectedGoarch) {
    hits.push(`CLI CPU 架构不匹配：期望 ${expectedGoarch}，实际 ${parsed.goarch || 'unknown'}`)
  }
  return hits
}

function normalizeGoTarget(target, arch) {
  const normalizedTarget = String(target || '').toLowerCase()
  const normalizedArch = String(arch || '').toLowerCase()
  return {
    goos: normalizedTarget === 'mac' || normalizedTarget === 'darwin'
      ? 'darwin'
      : normalizedTarget === 'win' || normalizedTarget === 'win32' || normalizedTarget === 'windows'
        ? 'windows'
        : normalizedTarget,
    goarch: normalizedArch === 'x64' ? 'amd64' : normalizedArch,
  }
}

function readGoBuildInfoWithRetries(binary) {
  let lastFailure = ''
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = spawnSync('go', ['version', '-m', binary], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    })
    if (result.status === 0 && result.stdout) return { output: result.stdout, failure: '' }
    lastFailure = String(result.stderr || result.error?.message || `exit ${result.status}`)
    if (attempt < 4) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  }
  return { output: '', failure: lastFailure }
}

export function resolvePackagedGoCliBinaryName({ target, hasBare, hasExe }) {
  const { goos } = normalizeGoTarget(target, '')
  if (goos === 'windows') return { binaryName: 'tabtin.exe', inferredGoos: 'windows' }
  if (goos) return { binaryName: 'tabtin', inferredGoos: goos }
  if (hasExe && !hasBare) return { binaryName: 'tabtin.exe', inferredGoos: 'windows' }
  if (hasBare && !hasExe) return { binaryName: 'tabtin', inferredGoos: '' }
  return { binaryName: '', inferredGoos: '' }
}

function scanPackagedGoCliProvenance({ resourcesRoot, target, arch, expectedRevision }) {
  const { goos, goarch } = normalizeGoTarget(target, arch)
  const cliDir = join(resourcesRoot, 'tabtin-cli-go', 'dist')
  const barePath = join(cliDir, 'tabtin')
  const exePath = join(cliDir, 'tabtin.exe')
  const resolved = resolvePackagedGoCliBinaryName({
    target,
    hasBare: existsSync(barePath),
    hasExe: existsSync(exePath),
  })
  const cliPath = resolved.binaryName ? join(cliDir, resolved.binaryName) : barePath
  const relPath = normalizePath(relative(resourcesRoot, cliPath))
  const hits = []

  if (!resolved.binaryName) {
    hits.push('无法唯一确定内置 Go CLI：请传 --target，或确保 tabtin / tabtin.exe 仅存在一个')
  } else if (!existsSync(cliPath)) {
    hits.push(`缺少内置 Go CLI：${relPath}`)
  } else {
    const { output, failure } = readGoBuildInfoWithRetries(cliPath)
    if (!output) {
      hits.push(`无法读取 CLI 构建信息：${relPath}（${failure || 'unknown error'}）`)
    } else {
      hits.push(...evaluatePackagedGoCliProvenance({
        buildInfo: output,
        expectedRevision,
        expectedGoos: goos || resolved.inferredGoos,
        expectedGoarch: goarch,
      }))
    }
  }

  return [createCheck(
    'Go CLI release provenance',
    'critical',
    hits,
    expectedRevision
      ? `校验内置 CLI 的目标平台与源码提交均匹配本次 release：${expectedRevision}`
      : '校验内置 CLI 的目标平台；未提供 expected revision，无法执行 release 身份比对。',
  )]
}

function scanMacPackagedGoCli(resourcesRoot, targetArch) {
  const cliPath = join(resourcesRoot, 'tabtin-cli-go', 'dist', 'tabtin')
  const relPath = normalizePath(relative(resourcesRoot, cliPath))
  if (!existsSync(cliPath)) {
    return [
      createCheck(
        `mac Go CLI architecture (${targetArch})`,
        'critical',
        [`缺少内置 Go CLI：${relPath}`],
        '运行期 Agent shell PATH 依赖 Resources/tabtin-cli-go/dist/tabtin；缺失会让 tabtin 命令不可用。',
      ),
    ]
  }

  const hits = []
  const mode = statSync(cliPath).mode
  if ((mode & 0o111) === 0) {
    hits.push(`Go CLI 不可执行：${relPath}`)
  }
  const actualArch = machoArchOf(readHeadBytes(cliPath))
  if (actualArch === 'unknown') {
    hits.push(`无法识别 Go CLI Mach-O 架构：${relPath}`)
  } else if (actualArch !== 'universal' && actualArch !== targetArch) {
    hits.push(`Go CLI 架构不匹配：${relPath} 期望 ${targetArch} 实为 ${actualArch}`)
  }

  return [
    createCheck(
      `mac Go CLI architecture (${targetArch})`,
      'critical',
      hits,
      '校验内置 tabtin Go CLI 的可执行位与 Mach-O 架构，防止 x64 包复用 arm64 缓存。',
    ),
  ]
}

function scanMacPackagedFilegen(resourcesRoot, targetArch, profile) {
  const filegenPath = join(resourcesRoot, 'tabtin-filegen-python', 'dist', 'tabtin-filegen')
  const relPath = normalizePath(relative(resourcesRoot, filegenPath))
  const exists = existsSync(filegenPath)
  const executable = exists ? (statSync(filegenPath).mode & 0o111) !== 0 : false
  const actualArch = exists ? machoArchOf(readHeadBytes(filegenPath)) : 'unknown'
  const verdict = evaluateMacPackagedFilegen({
    exists,
    executable,
    actualArch,
    targetArch,
    relPath,
    profile,
  })
  return [
    createCheck(
      `mac tabtin-filegen architecture (${targetArch})`,
      verdict.level,
      verdict.hits,
      '校验随包 tabtin-filegen 的可执行位与 Mach-O 架构，防止 x64 包复用 arm64 PyInstaller 产物。local 包缺文件为 warning；错架构一律 critical。',
    ),
  ]
}

function scanMacNativeArch({ appAsarPath, appBundle, target, arch, profile }) {
  if (!shouldAuditMacNativePayload(target)) return []

  let targetArch = normalizeTargetArch(arch)
  if (!targetArch) targetArch = inferMacTargetArch(appBundle)
  if (!targetArch) {
    return [
      createCheck(
        'mac native asset architecture',
        'warning',
        [],
        '无法确定目标架构（未提供 --arch / TABTIN_BUILD_ARCH，且无法从 .app 主可执行文件推断，可能是 universal 包），跳过原生资产架构校验。',
      ),
    ]
  }

  const unpackedRoot = `${appAsarPath}.unpacked`
  const nmRoot = join(unpackedRoot, 'node_modules')
  const resourcesRoot = dirname(appAsarPath)
  const filegenChecks = scanMacPackagedFilegen(resourcesRoot, targetArch, profile)
  if (!existsSync(nmRoot)) {
    return [
      ...filegenChecks,
      createCheck(
        `mac native asset architecture (${targetArch})`,
        'critical',
        [`app.asar.unpacked/node_modules 不存在：${nmRoot}`],
        '缺少解包后的原生依赖目录，无法验证目标架构原生资产。',
      ),
    ]
  }

  const io = createNativeArchIo(nmRoot)
  const { criticalHits, warningHits } = evaluateMacNativeArchAssets(targetArch, io)
  return [
    ...scanMacPackagedGoCli(resourcesRoot, targetArch),
    ...filegenChecks,
    createCheck(
      `mac native asset architecture (${targetArch})`,
      'critical',
      criticalHits,
      `校验目标架构 ${targetArch} 的关键原生资产存在且 Mach-O 架构匹配（ripgrep  / sharp / canvas / onnxruntime / node-pty）。`,
    ),
    createCheck(
      `mac native optional assets (${targetArch})`,
      'warning',
      warningHits,
      warningHits.length > 0
        ? '以下可选原生依赖未按目标架构打入本包（按裁剪处理，不阻断）。'
        : '可选原生依赖均已按目标架构打入或不适用。',
    ),
  ]
}

function scanWindowsNativeAssets({ appAsarPath, target, arch }) {
  if (!shouldAuditWindowsNativePayload(target)) return []

  const targetArch = normalizeTargetArch(arch) ?? 'x64'
  const unpackedRoot = `${appAsarPath}.unpacked`
  const nmRoot = join(unpackedRoot, 'node_modules')
  if (!existsSync(nmRoot)) {
    return [
      createCheck(
        `windows native assets (${targetArch})`,
        'critical',
        [`app.asar.unpacked/node_modules 不存在：${nmRoot}`],
        '缺少解包后的原生依赖目录，无法验证 Windows 终端 native 资产。',
      ),
    ]
  }

  const io = createNativeArchIo(nmRoot)
  const { criticalHits, warningHits } = evaluateWindowsNativeAssets(targetArch, io)
  return [
    createCheck(
      `windows native assets (${targetArch})`,
      'critical',
      criticalHits,
      `校验 Windows ${targetArch} 包含 node-pty conpty.node；缺失会导致打包版终端秒退。`,
    ),
    createCheck(
      `windows optional native assets (${targetArch})`,
      'warning',
      warningHits,
      warningHits.length > 0
        ? '以下可选 Windows 原生依赖未按目标架构打入本包（按裁剪处理，不阻断）。'
        : '可选 Windows 原生依赖均已按目标架构打入或不适用。',
    ),
  ]
}

function createCheck(name, level, hits = [], details = '') {
  return {
    name,
    level,
    hits: hits.slice(0, MAX_HITS_PER_RULE),
    totalHits: hits.length,
    details,
    ok: hits.length === 0 && level !== 'warning',
  }
}

function printCheck(check) {
  const status = check.level === 'warning' ? 'WARN' : (check.totalHits > 0 ? 'FAIL' : 'PASS')
  console.log(`[${status}] ${check.name}`)
  if (check.details) {
    console.log(`  ${check.details}`)
  }
  if (check.totalHits > 0) {
    for (const hit of check.hits) {
      console.log(`  - ${hit}`)
    }
    if (check.totalHits > check.hits.length) {
      console.log(`  ... ${check.totalHits - check.hits.length} more`)
    }
  }
}

function scanContent(options) {
  const { appAsarPath, resourcesRoot, profile, target, arch } = options
  const asar = readAsarHeader(appAsarPath)
  const asarPaths = asar.files.map((entry) => entry.path)
  const unpackedRoot = `${appAsarPath}.unpacked`
  const unpackedPaths = existsSync(unpackedRoot)
    ? walkFiles(unpackedRoot).map((path) => normalizePath(`app.asar.unpacked/${relative(unpackedRoot, path)}`))
    : []
  const resourcePaths = walkFiles(resourcesRoot)
    .filter((path) => path !== appAsarPath && !path.startsWith(unpackedRoot))
    .map((path) => normalizePath(relative(resourcesRoot, path)))

  const allPaths = [
    ...asarPaths.map((path) => `app.asar/${path}`),
    ...unpackedPaths,
    ...resourcePaths,
  ]

  const forbiddenSource = allPaths.filter((path) => isForbiddenSourceFile(path))
  const forbiddenDirs = allPaths.filter((path) => hasForbiddenDirectory(path))
  const templateSource = allPaths.filter((path) => isForbiddenTemplateSource(path))
  const nestedBuildOutput = allPaths.filter((path) => isNestedBuildOutputPath(path))
  const embeddedOfficeRuntimeArchives = shouldBlockEmbeddedOfficeRuntime(target, profile)
    ? allPaths.filter((path) => normalizePath(path).toLowerCase().endsWith('office-preview-runtime.tar.gz'))
    : []
  const missingPythonRuntime = shouldRequirePackagedPythonRuntime(profile)
    ? findMissingPackagedPythonRuntime(allPaths, {
        target,
        arch,
        readText: (relPath) => readFileSync(join(resourcesRoot, relPath), 'utf8'),
      })
    : []
  const macNonDarwinNativePayloads = shouldAuditMacNativePayload(target)
    ? allPaths.filter((path) => shouldBlockMacNonDarwinNativePath(path))
    : []
  const requiredArtifactSignals = scanRequiredArtifactSignals({
    asar,
    appAsarPath,
    unpackedRoot,
    resourcesRoot,
  })

  const secretScanEntries = []
  for (const entry of asar.files) {
    const artifactPath = `app.asar/${entry.path}`
    secretScanEntries.push({
      path: artifactPath,
      text: shouldScanSecretContent(artifactPath)
        ? readAsarEntry(asar, entry).toString('utf8')
        : '',
    })
  }
  for (const path of existsSync(unpackedRoot) ? walkFiles(unpackedRoot) : []) {
    const artifactPath = normalizePath(`app.asar.unpacked/${relative(unpackedRoot, path)}`)
    secretScanEntries.push({
      path: artifactPath,
      text: shouldScanSecretContent(artifactPath) ? readFileSync(path, 'utf8') : '',
    })
  }
  for (const path of walkFiles(resourcesRoot)) {
    if (path === appAsarPath || path.startsWith(unpackedRoot)) continue
    const artifactPath = normalizePath(relative(resourcesRoot, path))
    secretScanEntries.push({
      path: artifactPath,
      text: shouldScanSecretContent(artifactPath) ? readFileSync(path, 'utf8') : '',
    })
  }
  const secretMaterial = findPackagedSecretMaterial(secretScanEntries)
    .map((finding) => `${finding.path} [${finding.rule}]`)

  const sourceMapReferences = []
  for (const entry of asar.files) {
    if (!TEXT_SCAN_EXTENSIONS.has(extname(entry.path).toLowerCase())) continue
    const text = readAsarEntry(asar, entry).toString('utf8')
    if (hasPublicSourceMapReference(text) && shouldBlockSourceMapReference(`app.asar/${entry.path}`)) {
      sourceMapReferences.push(`app.asar/${entry.path}`)
    }
  }
  for (const path of existsSync(unpackedRoot) ? walkFiles(unpackedRoot) : []) {
    if (!TEXT_SCAN_EXTENSIONS.has(extname(path).toLowerCase())) continue
    const text = readFileSync(path, 'utf8')
    const artifactPath = normalizePath(`app.asar.unpacked/${relative(unpackedRoot, path)}`)
    if (hasPublicSourceMapReference(text) && shouldBlockSourceMapReference(artifactPath)) {
      sourceMapReferences.push(artifactPath)
    }
  }

  const unresolvedUnpackedImports = []
  const unpackedMainDir = join(unpackedRoot, 'out', 'main')
  if (existsSync(unpackedMainDir)) {
    for (const path of walkFiles(unpackedMainDir)) {
      if (extname(path).toLowerCase() !== '.mjs') continue
      const text = readFileSync(path, 'utf8')
      for (const specifier of extractRelativeEsmImports(text)) {
        const targetPath = resolve(dirname(path), specifier)
        if (!existsSync(targetPath)) {
          unresolvedUnpackedImports.push(
            `${normalizePath(`app.asar.unpacked/${relative(unpackedRoot, path)}`)} → ${specifier}`,
          )
        }
      }
    }
  }

  const unpackedRelativePaths = existsSync(unpackedRoot)
    ? walkFiles(unpackedRoot).map((path) => normalizePath(relative(unpackedRoot, path)))
    : []
  const bundledMcpRemoteHostIssues = findBundledMcpRemoteHostIssues(
    unpackedRelativePaths,
    (entryPath) => readFileSync(join(unpackedRoot, entryPath), 'utf8'),
  )

  const asarEntryByPath = new Map(asar.files.map((entry) => [normalizePath(entry.path), entry]))
  const unresolvedTabtinDistImports = findUnresolvedTabtinDistRelativeImports(
    asarPaths,
    (entryPath) => {
      const entry = asarEntryByPath.get(normalizePath(entryPath))
      if (!entry) throw new Error(`missing asar entry: ${entryPath}`)
      return readAsarEntry(asar, entry).toString('utf8')
    },
  )

  const packagedRuntimeCodeFiles = []
  for (const entryPath of unpackedRelativePaths) {
    if (!entryPath.startsWith('out/main/') || !/\.[cm]?js$/.test(entryPath)) continue
    packagedRuntimeCodeFiles.push({
      path: `app.asar.unpacked/${entryPath}`,
      text: readFileSync(join(unpackedRoot, entryPath), 'utf8'),
    })
  }
  for (const entryPath of asarPaths) {
    if (!entryPath.startsWith('out/preload/') || !/\.[cm]?js$/.test(entryPath)) continue
    const entry = asarEntryByPath.get(entryPath)
    if (!entry) continue
    packagedRuntimeCodeFiles.push({
      path: `app.asar/${entryPath}`,
      text: readAsarEntry(asar, entry).toString('utf8'),
    })
  }
  const unresolvedPackagedRuntimeImports = findUnresolvedPackagedRuntimeImports(
    packagedRuntimeCodeFiles,
    [...asarPaths, ...unpackedRelativePaths],
  )
  return [
    createCheck('no packaged source/map/build-cache files', 'critical', forbiddenSource, '禁止 .ts/.tsx/.map/.tsbuildinfo/test/spec 文件进入公开包。'),
    createCheck('no packaged test/example/benchmark/cache directories', 'critical', forbiddenDirs, '禁止 __tests__/tests/examples/benchmarks/fixtures/.github/.pytest_cache 等目录进入公开包。'),
    createCheck('no TabSite source template directories', 'critical', templateSource, 'TabSite 模板不能以源码模板目录形态进入安装包。'),
    createCheck('no duplicated electron-vite out directory', 'critical', nestedBuildOutput, 'app.asar 里不能出现 out/out；这通常表示 deploy 后重复复制构建产物。'),
    createCheck('no embedded Office preview runtime archive', 'critical', embeddedOfficeRuntimeArchives, 'preprod/production 分发包默认只携带下载清单，首次预览时下载并校验 Office runtime；离线包可设置 TABTIN_ENABLE_PACKAGED_OFFICE_PREVIEW_RUNTIME=1。'),
    createCheck('required packaged Python runtime', 'critical', missingPythonRuntime, 'preprod/production 包必须随附 native/tabtin-python-runtime 的 manifest 与当前平台归档；仓库不提交二进制，需先在目标 OS 构建 runtime。'),
    createCheck('no non-darwin native binaries in mac package', 'critical', macNonDarwinNativePayloads, 'macOS 分发包不能携带 Linux ELF / Windows DLL native payload；这些文件会扩大 notary 扫描面并可能拖慢或污染公证结果。'),
    createCheck('no public sourceMappingURL references', 'critical', sourceMapReferences, 'sourcemap 只允许上传内部错误监控，不允许公开包引用。'),
    createCheck('secret-material', 'critical', secretMaterial, '安装包不得包含 env 文件、私钥或上传 token；仅报告相对路径与规则，不回显秘密值。'),
    createCheck('required packaged UI/product signals', 'critical', requiredArtifactSignals.missing, `最终产物必须包含 overlay token、overlay blur utility 与  封面裁剪信号。${requiredArtifactSignals.summary}`),
    createCheck('unpacked worker relative imports resolvable', 'critical', unresolvedUnpackedImports, 'app.asar.unpacked/out/main 下的 .mjs 相对 import 必须能在 unpacked 目录内解析；缺失说明 asarUnpack 漏了共享 chunk，打包版 worker 启动即 ERR_MODULE_NOT_FOUND。'),
    createCheck('bundled Stripe OAuth runtime is self-contained', 'critical', bundledMcpRemoteHostIssues, 'Stripe OAuth 的 mcp-remote 宿主及完整依赖闭包必须随安装包交付；只允许引用 unpacked 相对 chunk 和 Node 内置模块，用户无需安装 Node、npm、npx 或 mcp-remote。'),
    createCheck('asar @tabtin dist relative imports resolvable', 'critical', unresolvedTabtinDistImports, 'app.asar 内 node_modules/@tabtin/*/dist 的相对 .js import（含 tsup chunk）必须可解析；缺失会导致 path-access-checker 等运行时 ERR_MODULE_NOT_FOUND。'),
    createCheck('main and preload runtime packages resolvable', 'critical', unresolvedPackagedRuntimeImports, 'main/preload 产物中的非 Node 内置模块必须存在于最终 ASAR；否则安装包会在启动或功能调用时 MODULE_NOT_FOUND。'),
  ]
}

async function tryReadFuses(executablePath) {
  let fuses
  try {
    fuses = await import('@electron/fuses')
  } catch {
    return { skipped: true, reason: '@electron/fuses is not resolvable in this checkout' }
  }

  if (typeof fuses.getCurrentFuseWire !== 'function') {
    return { skipped: true, reason: '@electron/fuses.getCurrentFuseWire is unavailable' }
  }

  try {
    const wire = await fuses.getCurrentFuseWire(executablePath)
    const { FuseV1Options, FuseState } = fuses
    const toBoolean = (value) => {
      if (value === FuseState.ENABLE) return true
      if (value === FuseState.DISABLE) return false
      return `state:${String(value)}`
    }
    return {
      fuses: Object.fromEntries(
        Object.entries(FuseV1Options)
          .filter(([key]) => Number.isNaN(Number(key)))
          .map(([name, index]) => [name, toBoolean(wire[index])]),
      ),
      rawWire: wire,
    }
  } catch (err) {
    return { skipped: true, reason: err instanceof Error ? err.message : String(err) }
  }
}

function findMacExecutable(appBundle) {
  const macosDir = join(appBundle, 'Contents', 'MacOS')
  if (!existsSync(macosDir)) return undefined
  const candidates = readdirSync(macosDir).map((entry) => join(macosDir, entry))
  return candidates.find((path) => statSync(path).isFile())
}

async function scanFuses(appBundle, profile) {
  const expectedProtected = profile === 'preprod' || profile === 'production'
  if (!appBundle || !appBundle.endsWith('.app')) {
    return [createCheck('electron fuses', 'warning', [], '非 macOS .app 产物，当前审计未读取 fuses。')]
  }
  const executable = findMacExecutable(appBundle)
  if (!executable) {
    return [createCheck('electron fuses', 'high', ['missing Contents/MacOS executable'])]
  }

  const result = await tryReadFuses(executable)
  if (result.skipped) {
    const details = `无法读取 fuses：${result.reason}`
    return expectedProtected
      ? [createCheck('electron fuses', 'high', [details], 'preprod/production 产物必须可读取并验证 Electron fuses。')]
      : [createCheck('electron fuses', 'warning', [], `跳过读取 fuses：${result.reason}`)]
  }

  const failures = []
  const actual = result.fuses
  const expectFalse = ['RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments']
  const expectTrue = ['EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar']
  if (expectedProtected) {
    for (const key of expectFalse) {
      if (actual[key] !== false) failures.push(`${key}=expected false, actual ${String(actual[key])}`)
    }
  }
  for (const key of expectTrue) {
    if (actual[key] !== true) failures.push(`${key}=expected true, actual ${String(actual[key])}`)
  }
  return [createCheck('electron fuses', 'high', failures, JSON.stringify(actual))]
}

function scanCodesign(appBundle) {
  if (process.platform !== 'darwin' || !appBundle || !appBundle.endsWith('.app')) {
    return [createCheck('macOS codesign', 'warning', [], '非 macOS .app 审计环境，跳过 codesign 校验。')]
  }
  const result = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle], {
    encoding: 'utf8',
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
  return [createCheck('macOS codesign', 'high', result.status === 0 ? [] : [output || `codesign exited ${result.status}`])]
}

function createTimeoutError(timeoutMs) {
  const error = new Error(`launch smoke exceeded ${timeoutMs}ms`)
  error.code = 'ETIMEDOUT'
  return error
}

function defaultKillProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
  } catch (err) {
    if (err && err.code === 'ESRCH') return
    try {
      process.kill(pid, signal)
    } catch {
      // The process may have exited between the group kill and the fallback.
    }
  }
}

function collectStream(stream, chunks, maxBuffer) {
  if (!stream) return
  if (typeof stream.setEncoding === 'function') {
    stream.setEncoding('utf8')
  }
  stream.on('data', (chunk) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk)
    const currentSize = chunks.reduce((sum, item) => sum + item.length, 0)
    if (currentSize >= maxBuffer) return
    chunks.push(text.slice(0, maxBuffer - currentSize))
  })
}

function runLaunchSmokeWithDeps(executable, args, deps) {
  const {
    env,
    timeoutMs,
    maxBuffer,
    spawn: spawnProcess,
    killProcessGroup,
  } = deps
  const stdoutChunks = []
  const stderrChunks = []

  return new Promise((resolve) => {
    const child = spawnProcess(executable, args, {
      detached: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let settled = false

    const timeout = setTimeout(() => {
      if (child.pid) {
        killProcessGroup(child.pid, 'SIGKILL')
      } else if (typeof child.kill === 'function') {
        child.kill('SIGKILL')
      }
      if (typeof child.unref === 'function') child.unref()
      if (typeof child.stdout?.destroy === 'function') child.stdout.destroy()
      if (typeof child.stderr?.destroy === 'function') child.stderr.destroy()
      finish({ error: createTimeoutError(timeoutMs), status: null, signal: 'SIGKILL' })
    }, timeoutMs)

    function finish(result) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({
        pid: child.pid,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        ...result,
      })
    }

    collectStream(child.stdout, stdoutChunks, maxBuffer)
    collectStream(child.stderr, stderrChunks, maxBuffer)

    child.on('error', (error) => {
      finish({ error, status: null, signal: null })
    })
    child.on('close', (status, signal) => {
      finish({ error: null, status, signal })
    })
  })
}

export async function scanMacLaunchSmokeWithDeps(appBundle, profile, deps) {
  const platform = deps.platform ?? process.platform
  if (platform !== 'darwin' || !appBundle || !appBundle.endsWith('.app')) {
    return [createCheck('macOS launch smoke', 'warning', [], '非 macOS .app 审计环境，跳过启动烟测。')]
  }
  const executable = deps.findMacExecutable(appBundle)
  if (!executable) {
    return [createCheck('macOS launch smoke', 'high', ['missing Contents/MacOS executable'])]
  }

  const timeoutMs = deps.timeoutMs ?? 5000
  const createTempUserDataDir = deps.createTempUserDataDir
    ?? (() => mkdtempSync(join(tmpdir(), 'tabtin-packaged-smoke-')))
  const removeTempUserDataDir = deps.removeTempUserDataDir
    ?? ((path) => rmSync(path, { recursive: true, force: true }))
  const userDataDir = createTempUserDataDir()
  let result
  try {
    result = await runLaunchSmokeWithDeps(
      executable,
      [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-software-rasterizer',
        `--user-data-dir=${userDataDir}`,
      ],
      {
        env: {
          ...process.env,
          TABTIN_DISABLE_APP_RELAUNCH: '1',
          TABTIN_PACKAGED_AUDIT_SMOKE: '1',
          ELECTRON_ENABLE_LOGGING: '1',
          ...(deps.env ?? {}),
        },
        timeoutMs,
        maxBuffer: deps.maxBuffer ?? 1024 * 1024,
        spawn: deps.spawn ?? spawn,
        killProcessGroup: deps.killProcessGroup ?? defaultKillProcessGroup,
      }
    )
  } finally {
    removeTempUserDataDir(userDataDir)
  }
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
  const fatalHits = []
  if (result.error && result.error.code !== 'ETIMEDOUT') {
    fatalHits.push(result.error.message)
  }
  if (result.status != null && result.status !== 0) {
    fatalHits.push(`exited ${result.status}${result.signal ? ` (${result.signal})` : ''}`)
  }
  if (/Integrity check failed for asar archive/i.test(output)) {
    fatalHits.push('Electron asar integrity check failed')
  }
  if (/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find package|Cannot find module/i.test(output)) {
    fatalHits.push(output.slice(0, 1200))
  }
  if (/Code Signature Invalid|EXC_BAD_ACCESS|Trace\/BPT trap|SIGTRAP|SIGABRT/i.test(output)) {
    fatalHits.push(output.slice(0, 1200))
  }
  const identityProfileMatch = output.match(/\[main\]\s+app identity:\s+profile=([a-z]+)/i)
  if ((profile === 'preprod' || profile === 'production') && identityProfileMatch) {
    const actualProfile = identityProfileMatch[1].toLowerCase()
    if (actualProfile !== profile) {
      fatalHits.push(`runtime profile mismatch: expected ${profile}, actual ${actualProfile}`)
    }
  }

  const details = result.error?.code === 'ETIMEDOUT'
    ? `进程可启动并超过 ${timeoutMs}ms 未崩溃，已清理 smoke 子进程，按烟测通过。`
    : (output.slice(0, 1200) || '进程快速退出且未输出 fatal 日志。')
  return [createCheck('macOS launch smoke', 'high', fatalHits, details)]
}

async function scanMacLaunchSmoke(appBundle, profile) {
  return scanMacLaunchSmokeWithDeps(appBundle, profile, {
    findMacExecutable,
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === 'true') {
    console.log(`Usage: node scripts/audit-packaged-artifact.mjs [options]

Options:
  --artifact <path>              Packaged artifact directory (default: dist-app)
  --profile <name>               Build profile (default: production)
  --target <mac|win|linux>       Target platform
  --arch <arm64|x64>             Target architecture
  --expected-cli-revision <sha>  Expected packaged CLI git revision
  --help                         Show this help`)
    return
  }
  const artifactRoot = resolve(args.artifact || args._[0] || 'dist-app')
  const profile = String(args.profile || process.env.TABTIN_BUILD_PROFILE || 'production')
  const target = String(args.target || process.env.TABTIN_BUILD_TARGET || '')
  const arch = String(args.arch || process.env.TABTIN_BUILD_ARCH || '')
  const expectedCliRevision = String(
    args['expected-cli-revision'] || process.env.TABTIN_BUILD_GIT_REVISION || '',
  )

  if (!existsSync(artifactRoot)) {
    console.error(`[audit:packaged] artifact path not found: ${artifactRoot}`)
    process.exit(2)
  }

  const appBundle = findFirst(artifactRoot, (path, st) => st.isDirectory() && basename(path).endsWith('.app'))
  const appAsarPath = findFirst(artifactRoot, (path, st) => st.isFile() && basename(path) === 'app.asar')
  if (!appAsarPath) {
    console.error(`[audit:packaged] app.asar not found under ${artifactRoot}`)
    process.exit(2)
  }

  const resourcesRoot = resolve(appAsarPath, '..')
  console.log(`Packaged artifact audit`)
  console.log(`  artifact: ${artifactRoot}`)
  console.log(`  profile: ${profile}`)
  if (target) console.log(`  target: ${target}`)
  if (arch) console.log(`  arch: ${arch}`)
  if (expectedCliRevision) console.log(`  expected CLI revision: ${expectedCliRevision}`)
  console.log(`  app.asar: ${appAsarPath}`)
  if (appBundle) console.log(`  app: ${appBundle}`)
  console.log('')

  const checks = [
    ...scanContent({ appAsarPath, resourcesRoot, profile, target, arch }),
    ...scanPackagedGoCliProvenance({
      resourcesRoot,
      target,
      arch,
      expectedRevision: expectedCliRevision,
    }),
    ...scanMacNativeArch({ appAsarPath, appBundle, target, arch, profile }),
    ...scanWindowsNativeAssets({ appAsarPath, target, arch }),
    ...(await scanFuses(appBundle, profile)),
    ...scanCodesign(appBundle),
    ...(await scanMacLaunchSmoke(appBundle, profile)),
  ]

  for (const check of checks) {
    printCheck(check)
  }

  const failed = checks.filter((check) => check.level !== 'warning' && check.totalHits > 0)
  if (failed.length > 0) {
    console.error('')
    console.error(`[audit:packaged] failed ${failed.length} check(s).`)
    process.exit(1)
  }

  console.log('')
  console.log('[audit:packaged] all blocking checks passed.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[audit:packaged] unexpected failure:', err)
    process.exit(2)
  })
}
