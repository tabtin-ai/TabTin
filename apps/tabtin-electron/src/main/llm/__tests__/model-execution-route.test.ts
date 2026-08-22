import { describe, expect, it } from 'vitest'
import {
  resolveModelExecutionRoute,
  resolveSharedTemplateModelId,
} from '../model-execution-route.js'

describe('resolveModelExecutionRoute', () => {
  it('本机 ChatGPT 模型始终走本机 Provider', () => {
    expect(resolveModelExecutionRoute({
      modelId: 'gpt-5.6-sol',
      rendererByokHint: false,
    })).toEqual({ kind: 'local_codex', isByok: true })
  })

  it.each(['organization', 'user'] as const)('%s 目录模型按 BYOK 处理', (providerScope) => {
    expect(resolveModelExecutionRoute({
      modelId: 'remote-model-uuid',
      catalogEntry: { providerScope },
      rendererByokHint: false,
    })).toEqual({ kind: 'proxy', isByok: true })
  })

  it('平台目录覆盖渲染层过期的 BYOK hint', () => {
    expect(resolveModelExecutionRoute({
      modelId: 'platform-model-uuid',
      catalogEntry: { providerScope: 'global' },
      rendererByokHint: true,
    })).toEqual({ kind: 'proxy', isByok: false })
  })

  it('目录冷启动 miss 时兼容渲染层 hint', () => {
    expect(resolveModelExecutionRoute({
      modelId: 'unknown-model-uuid',
      rendererByokHint: true,
    })).toEqual({ kind: 'proxy', isByok: true })
  })
})

describe('resolveSharedTemplateModelId', () => {
  it('共享模板中的本机 ChatGPT 固定模型降级为继承', () => {
    expect(resolveSharedTemplateModelId('gpt-5.6-sol')).toBe('')
    expect(resolveSharedTemplateModelId('  model-uuid  ')).toBe('model-uuid')
  })
})
