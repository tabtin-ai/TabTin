#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(new URL('./build-packaged-app.sh', import.meta.url))
const scriptSource = fs.readFileSync(scriptPath, 'utf8')

function resolveBash() {
  if (process.platform !== 'win32') return 'bash'

  const whereGit = spawnSync('where.exe', ['git'], { encoding: 'utf8' })
  const gitExecutable = whereGit.stdout?.split(/\r?\n/).find(Boolean)
  const gitRoot = gitExecutable ? path.dirname(path.dirname(gitExecutable)) : undefined
  const candidates = [
    process.env.GIT_BASH_PATH,
    gitRoot && path.join(gitRoot, 'bin', 'bash.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] &&
      path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
  ]
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? 'bash'
}

const bash = resolveBash()

function extractFunction(name) {
  const start = scriptSource.indexOf(`${name}() {`)
  assert.notEqual(start, -1, `missing ${name} in build-packaged-app.sh`)

  let depth = 0
  let opened = false
  for (let index = start; index < scriptSource.length; index += 1) {
    if (scriptSource[index] === '{') {
      depth += 1
      opened = true
    } else if (scriptSource[index] === '}') {
      depth -= 1
      if (opened && depth === 0) {
        return scriptSource.slice(start, index + 1)
      }
    }
  }
  throw new Error(`unterminated ${name} in build-packaged-app.sh`)
}

function runFunction(functionName, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-packaged-win-contract-'))
  const fixture = path.join(root, 'fixture.sh')
  try {
    fs.writeFileSync(
      fixture,
      ['set -u', extractFunction(functionName), body].join('\n\n'),
      'utf8',
    )
    return spawnSync(bash, [fixture], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, TRACE_FILE: path.join(root, 'trace.log') },
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('Windows pnpm deploy shortens virtual-store directory names before installing', () => {
  const result = runFunction(
    'run_pnpm_deploy',
    String.raw`
TARGET_RUNTIME=win32
HOST_RUNTIME=linux
REPO_ROOT=/repo
pnpm() { printf '%s\n' "$@"; }
run_pnpm_deploy 'C:\short\deploy'
`,
  )

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
    '--config.virtual-store-dir-max-length=40',
    '--filter',
    'tabtin-electron',
    'deploy',
    'C:\\short\\deploy',
    '--prod',
    '--ignore-scripts',
  ])
})

test('Windows failed deploy cleanup never blocks on recursive chmod or rm', () => {
  const result = runFunction(
    'retire_packaged_deploy_dir',
    String.raw`
TARGET_RUNTIME=win32
target="$PWD/deploy"
mkdir -p "$target"
mv() { printf 'mv\n' >> "$TRACE_FILE"; return 1; }
chmod() { printf 'chmod\n' >> "$TRACE_FILE"; return 0; }
rm() { printf 'rm\n' >> "$TRACE_FILE"; return 0; }
retire_packaged_deploy_dir "$target"
status=$?
printf 'status=%s\n' "$status"
printf 'trace=%s\n' "$(tr '\n' ',' < "$TRACE_FILE")"
exit 0
`,
  )

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /status=1/)
  assert.match(result.stdout, /trace=mv,/)
  assert.doesNotMatch(result.stdout, /chmod|rm,/)
})
