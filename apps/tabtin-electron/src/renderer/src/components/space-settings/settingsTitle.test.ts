import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSpaces } = vi.hoisted(() => ({
  mockSpaces: {
    value: [] as Array<{ id: string; type: string; name: string; organization_id: string }>,
  },
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  },
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      spaces: mockSpaces.value,
    }),
  },
}))

import { getSpaceSettingsTitle } from './settingsTitle'

describe('settingsTitle', () => {
  beforeEach(() => {
    mockSpaces.value = [
      { id: 'bot-1', type: 'workspace', name: 'Bot', organization_id: 'ws-1' },
    ]
  })

  it('对 workspace 返回默认 Space 管理标题', () => {
    expect(getSpaceSettingsTitle('bot-1')).toBe('title')
  })

  it('对未知或历史 space id 也返回默认标题', () => {
    expect(getSpaceSettingsTitle('legacy-group-1')).toBe('title')
  })
})
