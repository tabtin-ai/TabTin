import assert from 'node:assert/strict'
import test from 'node:test'

import { scanClientText } from './open-source-client-audit.mjs'

test('detects credential-like values and personal project paths', () => {
  const credential = `ghp_${'xY7kP2mN9qR4tV6wZ8cB1dF3hJ5sL0a'}`
  const content = [
    `const token = "${credential}"`, // open-source-audit: allow credential
    'const repo = "/Users/alice/Projects/TabTin/apps/tabtin-electron"' // open-source-audit: allow personal-path
  ].join('\n')

  const findings = scanClientText('scripts/local-helper.mjs', content)

  assert.deepEqual(
    findings.map((finding) => finding.rule),
    ['credential', 'personal-path']
  )
})

test('does not treat public client identifiers as secrets', () => {
  const content = [
    'VITE_SENTRY_DSN=https://public@example.ingest.sentry.io/123',
    'VITE_TENCENT_IM_SDK_APP_ID=0'
  ].join('\n')

  assert.deepEqual(scanClientText('.env.production', content), [])
})

test('does not report explicit placeholder credentials used by security tests and UI help', () => {
  const content = [
    'const token = "example-github-token"',
    'const apiKey = "test-api-key"',
    'const awsDocsKey = "example-aws-access-key-id"',
    'const help = "http://user:pass@host:port"'
  ].join('\n')

  assert.deepEqual(scanClientText('src/security.test.ts', content), [])
})

test('detects private keys and credentials embedded in URLs', () => {
  const content = [
    '-----BEGIN PRIVATE KEY-----', // open-source-audit: allow private-key
    'const registry = "https://build-user:build-password@registry.example.com/npm/"' // open-source-audit: allow credential-url
  ].join('\n')

  const findings = scanClientText('scripts/build.mjs', content)

  assert.deepEqual(
    findings.map((finding) => finding.rule),
    ['private-key', 'credential-url']
  )
})

test('supports a narrow, line-local allow annotation for synthetic fixtures', () => {
  const content =
    'const fixture = "/Users/alice/Projects/TabTin" // open-source-audit: allow personal-path'

  assert.deepEqual(scanClientText('scripts/example.test.mjs', content), [])
})
