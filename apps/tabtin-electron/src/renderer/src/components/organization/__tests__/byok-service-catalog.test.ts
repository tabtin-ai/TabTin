import { describe, expect, it } from 'vitest'
import { BYOK_API_PROVIDER_OPTIONS } from '../byok-api-provider-options'
import { BYOK_PLAN_PRESETS } from '../byok-plan-presets'
import {
  CHATGPT_CODEX_SERVICE_ID,
  OPENAI_COMPATIBLE_SERVICE_ID,
  OPENROUTER_PRESET_BASE_URL,
  OPENROUTER_SERVICE_ID,
  findByokService,
  getByokServiceCatalog,
  resolveLegacyServiceId,
} from '../byok-service-catalog'

describe('getByokServiceCatalog', () => {
  it('只使用当前已有 plan / API preset，不发明新协议', () => {
    const catalog = getByokServiceCatalog(true)
    const planIds = catalog.filter((item) => item.kind === 'plan').map((item) => item.id)
    expect(planIds.every((id) => BYOK_PLAN_PRESETS.some((preset) => preset.id === id))).toBe(true)

    const apiNames = catalog
      .filter((item) => item.kind === 'api')
      .map((item) => item.providerName)
    expect(apiNames.every((name) => BYOK_API_PROVIDER_OPTIONS.some((option) => option.provider_name === name))).toBe(true)
  })

  it('其他服务只保留 OpenAI Compatible，没有自定义服务入口', () => {
    const others = getByokServiceCatalog(true).filter((item) => item.group === 'other')
    expect(others).toHaveLength(1)
    expect(others[0]).toMatchObject({
      id: OPENAI_COMPATIBLE_SERVICE_ID,
      kind: 'openai_compatible',
      providerName: 'openai',
      defaultBaseUrl: '',
    })
  })

  it('OpenRouter 走 openai + 已有地址，不是新 Provider 类型', () => {
    const openrouter = findByokService(OPENROUTER_SERVICE_ID, true)
    expect(openrouter).toMatchObject({
      kind: 'openrouter',
      providerName: 'openai',
      defaultBaseUrl: OPENROUTER_PRESET_BASE_URL,
    })
  })

  it('Codex 可按开关隐藏', () => {
    expect(getByokServiceCatalog(true).some((item) => item.id === CHATGPT_CODEX_SERVICE_ID)).toBe(true)
    expect(getByokServiceCatalog(false).some((item) => item.id === CHATGPT_CODEX_SERVICE_ID)).toBe(false)
  })
})

describe('resolveLegacyServiceId', () => {
  it('旧 API openai Tab 落到 OpenAI Compatible', () => {
    expect(resolveLegacyServiceId({ mode: 'api', tabId: 'openai' })).toBe(OPENAI_COMPATIBLE_SERVICE_ID)
  })

  it('旧 plan Codex Tab 落到 chatgpt_codex', () => {
    expect(resolveLegacyServiceId({ mode: 'plan', tabId: 'chatgpt_codex' })).toBe(CHATGPT_CODEX_SERVICE_ID)
  })
})
