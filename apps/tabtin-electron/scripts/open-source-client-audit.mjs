import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const AUDIT_ROOTS = [
  'apps/tabtin-electron',
  '.npmrc',
  'package.json',
  'scripts/electron/dev.mjs'
]

const PREFILTER_TERMS = [
  '-----BEGIN',
  'http://',
  'https://',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'AKIA',
  'ASIA',
  'LTAI',
  'sk-',
  'Users',
  'smb://',
  'afp://',
  '10.',
  '192.168.',
  '172.'
]

const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.a',
  '.avi',
  '.bin',
  '.bmp',
  '.dylib',
  '.exe',
  '.gif',
  '.gz',
  '.icns',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp3',
  '.mp4',
  '.node',
  '.onnx',
  '.pdf',
  '.png',
  '.so',
  '.tar',
  '.wasm',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.zip'
])

const RULES = [
  {
    rule: 'private-key',
    message: 'private key material must not be committed',
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g
  },
  {
    rule: 'credential-url',
    message: 'URL contains embedded credentials',
    pattern: /https?:\/\/(?!user:pass@)[^\s/:@]+:[^\s/@]+@[^\s/]+/g
  },
  {
    rule: 'credential',
    message: 'credential-like value must come from the local environment',
    pattern:
      /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|LTAI[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{20,})(?![A-Za-z0-9])/g
  },
  {
    rule: 'personal-path',
    message: 'personal absolute project path must not be committed',
    pattern:
      /(?:\/Users\/(?!me\/|user\/|name\/|foo\/)[^/\s"']+\/(?:Projects|PycharmProjects)\/|[A-Za-z]:\\Users\\(?!me\\|user\\|name\\|foo\\)[^\\\s"']+\\(?:Projects|workspace)\\)/g
  },
  {
    rule: 'private-network-default',
    message: 'private network address must not be a committed client default',
    pattern: /(?:smb:\/\/|afp:\/\/|\\\\)(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/g
  }
]

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDirectory, '../../..')

function allowedRulesForLine(line) {
  const marker = line.match(/open-source-audit:\s*allow\s+([a-z0-9-, ]+)/i)
  if (!marker) return new Set()

  return new Set(
    marker[1]
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean)
  )
}

function isExplicitCredentialPlaceholder(value) {
  return (
    /^gh[pousr]_x+$/i.test(value) ||
    /^gh[pousr]_abcdefghijklmnop[a-z0-9_]*$/i.test(value) ||
    /^sk-(?:abcdefghijklmnopqrstuvwxyz|my-super-secret-key-\d+)$/i.test(value) ||
    value === 'example-aws-access-key-id'
  )
}

export function scanClientText(filePath, content) {
  const findings = []

  for (const [lineIndex, line] of content.split(/\r?\n/).entries()) {
    const allowedRules = allowedRulesForLine(line)

    for (const definition of RULES) {
      if (allowedRules.has(definition.rule)) continue

      const matches = line.matchAll(new RegExp(definition.pattern.source, definition.pattern.flags))
      for (const match of matches) {
        if (definition.rule === 'credential' && isExplicitCredentialPlaceholder(match[0])) {
          continue
        }
        findings.push({
          file: filePath,
          line: lineIndex + 1,
          column: (match.index ?? 0) + 1,
          rule: definition.rule,
          message: definition.message
        })
      }
    }
  }

  return findings
}

function isBinaryFile(filePath, content) {
  if (BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return true
  return content.subarray(0, 8192).includes(0)
}

export function listTrackedClientFiles(root = repositoryRoot) {
  const output = execFileSync('git', ['ls-files', '-z', '--', ...AUDIT_ROOTS], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024
  })

  return output.split('\0').filter(Boolean)
}

export function listPotentialClientFiles(root = repositoryRoot) {
  const grepArgs = ['grep', '-I', '-l', '-F']
  for (const term of PREFILTER_TERMS) grepArgs.push('-e', term)
  grepArgs.push('--', ...AUDIT_ROOTS)

  const result = spawnSync('git', grepArgs, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024
  })

  if (result.status === 1) return []
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git grep failed with status ${result.status}`)
  }

  return result.stdout.split(/\r?\n/).filter(Boolean)
}

export function auditTrackedClientFiles(root = repositoryRoot) {
  const findings = []

  // git grep performs a lossless signature prefilter over the same tracked scope;
  // the precise rules below still decide whether each candidate is a finding.
  for (const filePath of listPotentialClientFiles(root)) {
    const content = readFileSync(path.join(root, filePath))
    if (isBinaryFile(filePath, content)) continue
    findings.push(...scanClientText(filePath, content.toString('utf8')))
  }

  return findings
}

function runCommand() {
  const findings = auditTrackedClientFiles()

  if (findings.length === 0) {
    console.log('Electron open-source audit passed.')
    return
  }

  console.error(`Electron open-source audit found ${findings.length} issue(s):`)
  for (const finding of findings) {
    console.error(
      `${finding.file}:${finding.line}:${finding.column} [${finding.rule}] ${finding.message}`
    )
  }
  process.exitCode = 1
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  runCommand()
}
