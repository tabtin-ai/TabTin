import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { findPackagedSecretMaterial } from './audit-packaged-artifact.mjs'
import { resolveSourcemapUploadConfig } from './packaged-secret-boundary.mjs'

const scriptDirectory = new URL('.', import.meta.url)

test('official sourcemap upload only accepts a process-injected key', () => {
  const result = resolveSourcemapUploadConfig({
    profile: 'production',
    processEnv: {
      SOURCEMAP_API_URL: 'https://errors.example.com',
      SOURCEMAP_UPLOAD_KEY: 'injected-at-build-time'
    },
    rootEnv: { SOURCEMAP_UPLOAD_KEY: 'must-not-be-used' }
  })

  assert.equal(result.enabled, true)
  assert.equal(result.keySource, 'process')
})

test('community build skips official sourcemap upload by default', () => {
  assert.deepEqual(
    resolveSourcemapUploadConfig({ profile: 'community', processEnv: {} }),
    { enabled: false }
  )
})

test('build scripts do not read upload credentials from env files', () => {
  const buildScript = readFileSync(new URL('build-packaged-app.sh', scriptDirectory), 'utf8')
  const sentryScript = readFileSync(
    new URL('upload-sentry-sourcemaps.sh', scriptDirectory),
    'utf8'
  )

  assert.doesNotMatch(
    buildScript,
    /SOURCEMAP_UPLOAD_KEY=\$\(read_env_value/
  )
  assert.doesNotMatch(
    sentryScript,
    /SENTRY_AUTH_TOKEN=\$\(read_env_value/
  )
})

test('packaged audit reports secret material without echoing its value', () => {
  const secret = 'sntrys_4Jx9pL2vN8cQ7mZ6wK3f'
  const findings = findPackagedSecretMaterial([
    { path: 'app.asar/.env.production', text: 'VITE_PUBLIC=value' },
    { path: 'resources/private.pem', text: '-----BEGIN PRIVATE KEY-----' }, // open-source-audit: allow private-key
    { path: 'app.asar/out/main/config.mjs', text: `SENTRY_AUTH_TOKEN=${secret}` }
  ])

  assert.deepEqual(
    findings.map(({ path, rule }) => ({ path, rule })),
    [
      { path: 'app.asar/.env.production', rule: 'env-file' },
      { path: 'resources/private.pem', rule: 'private-key' },
      { path: 'app.asar/out/main/config.mjs', rule: 'upload-token' }
    ]
  )
  assert.doesNotMatch(JSON.stringify(findings), new RegExp(secret))
})

test('jose PEM parser source is not secret material', () => {
  const findings = findPackagedSecretMaterial([
    {
      path: 'app.asar/node_modules/jose/dist/webapi/key/import.js',
      text: 'if (pem.includes("-----BEGIN PRIVATE KEY-----")) { throw new TypeError("unsupported") }', // open-source-audit: allow private-key
    },
  ])

  assert.deepEqual(findings, [])
})

test('public Sentry DSN is not secret material', () => {
  const findings = findPackagedSecretMaterial([
    {
      path: 'app.asar/out/main/config.mjs',
      text: 'VITE_SENTRY_DSN=https://public@example.ingest.sentry.io/123'
    }
  ])

  assert.deepEqual(findings, [])
})

test('packaged artifact audit exposes help without requiring an artifact', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('audit-packaged-artifact.mjs', scriptDirectory)), '--help'],
    { encoding: 'utf8' }
  )

  assert.equal(result.status, 0)
  assert.match(result.stdout, /--artifact/)
  assert.equal(result.stderr, '')
})
