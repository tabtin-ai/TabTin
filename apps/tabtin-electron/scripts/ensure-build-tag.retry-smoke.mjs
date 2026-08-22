#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { fetchRemoteAlphaTags } from './ensure-build-tag.mjs'

const tempDir = mkdtempSync(join(tmpdir(), 'tabtin-tag-fetch-retry-'))
const pathEnvKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
const originalPath = process.env[pathEnvKey] ?? ''
const originalNodeOptions = process.env.NODE_OPTIONS

try {
  const fakeGitScript = join(tempDir, 'fake-git.mjs')
  writeFileSync(
    fakeGitScript,
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const counterPath = join(dirname(fileURLToPath(import.meta.url)), 'count.txt')
const current = existsSync(counterPath) ? Number(readFileSync(counterPath, 'utf-8')) : 0
writeFileSync(counterPath, String(current + 1))

if (current < 2) {
  console.error("fatal: unable to access 'https://github.com/larchiveai/TabTin.git/': Failed to connect to github.com port 443 after 21095 ms: Could not connect to server")
  process.exit(128)
}
process.exit(0)
`,
  )

  if (process.platform === 'win32') {
    copyFileSync(process.execPath, join(tempDir, 'git.exe'))
    process.env.NODE_OPTIONS = [
      originalNodeOptions,
      `--import=${pathToFileURL(fakeGitScript).href}`,
    ].filter(Boolean).join(' ')
  } else {
    const gitShim = join(tempDir, 'git')
    writeFileSync(gitShim, `#!/usr/bin/env bash\nnode "$(dirname "$0")/fake-git.mjs" "$@"\n`)
    chmodSync(gitShim, 0o755)
  }

  process.env[pathEnvKey] = `${tempDir}${delimiter}${originalPath}`

  const logs = []
  const result = fetchRemoteAlphaTags('origin', {
    maxAttempts: 3,
    retryDelayMs: 0,
    log: (message) => logs.push(message),
  })

  assert.equal(result.ok, true)
  assert.equal(readFileSync(join(tempDir, 'count.txt'), 'utf-8'), '3')
  assert.match(logs.join('\n'), /重试/)
} finally {
  process.env[pathEnvKey] = originalPath
  if (originalNodeOptions === undefined) {
    delete process.env.NODE_OPTIONS
  } else {
    process.env.NODE_OPTIONS = originalNodeOptions
  }
  rmSync(tempDir, { recursive: true, force: true })
}

const scriptName = fileURLToPath(import.meta.url)
console.log(`${dirname(scriptName)}: ensure-build-tag fetch retry smoke passed`)
