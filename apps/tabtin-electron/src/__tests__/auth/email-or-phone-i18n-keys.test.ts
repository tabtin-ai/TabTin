import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../../../')

const REQUIRED_KEYS = [
  'loginForm.labels.emailOrPhone',
  'loginForm.placeholders.emailOrPhone',
  'loginForm.hints.autoRegisterOnCodeLoginEmailOrPhone',
  'loginForm.success.codeSentEmailOrPhone',
  'loginForm.errors.usernameRequiredEmailOrPhone',
  'loginForm.errors.usernameBeforeCodeEmailOrPhone',
  'loginForm.errors.emailInvalid',
  'registerForm.labels.emailOrPhone',
  'registerForm.placeholders.emailOrPhone',
  'registerForm.subheadingEmailOrPhone',
  'registerForm.success.codeSentEmailOrPhone',
  'registerForm.errors.phoneRequiredEmailOrPhone',
  'forgotForm.labels.emailOrPhone',
  'forgotForm.placeholders.emailOrPhone',
  'forgotForm.subheading.requestEmailOrPhone',
  'forgotForm.success.codeSentEmailOrPhone',
  'forgotForm.errors.usernameRequiredEmailOrPhone',
  'forgotForm.errors.emailInvalid',
] as const

function readAuthJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath), 'utf8')) as Record<string, unknown>
}

function readKey(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[part]
  }, source)
}

describe('email-or-phone auth copy', () => {
  it.each([
    'apps/tabtin-electron/src/renderer/src/i18n/locales/zh-CN/auth.json',
    'apps/tabtin-electron/src/renderer/src/i18n/locales/en-US/auth.json',
    'apps/tabtin-web/src/i18n/locales/zh-CN/auth.json',
    'apps/tabtin-web/src/i18n/locales/en-US/auth.json',
  ])('%s has email-or-phone keys', (relativePath) => {
    const catalog = readAuthJson(relativePath)
    for (const key of REQUIRED_KEYS) {
      expect(readKey(catalog, key), key).toEqual(expect.any(String))
    }
  })
})
