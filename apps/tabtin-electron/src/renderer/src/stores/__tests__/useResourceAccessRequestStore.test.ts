import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockApprove, mockToast } = vi.hoisted(() => ({
  mockApprove: vi.fn(),
  mockToast: vi.fn(),
}))

vi.mock('@/services/tabchatApi', () => ({
  approveResourceAccessRequest: mockApprove,
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: mockToast,
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, options?: { defaultValue?: string }) =>
      typeof options?.defaultValue === 'string' ? options.defaultValue : key,
  },
}))

describe('useResourceAccessRequestStore ', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    mockApprove.mockResolvedValue({ id: 'req-1', status: 'approved', role: 'viewer' })
    const { useResourceAccessRequestStore } = await import('../useResourceAccessRequestStore')
    useResourceAccessRequestStore.setState({
      open: false,
      requestId: null,
      title: '',
      body: '',
      resourceType: null,
      resourceId: null,
      isApproving: false,
      error: null,
    })
  })

  it('openConfirm from notification opens dialog with request_id', async () => {
    const { useResourceAccessRequestStore } = await import('../useResourceAccessRequestStore')
    useResourceAccessRequestStore.getState().openConfirm({
      id: 'n-1',
      type: 'resource_access_request',
      title: 'Alice 申请查看资源',
      body: 'Alice 申请查看（viewer）《文档》',
      metadata: {
        request_id: 'req-42',
        resource_type: 'document',
        resource_id: 'doc-1',
      },
      organization_id: 'org-1',
      is_read: false,
      read_at: null,
      created_at: '2026-07-28T00:00:00.000Z',
    } as any)

    const state = useResourceAccessRequestStore.getState()
    expect(state.open).toBe(true)
    expect(state.requestId).toBe('req-42')
    expect(state.body).toContain('申请查看')
    expect(state.resourceType).toBe('document')
    expect(state.resourceId).toBe('doc-1')
  })

  it('close only dismisses dialog without calling approve', async () => {
    const { useResourceAccessRequestStore } = await import('../useResourceAccessRequestStore')
    useResourceAccessRequestStore.getState().openConfirm({ requestId: 'req-9', body: 'pending' })
    useResourceAccessRequestStore.getState().close()

    expect(useResourceAccessRequestStore.getState().open).toBe(false)
    expect(useResourceAccessRequestStore.getState().requestId).toBeNull()
    expect(mockApprove).not.toHaveBeenCalled()
  })

  it('approve calls API then closes', async () => {
    const { useResourceAccessRequestStore } = await import('../useResourceAccessRequestStore')
    useResourceAccessRequestStore.getState().openConfirm({ requestId: 'req-7' })
    await useResourceAccessRequestStore.getState().approve()

    expect(mockApprove).toHaveBeenCalledWith('req-7')
    expect(useResourceAccessRequestStore.getState().open).toBe(false)
    expect(useResourceAccessRequestStore.getState().requestId).toBeNull()
  })

  it('openConfirm uses editor copy when notification requests edit', async () => {
    const { useResourceAccessRequestStore } = await import('../useResourceAccessRequestStore')
    useResourceAccessRequestStore.getState().openConfirm({
      id: 'n-2',
      type: 'resource_access_request',
      title: 'Alice 申请编辑资源',
      body: 'Alice 申请编辑（editor）《文档》',
      metadata: {
        request_id: 'req-edit',
        resource_type: 'document',
        resource_id: 'doc-2',
        role: 'editor',
      },
      organization_id: 'org-1',
      is_read: false,
      read_at: null,
      created_at: '2026-08-08T00:00:00.000Z',
    } as any)

    const state = useResourceAccessRequestStore.getState()
    expect(state.open).toBe(true)
    expect(state.title).toContain('编辑')
    expect(state.body).toContain('编辑')
  })
})
