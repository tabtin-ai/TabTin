import { beforeEach, describe, expect, it } from 'vitest'
import {
  createRuntimeModelAvailabilityChecker,
  readRuntimeModelParamPreference,
  readRuntimeModelPreference,
  resolveLocalRuntimeAlignTarget,
  resolveRuntimeDefaultModelId,
  toProvisionModelId,
  writeRuntimeModelPreference,
  writeRuntimeModelParamPreference,
} from '../runtimeModelPreference'

const PLATFORM_ID = '42ae58c8-feea-4098-b80b-9a0aedc35007'
const CODEX_ID = 'gpt-5.6-sol'
const OTHER_PLATFORM = 'cbc75d0e-1111-4222-8333-444444444444'

describe('runtimeModelPreference', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('读写本机 sticky（平台与 Codex）', () => {
    writeRuntimeModelPreference('agent-1', CODEX_ID)
    expect(readRuntimeModelPreference('agent-1')).toBe(CODEX_ID)

    writeRuntimeModelPreference('agent-1', PLATFORM_ID)
    expect(readRuntimeModelPreference('agent-1')).toBe(PLATFORM_ID)
  })

  it('拒绝 declared / 空 id', () => {
    writeRuntimeModelPreference('agent-1', 'declared:moonshot:kimi')
    expect(readRuntimeModelPreference('agent-1')).toBeNull()

    writeRuntimeModelPreference('', PLATFORM_ID)
    expect(readRuntimeModelPreference('')).toBeNull()
  })

  it('按 Agent + 模型记住上次勾选的运行参数，恢复默认时删除单项', () => {
    writeRuntimeModelParamPreference('agent-1', CODEX_ID, 'reasoning_effort', 'high')
    writeRuntimeModelParamPreference('agent-1', CODEX_ID, 'service_tier', 'fast')

    expect(readRuntimeModelParamPreference('agent-1', CODEX_ID)).toEqual({
      reasoning_effort: 'high',
      service_tier: 'fast',
    })
    expect(readRuntimeModelParamPreference('agent-2', CODEX_ID)).toBeNull()
    expect(readRuntimeModelParamPreference('agent-1', PLATFORM_ID)).toBeNull()

    writeRuntimeModelParamPreference('agent-1', CODEX_ID, 'service_tier', null)
    expect(readRuntimeModelParamPreference('agent-1', CODEX_ID)).toEqual({
      reasoning_effort: 'high',
    })
  })

  it('解析顺序：pending → sticky → preferred', () => {
    const available = new Set([PLATFORM_ID, CODEX_ID, OTHER_PLATFORM])
    const isAvailable = (id: string) => available.has(id)

    expect(resolveRuntimeDefaultModelId({
      pendingModelId: OTHER_PLATFORM,
      stickyModelId: CODEX_ID,
      preferredModelId: PLATFORM_ID,
      isAvailable,
    })).toBe(OTHER_PLATFORM)

    expect(resolveRuntimeDefaultModelId({
      stickyModelId: CODEX_ID,
      preferredModelId: PLATFORM_ID,
      isAvailable,
    })).toBe(CODEX_ID)

    expect(resolveRuntimeDefaultModelId({
      stickyModelId: 'missing',
      preferredModelId: PLATFORM_ID,
      isAvailable,
    })).toBe(PLATFORM_ID)
  })

  it('sticky 不可用时跳过', () => {
    expect(resolveRuntimeDefaultModelId({
      stickyModelId: CODEX_ID,
      preferredModelId: PLATFORM_ID,
      isAvailable: (id) => id === PLATFORM_ID,
    })).toBe(PLATFORM_ID)
  })

  it('createRuntimeModelAvailabilityChecker：Codex 不依赖 catalog', () => {
    const isAvailable = createRuntimeModelAvailabilityChecker((id) => id === PLATFORM_ID)
    expect(isAvailable(CODEX_ID)).toBe(true)
    expect(isAvailable(PLATFORM_ID)).toBe(true)
    expect(isAvailable(OTHER_PLATFORM)).toBe(false)
  })

  it('resolveLocalRuntimeAlignTarget：catalog 未就绪仍能对齐 sticky Codex', () => {
    expect(resolveLocalRuntimeAlignTarget({
      stickyModelId: CODEX_ID,
      catalogHas: () => false,
    })).toBe(CODEX_ID)

    expect(resolveLocalRuntimeAlignTarget({
      pendingModelId: PLATFORM_ID,
      stickyModelId: CODEX_ID,
      catalogHas: (id) => id === PLATFORM_ID,
    })).toBe(PLATFORM_ID)
  })

  it('toProvisionModelId：Codex 回退平台首选', () => {
    expect(toProvisionModelId(PLATFORM_ID)).toBe(PLATFORM_ID)
    expect(toProvisionModelId(CODEX_ID, {
      preferredModelId: PLATFORM_ID,
      isAvailable: (id) => id === PLATFORM_ID,
    })).toBe(PLATFORM_ID)
    expect(toProvisionModelId(CODEX_ID, {
      preferredModelId: CODEX_ID,
    })).toBeUndefined()
    expect(toProvisionModelId(undefined, {
      preferredModelId: PLATFORM_ID,
      isAvailable: (id) => id === PLATFORM_ID,
    })).toBe(PLATFORM_ID)
  })
})
