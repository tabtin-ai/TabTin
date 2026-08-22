import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlidePresentation } from '../../../../../packages/tabslide/src/types/slides'
import { ensureProjectId } from '../../renderer/src/components/slide/autosave-utils'
import { apiService } from '@/services/api'

vi.mock('@/services/api', () => ({
  apiService: {
    request: vi.fn(),
  },
}))

function makePresentation(): SlidePresentation {
  return {
    id: 'pres-1',
    name: 'font-meta',
    preset: '16:9',
    canvasWidth: 1920,
    canvasHeight: 1080,
    pages: [],
  }
}

describe('TabSlide Font Meta Autosave Chain', () => {
  beforeEach(() => {
    vi.mocked(apiService.request).mockReset()
  })

  it('ensureProjectId 应把字体元数据并入创建请求', async () => {
    vi.mocked(apiService.request).mockResolvedValue({
      data: { id: 'project-font-1' },
    } as unknown as Record<string, unknown>)

    const serverIdRef = { current: null as string | null }
    const createProjectPromiseRef = { current: null as Promise<string | null> | null }
    const createProjectSessionRef = { current: null as number | null }
    const saveSessionRef = { current: 3 }

    const projectId = await ensureProjectId(
      makePresentation(),
      serverIdRef,
      createProjectPromiseRef,
      createProjectSessionRef,
      saveSessionRef,
      3,
      () => 'ppt',
      () => ({ organizationId: 'ws-1', spaceId: 'agent-space-1' }),
      () => ({
        embedded_fonts: [{
          name: 'Mock Font',
          style: 'normal',
          format: 'truetype',
          data_base64: 'QUJD',
        }],
        theme_fonts: { minor_ea: '等线' },
      }),
    )

    expect(projectId).toBe('project-font-1')
    expect(serverIdRef.current).toBe('project-font-1')
    expect(apiService.request).toHaveBeenCalledTimes(1)

    const req = vi.mocked(apiService.request).mock.calls[0]?.[0] as Record<string, unknown>
    const data = req?.data as Record<string, unknown>
    expect(data?.embedded_fonts).toBeTruthy()
    expect((data?.theme_fonts as Record<string, unknown>)?.minor_ea).toBe('等线')
  })

  it('未提供字体元数据时不应额外写入字段', async () => {
    vi.mocked(apiService.request).mockResolvedValue({
      data: { id: 'project-font-2' },
    } as unknown as Record<string, unknown>)

    const serverIdRef = { current: null as string | null }
    const createProjectPromiseRef = { current: null as Promise<string | null> | null }
    const createProjectSessionRef = { current: null as number | null }
    const saveSessionRef = { current: 9 }

    await ensureProjectId(
      makePresentation(),
      serverIdRef,
      createProjectPromiseRef,
      createProjectSessionRef,
      saveSessionRef,
      9,
      () => 'ppt',
      () => ({ organizationId: 'ws-1', spaceId: 'agent-space-1' }),
      () => null,
    )

    const req = vi.mocked(apiService.request).mock.calls[0]?.[0] as Record<string, unknown>
    const data = req?.data as Record<string, unknown>
    expect('embedded_fonts' in data).toBe(false)
    expect('theme_fonts' in data).toBe(false)
  })
})
