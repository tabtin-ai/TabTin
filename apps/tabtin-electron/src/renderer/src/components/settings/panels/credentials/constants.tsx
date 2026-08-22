import React from 'react'
import { Chrome, Globe } from 'lucide-react'

export const BROWSER_ICONS: Record<string, React.ReactNode> = {
  chrome: <Chrome className="h-4 w-4" />,
  edge: <Globe className="h-4 w-4" />,
  firefox: <Globe className="h-4 w-4" />,
  safari: <Globe className="h-4 w-4" />,
}

export const SUPPORTED_BROWSERS = new Set(['chrome', 'edge', 'firefox', 'safari'])
export const PASSWORD_BROWSERS = new Set(['chrome', 'edge'])

/**
 * 产品开关：从 Chrome/Edge 等本机浏览器批量导入 Cookie + 密码。
 * BR-23 dogfood 暂关——改回 true 前须先修 batch-import 契约与 Profile 选择链。
 */
export const BROWSER_CREDENTIAL_IMPORT_ENABLED = false

export const ERROR_CODE_I18N: Record<string, string> = {
  UNSUPPORTED_BROWSER: 'credentialVault.browserCookies.unsupportedBrowser',
  UNSUPPORTED_JSON_FORMAT: 'credentialVault.browserCookies.unsupportedJsonFormat',
  PASSWORD_EXTRACT_UNSUPPORTED: 'credentialVault.browserCookies.passwordExtractUnsupported',
  COOKIE_DB_MISSING: 'credentialVault.browserCookies.cookieDbMissing',
  DECRYPT_KEY_UNAVAILABLE: 'credentialVault.browserCookies.decryptKeyUnavailable',
}

/**
 * 服务预设：每个服务声明它需要哪些字段。
 *
 * `keyFields` 数组对应后端 `apps/credential_vault/skill_reveal.py::SKILL_CREDENTIAL_ENV_MAP`
 * 中各 `_derive_*` 函数读取的 `encrypted_data` 字段名集合。
 *
 * **新增多字段服务的步骤**：
 *   1. 后端：在 `skill_reveal.py` 加 `_derive_xxx` + 注册到 `SKILL_CREDENTIAL_ENV_MAP`
 *   2. 前端：本表新增 `{ value, label, keyFields }` 一行
 *   3. i18n：在 `credentialVault.serviceKeys.fields.*` 加 label / placeholder
 *
 * `keyFields` 用数组结构而不是单一字符串，是为了将来多字段服务接入时
 * UI 表单能直接遍历渲染输入框，不必另起一套数据结构。
 */
export interface ServicePreset {
  value: string
  label: string
  keyFields: readonly string[]
}

export const SERVICE_PRESETS: readonly ServicePreset[] = [
  { value: 'openai', label: 'OpenAI', keyFields: ['api_key'] },
  { value: 'anthropic', label: 'Anthropic', keyFields: ['api_key'] },
  { value: 'serper', label: 'Serper', keyFields: ['api_key'] },
  { value: 'sendgrid', label: 'SendGrid', keyFields: ['api_key'] },
]

/**
 * 字段渲染元数据。
 *
 * `isSecret=true` 的字段渲染 `<input type="password">` 防止肩窥；其余字段
 * （如 `app_id`）是公开标识符，明文输入更易于校对。
 */
export const FIELD_META: Record<
  string,
  { labelKey: string; placeholderKey: string; isSecret: boolean }
> = {
  api_key: {
    labelKey: 'credentialVault.serviceKeys.fields.apiKey.label',
    placeholderKey: 'credentialVault.serviceKeys.fields.apiKey.placeholder',
    isSecret: true,
  },
  app_id: {
    labelKey: 'credentialVault.serviceKeys.fields.appId.label',
    placeholderKey: 'credentialVault.serviceKeys.fields.appId.placeholder',
    isSecret: false,
  },
  app_secret: {
    labelKey: 'credentialVault.serviceKeys.fields.appSecret.label',
    placeholderKey: 'credentialVault.serviceKeys.fields.appSecret.placeholder',
    isSecret: true,
  },
}

export function getFieldMeta(fieldName: string) {
  return (
    FIELD_META[fieldName] ?? {
      labelKey: 'credentialVault.serviceKeys.fields.apiKey.label',
      placeholderKey: 'credentialVault.serviceKeys.fields.apiKey.placeholder',
      isSecret: true,
    }
  )
}
