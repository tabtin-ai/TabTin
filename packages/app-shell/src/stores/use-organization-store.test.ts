import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Organization } from '../types/organization.js'

const {
  mockCreateOrganization,
  mockTransferOwnership,
  mockGetOrganizations,
  mockGetOrganization,
  mockGetMembers,
  mockRemoveMember,
  mockSetActiveSpace,
  mockRegisterResetAction,
} = vi.hoisted(() => ({
  mockCreateOrganization: vi.fn(),
  mockTransferOwnership: vi.fn(),
  mockGetOrganizations: vi.fn(),
  mockGetOrganization: vi.fn(),
  mockGetMembers: vi.fn(),
  mockRemoveMember: vi.fn(),
  mockSetActiveSpace: vi.fn(),
  mockRegisterResetAction: vi.fn(),
}))

vi.mock('../services/organization-api.js', () => ({
  OrganizationApiService: {
    createOrganization: mockCreateOrganization,
    transferOwnership: mockTransferOwnership,
    getOrganizations: mockGetOrganizations,
    getOrganization: mockGetOrganization,
  },
}))

vi.mock('../services/member-api.js', () => ({
  MemberApiService: {
    getMembers: mockGetMembers,
    removeMember: mockRemoveMember,
  },
}))

vi.mock('../runtime.js', () => ({
  getRuntime: () => ({
    auth: {
      getCurrentUserId: () => 'user-1',
    },
    bridge: {
      setActiveSpace: mockSetActiveSpace,
      resetChatClient: vi.fn(),
    },
  }),
}))

vi.mock('@tabtin/shared', () => ({
  withPersistSafety: (options: unknown) => options,
  createErrorExtractor: () => (_err: unknown, fallbackKey: string) => fallbackKey,
}))

vi.mock('@tabtin/config', () => ({
  API_ENDPOINTS: {
    ORGANIZATION: {
      LIST: '/organizations',
      DETAIL: (organizationId: string) => `/organizations/${organizationId}`,
      CREATE: '/organizations',
      UPDATE: (organizationId: string) => `/organizations/${organizationId}`,
      DELETE: (organizationId: string) => `/organizations/${organizationId}`,
      LEAVE: (organizationId: string) => `/organizations/${organizationId}/leave`,
      HEALTH: '/organizations/health',
    },
    ORGANIZATION_TRANSFER: (organizationId: string) => `/organizations/${organizationId}/transfer`,
  },
  joinApiPath: (_base: string, path: string) => path,
}))

vi.mock('./session-reset-registry.js', () => ({
  registerResetAction: mockRegisterResetAction,
}))

const makeOrganization = (overrides: Partial<Organization>): Organization => ({
  id: 'wt-1',
  name: 'Organization',
  type: 'team',
  owner_id: 'user-1',
  is_default: false,
  created_at: '2026-06-17T00:00:00.000Z',
  updated_at: '2026-06-17T00:00:00.000Z',
  ...overrides,
})

describe('useOrganizationStore', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    window.localStorage.clear()

    const {
      useOrganizationStore,
      setCurrentSpaceOrganizationIdResolver,
    } = await import('./use-organization-store.js')
    setCurrentSpaceOrganizationIdResolver(() => null)
    useOrganizationStore.getState().clearAll()
  })

  it('selects the newly created organization immediately after creation', async () => {
    const { useOrganizationStore } = await import('./use-organization-store.js')

    const personal = makeOrganization({
      id: 'personal-1',
      name: 'Personal',
      type: 'personal',
      is_default: true,
    })
    const created = makeOrganization({
      id: 'team-new',
      name: 'New Team',
      type: 'team',
      is_default: false,
    })

    useOrganizationStore.setState({
      organizations: [personal],
      selectedOrganization: personal,
      currentUserRole: 'owner',
      members: [],
    })
    mockCreateOrganization.mockResolvedValue(created)
    mockGetOrganization.mockResolvedValue(created)
    mockGetMembers.mockResolvedValue({
      members: [
        {
          id: 'member-1',
          organization_id: created.id,
          user_id: 'user-1',
          role: 'owner',
          joined_at: '2026-06-17T00:00:00.000Z',
        },
      ],
      total: 1,
    })

    const result = await useOrganizationStore.getState().createOrganization({ name: created.name })

    expect(result.id).toBe(created.id)
    expect(useOrganizationStore.getState().organizations.map(w => w.id)).toEqual([
      created.id,
      personal.id,
    ])
    expect(useOrganizationStore.getState().selectedOrganization?.id).toBe(created.id)
    expect(useOrganizationStore.getState().lastOpenedOrganizationId).toBe(created.id)
    expect(useOrganizationStore.getState().currentUserRole).toBe('owner')
    expect(useOrganizationStore.getState().isLoading).toBe(false)
    expect(useOrganizationStore.getState().isMutating).toBe(false)
    expect(useOrganizationStore.getState().isSelecting).toBe(false)
    expect(mockGetOrganization).toHaveBeenCalledTimes(1)
    expect(mockGetMembers).toHaveBeenCalledTimes(1)
    expect(mockSetActiveSpace).toHaveBeenCalledWith(null, null, created.id)
    const { getFrontendContextReady } = await import('./frontend-context-ready.js')
    expect(getFrontendContextReady()).toMatchObject({
      organizationId: created.id,
      organizationSettingsKnown: true,
    })
  })

  it('keeps a member removed when the failed DELETE is confirmed by an authoritative reload', async () => {
    const { useOrganizationStore } = await import('./use-organization-store.js')
    const organization = makeOrganization({ id: 'team-1' })
    const member = {
      id: 'member-2',
      organization_id: 'team-1',
      user_id: 'user-2',
      role: 'editor' as const,
      joined_at: '2026-08-17T00:00:00.000Z',
    }
    useOrganizationStore.setState({ selectedOrganization: organization, members: [member] })
    mockRemoveMember.mockRejectedValueOnce(new Error('成员不存在'))
    mockGetMembers.mockResolvedValueOnce({ members: [], total: 0 })

    await expect(
      useOrganizationStore.getState().removeMember('team-1', 'user-2'),
    ).resolves.toBeUndefined()

    expect(useOrganizationStore.getState().members).toEqual([])
    expect(mockGetMembers).toHaveBeenCalledWith('team-1')
  })

  it('restores authoritative members when the failed DELETE did not remove the target', async () => {
    const { useOrganizationStore } = await import('./use-organization-store.js')
    const organization = makeOrganization({ id: 'team-1' })
    const member = {
      id: 'member-2',
      organization_id: 'team-1',
      user_id: 'user-2',
      role: 'editor' as const,
      joined_at: '2026-08-17T00:00:00.000Z',
    }
    const authoritativeMember = { ...member, role: 'admin' as const }
    const otherMember = { ...member, id: 'member-3', user_id: 'user-3' }
    useOrganizationStore.setState({ selectedOrganization: organization, members: [member] })
    const requestError = new Error('Request timeout')
    mockRemoveMember.mockRejectedValueOnce(requestError)
    mockGetMembers.mockResolvedValueOnce({
      members: [authoritativeMember, otherMember],
      total: 2,
    })

    await expect(
      useOrganizationStore.getState().removeMember('team-1', 'user-2'),
    ).rejects.toBe(requestError)

    expect(mockGetMembers).toHaveBeenCalledWith('team-1')
    expect(useOrganizationStore.getState().members).toEqual([authoritativeMember, otherMember])
  })

  it('does not restore members after logout while removal confirmation is pending', async () => {
    const { useOrganizationStore } = await import('./use-organization-store.js')
    const organization = makeOrganization({ id: 'team-1' })
    const member = {
      id: 'member-2',
      organization_id: organization.id,
      user_id: 'user-2',
      role: 'editor' as const,
      joined_at: '2026-08-17T00:00:00.000Z',
    }
    let rejectRemoval: (error: Error) => void = () => undefined
    mockRemoveMember.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectRemoval = reject
    }))
    mockGetMembers.mockRejectedValueOnce(new Error('Reload failed'))
    useOrganizationStore.setState({ selectedOrganization: organization, members: [member] })

    const removal = useOrganizationStore.getState().removeMember(organization.id, member.user_id)
    useOrganizationStore.getState().clearAll()
    rejectRemoval(new Error('Request timeout'))

    await expect(removal).rejects.toThrow('Request timeout')
    expect(useOrganizationStore.getState().selectedOrganization).toBeNull()
    expect(useOrganizationStore.getState().members).toEqual([])
  })

  it('does not overwrite another organization while removal confirmation is pending', async () => {
    const { useOrganizationStore } = await import('./use-organization-store.js')
    const organizationA = makeOrganization({ id: 'org-a' })
    const organizationB = makeOrganization({ id: 'org-b' })
    const memberA = {
      id: 'member-a',
      organization_id: organizationA.id,
      user_id: 'user-a',
      role: 'editor' as const,
      joined_at: '2026-08-17T00:00:00.000Z',
    }
    const memberB = { ...memberA, id: 'member-b', organization_id: organizationB.id, user_id: 'user-b' }
    let rejectRemoval: (error: Error) => void = () => undefined
    mockRemoveMember.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectRemoval = reject
    }))
    mockGetMembers.mockResolvedValueOnce({ members: [memberA], total: 1 })
    useOrganizationStore.setState({ selectedOrganization: organizationA, members: [memberA] })

    const removal = useOrganizationStore.getState().removeMember(organizationA.id, memberA.user_id)
    useOrganizationStore.setState({ selectedOrganization: organizationB, members: [memberB] })
    rejectRemoval(new Error('Request timeout'))

    await expect(removal).rejects.toThrow('Request timeout')
    expect(useOrganizationStore.getState().selectedOrganization?.id).toBe(organizationB.id)
    expect(useOrganizationStore.getState().members).toEqual([memberB])
  })

  it('does not overwrite a newly selected session for the same organization', async () => {
    const { useOrganizationStore } = await import('./use-organization-store.js')
    const organization = makeOrganization({ id: 'team-1' })
    const staleMember = {
      id: 'member-stale',
      organization_id: organization.id,
      user_id: 'user-stale',
      role: 'editor' as const,
      joined_at: '2026-08-17T00:00:00.000Z',
    }
    const currentMember = { ...staleMember, id: 'member-current', user_id: 'user-current' }
    let rejectRemoval: (error: Error) => void = () => undefined
    mockRemoveMember.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectRemoval = reject
    }))
    mockGetMembers.mockResolvedValueOnce({ members: [staleMember], total: 1 })
    useOrganizationStore.setState({ selectedOrganization: organization, members: [staleMember] })

    const removal = useOrganizationStore.getState().removeMember(
      organization.id,
      staleMember.user_id,
    )
    useOrganizationStore.getState().clearAll()
    useOrganizationStore.setState({ selectedOrganization: organization, members: [currentMember] })
    rejectRemoval(new Error('Request timeout'))

    await expect(removal).rejects.toThrow('Request timeout')
    expect(useOrganizationStore.getState().members).toEqual([currentMember])
  })

  it('#8759 only completes the matching pending organization switch', async () => {
    const { useOrganizationStore } = await import('./use-organization-store.js')

    useOrganizationStore.setState({
      pendingOrganizationId: 'org-b',
    })

    useOrganizationStore.getState().completeOrganizationContextSwitch('org-a')
    expect(useOrganizationStore.getState().pendingOrganizationId).toBe('org-b')

    useOrganizationStore.getState().completeOrganizationContextSwitch('org-b')
    expect(useOrganizationStore.getState().pendingOrganizationId).toBeNull()
  })

  it('#8759 keeps the pending target until the Space belongs to it', async () => {
    const {
      useOrganizationStore,
      setCurrentSpaceOrganizationIdResolver,
    } = await import('./use-organization-store.js')

    setCurrentSpaceOrganizationIdResolver(() => 'org-a')
    useOrganizationStore.setState({ pendingOrganizationId: 'org-b' })
    useOrganizationStore.getState().completeOrganizationContextSwitch('org-b')

    expect(useOrganizationStore.getState().pendingOrganizationId).toBe('org-b')

    setCurrentSpaceOrganizationIdResolver(() => 'org-b')
    useOrganizationStore.getState().completeOrganizationContextSwitch('org-b')

    expect(useOrganizationStore.getState().pendingOrganizationId).toBeNull()
  })

  it('#8759 resolves the pending target for foreground services', async () => {
    const { useOrganizationStore } = await import('./use-organization-store.js')
    const organizationA = makeOrganization({ id: 'org-a' })
    const organizationB = makeOrganization({ id: 'org-b' })
    useOrganizationStore.setState({
      organizations: [organizationA, organizationB],
      selectedOrganization: organizationA,
      pendingOrganizationId: organizationB.id,
    })

    expect(useOrganizationStore.getState().getEffectiveOrganizationId()).toBe('org-b')
  })

  it('#8759 does not leave a pending target when an unselected organization fails to load', async () => {
    const { useOrganizationStore } = await import('./use-organization-store.js')
    const {
      getFrontendContextReady,
      notifyOrganizationSettingsKnown,
    } = await import('./frontend-context-ready.js')
    const organizationA = makeOrganization({ id: 'org-a' })
    const unavailableOrganizationB = makeOrganization({ id: 'org-b' })
    useOrganizationStore.setState({
      organizations: [organizationA],
      selectedOrganization: organizationA,
      pendingOrganizationId: null,
    })
    notifyOrganizationSettingsKnown(organizationA)
    mockGetOrganization.mockRejectedValueOnce(new Error('network unavailable'))
    mockGetMembers.mockResolvedValueOnce({ members: [], total: 0 })

    await useOrganizationStore.getState().selectOrganization(unavailableOrganizationB)

    expect(useOrganizationStore.getState().selectedOrganization?.id).toBe('org-a')
    expect(useOrganizationStore.getState().pendingOrganizationId).toBeNull()
    expect(useOrganizationStore.getState().isSelecting).toBe(false)
    expect(getFrontendContextReady()).toMatchObject({
      organizationId: organizationA.id,
      organizationSettingsKnown: true,
    })
  })

  it('#8759 rolls back an optimistic organization switch when its request fails', async () => {
    const { useOrganizationStore } = await import('./use-organization-store.js')
    const {
      getFrontendContextReady,
      notifyOrganizationSettingsKnown,
    } = await import('./frontend-context-ready.js')
    const organizationA = makeOrganization({ id: 'org-a', name: 'Organization A' })
    const knownButUnavailableOrganizationB = makeOrganization({ id: 'org-b', name: 'Organization B' })
    const previousMembers = [{
      id: 'member-a',
      organization_id: 'org-a',
      user_id: 'user-1',
      role: 'owner' as const,
      joined_at: '2026-06-17T00:00:00.000Z',
    }]
    useOrganizationStore.setState({
      organizations: [organizationA, knownButUnavailableOrganizationB],
      selectedOrganization: organizationA,
      lastOpenedOrganizationId: organizationA.id,
      currentUserRole: 'owner',
      members: previousMembers,
      pendingOrganizationId: null,
    })
    notifyOrganizationSettingsKnown(organizationA)
    mockGetOrganization.mockRejectedValueOnce(new Error('access revoked'))
    mockGetMembers.mockResolvedValueOnce({ members: [], total: 0 })

    await useOrganizationStore.getState().selectOrganization(knownButUnavailableOrganizationB)

    expect(useOrganizationStore.getState()).toMatchObject({
      selectedOrganization: organizationA,
      lastOpenedOrganizationId: organizationA.id,
      currentUserRole: 'owner',
      members: previousMembers,
      pendingOrganizationId: organizationA.id,
      isSelecting: false,
    })
    useOrganizationStore.getState().completeOrganizationContextSwitch(organizationA.id)
    expect(useOrganizationStore.getState().pendingOrganizationId).toBeNull()
    expect(getFrontendContextReady()).toMatchObject({
      organizationId: organizationA.id,
      organizationSettingsKnown: true,
    })
  })

  it('#8759 rolls an A → B → C failure back to the last confirmed organization A', async () => {
    const { useOrganizationStore } = await import('./use-organization-store.js')
    const organizationA = makeOrganization({ id: 'org-a', name: 'Organization A' })
    const organizationB = makeOrganization({ id: 'org-b', name: 'Organization B' })
    const unavailableOrganizationC = makeOrganization({ id: 'org-c', name: 'Organization C' })
    useOrganizationStore.setState({
      organizations: [organizationA, organizationB, unavailableOrganizationC],
      selectedOrganization: organizationA,
      lastOpenedOrganizationId: organizationA.id,
      currentUserRole: 'owner',
      members: [],
      pendingOrganizationId: null,
    })

    let resolveOrganizationB: (organization: Organization) => void = () => {}
    const organizationBRequest = new Promise<Organization>((resolve) => {
      resolveOrganizationB = resolve
    })
    mockGetOrganization
      .mockReturnValueOnce(organizationBRequest)
      .mockRejectedValueOnce(new Error('organization C access revoked'))
    mockGetMembers
      .mockResolvedValueOnce({ members: [], total: 0 })
      .mockResolvedValueOnce({ members: [], total: 0 })

    const selectingB = useOrganizationStore.getState().selectOrganization(organizationB)
    await useOrganizationStore.getState().selectOrganization(unavailableOrganizationC)

    expect(useOrganizationStore.getState()).toMatchObject({
      selectedOrganization: organizationA,
      lastOpenedOrganizationId: organizationA.id,
      pendingOrganizationId: organizationA.id,
      isSelecting: false,
    })

    resolveOrganizationB(organizationB)
    await selectingB
  })

  it('#8759 keeps the original rollback target when B is selected twice before either request resolves', async () => {
    const { useOrganizationStore } = await import('./use-organization-store.js')
    const organizationA = makeOrganization({ id: 'org-a', name: 'Organization A' })
    const organizationB = makeOrganization({ id: 'org-b', name: 'Organization B' })
    useOrganizationStore.setState({
      organizations: [organizationA, organizationB],
      selectedOrganization: organizationA,
      lastOpenedOrganizationId: organizationA.id,
      currentUserRole: 'owner',
      members: [],
      pendingOrganizationId: null,
    })

    let resolveFirstOrganizationB: (organization: Organization) => void = () => {}
    const firstOrganizationBRequest = new Promise<Organization>((resolve) => {
      resolveFirstOrganizationB = resolve
    })
    mockGetOrganization
      .mockReturnValueOnce(firstOrganizationBRequest)
      .mockRejectedValueOnce(new Error('second B request failed'))
    mockGetMembers
      .mockResolvedValueOnce({ members: [], total: 0 })
      .mockResolvedValueOnce({ members: [], total: 0 })

    const firstSelection = useOrganizationStore.getState().selectOrganization(organizationB)
    await useOrganizationStore.getState().selectOrganization(organizationB)

    expect(useOrganizationStore.getState()).toMatchObject({
      selectedOrganization: organizationA,
      lastOpenedOrganizationId: organizationA.id,
      pendingOrganizationId: organizationA.id,
      isSelecting: false,
    })

    resolveFirstOrganizationB(organizationB)
    await firstSelection
  })

  it('#8759 keeps pending after a completed selection is refreshed before Space switches', async () => {
    const { useOrganizationStore } = await import('./use-organization-store.js')
    const organizationA = makeOrganization({ id: 'org-a', name: 'Organization A' })
    const organizationB = makeOrganization({ id: 'org-b', name: 'Organization B' })
    useOrganizationStore.setState({
      organizations: [organizationA, organizationB],
      selectedOrganization: organizationA,
      pendingOrganizationId: null,
    })
    mockGetOrganization.mockResolvedValue(organizationB)
    mockGetMembers.mockResolvedValue({ members: [], total: 0 })

    await useOrganizationStore.getState().selectOrganization(organizationB)
    expect(useOrganizationStore.getState()).toMatchObject({
      selectedOrganization: organizationB,
      pendingOrganizationId: organizationB.id,
      isSelecting: false,
    })

    await useOrganizationStore.getState().selectOrganization(organizationB)
    expect(useOrganizationStore.getState()).toMatchObject({
      selectedOrganization: organizationB,
      pendingOrganizationId: organizationB.id,
      isSelecting: false,
    })
  })

  it('updates organization ownership and member roles after a transfer', async () => {
    const { useOrganizationStore } = await import('./use-organization-store.js')
    const organization = makeOrganization({ id: 'team-transfer' })
    const ownerMembership = {
      id: 'member-owner',
      organization_id: organization.id,
      user_id: 'user-1',
      role: 'owner' as const,
      joined_at: '2026-07-13T00:00:00.000Z',
    }
    const editorMembership = {
      id: 'member-editor',
      organization_id: organization.id,
      user_id: 'user-2',
      role: 'editor' as const,
      joined_at: '2026-07-13T00:00:00.000Z',
    }

    useOrganizationStore.setState({
      organizations: [organization],
      selectedOrganization: organization,
      currentUserRole: 'owner',
      members: [ownerMembership, editorMembership],
    })
    mockTransferOwnership.mockResolvedValue(undefined)

    await useOrganizationStore.getState().transferOwnership(organization.id, 'user-2')

    expect(mockTransferOwnership).toHaveBeenCalledWith(organization.id, 'user-2')
    expect(useOrganizationStore.getState().organizations[0]?.owner_id).toBe('user-2')
    expect(useOrganizationStore.getState().selectedOrganization?.owner_id).toBe('user-2')
    expect(useOrganizationStore.getState().currentUserRole).toBe('editor')
    expect(useOrganizationStore.getState().members).toEqual([
      { ...ownerMembership, role: 'editor' },
      { ...editorMembership, role: 'owner' },
    ])
  })

  describe('refreshOrganizationAccess', () => {
    const makeMember = (userId: string, role: 'owner' | 'editor') => ({
      id: `member-${userId}`,
      organization_id: 'team-1',
      user_id: userId,
      role,
      joined_at: '2026-07-14T00:00:00.000Z',
    })

    it('refreshes owner_id / currentUserRole / members for the selected organization (new-owner view)', async () => {
      const { useOrganizationStore } = await import('./use-organization-store.js')
      // 场景：user-1（B）刚被转让成 owner，但本地 store 还是转让前的旧状态
      const stale = makeOrganization({ id: 'team-1', owner_id: 'user-9' })
      const fresh = makeOrganization({ id: 'team-1', owner_id: 'user-1' })

      useOrganizationStore.setState({
        organizations: [stale],
        selectedOrganization: stale,
        currentUserRole: 'editor',
        members: [makeMember('user-9', 'owner'), makeMember('user-1', 'editor')],
      })
      mockGetOrganization.mockResolvedValue(fresh)
      mockGetMembers.mockResolvedValue({
        members: [makeMember('user-9', 'editor'), makeMember('user-1', 'owner')],
        total: 2,
      })

      await useOrganizationStore.getState().refreshOrganizationAccess('team-1')

      const state = useOrganizationStore.getState()
      expect(state.selectedOrganization?.owner_id).toBe('user-1')
      expect(state.organizations[0]?.owner_id).toBe('user-1')
      expect(state.currentUserRole).toBe('owner')
      expect(state.members.find(m => m.user_id === 'user-1')?.role).toBe('owner')
      // 纯数据刷新：不应触发 selectOrganization 的 bridge 副作用
      expect(mockSetActiveSpace).not.toHaveBeenCalled()
    })

    it('only updates the list entry for a non-selected organization', async () => {
      const { useOrganizationStore } = await import('./use-organization-store.js')
      const staleBackground = makeOrganization({ id: 'team-bg', owner_id: 'user-9' })
      const selected = makeOrganization({ id: 'team-fg', owner_id: 'user-1' })
      const freshBackground = makeOrganization({ id: 'team-bg', owner_id: 'user-1' })

      useOrganizationStore.setState({
        organizations: [selected, staleBackground],
        selectedOrganization: selected,
        currentUserRole: 'owner',
        members: [],
      })
      mockGetOrganization.mockResolvedValue(freshBackground)

      await useOrganizationStore.getState().refreshOrganizationAccess('team-bg')

      const state = useOrganizationStore.getState()
      expect(state.organizations.find(w => w.id === 'team-bg')?.owner_id).toBe('user-1')
      expect(state.selectedOrganization?.id).toBe('team-fg')
      expect(state.currentUserRole).toBe('owner')
      expect(mockGetMembers).not.toHaveBeenCalled()
    })

    it('skips unknown organizations without hitting the API', async () => {
      const { useOrganizationStore } = await import('./use-organization-store.js')
      useOrganizationStore.setState({
        organizations: [makeOrganization({ id: 'team-known' })],
        selectedOrganization: null,
      })

      await useOrganizationStore.getState().refreshOrganizationAccess('team-unknown')

      expect(mockGetOrganization).not.toHaveBeenCalled()
      expect(mockGetMembers).not.toHaveBeenCalled()
    })

    it('discards a late response when the user switched organization mid-flight', async () => {
      const { useOrganizationStore } = await import('./use-organization-store.js')
      const orgA = makeOrganization({ id: 'team-a', owner_id: 'user-9' })
      const orgB = makeOrganization({ id: 'team-b', owner_id: 'user-2' })

      useOrganizationStore.setState({
        organizations: [orgA, orgB],
        selectedOrganization: orgA,
        currentUserRole: 'editor',
        members: [],
      })

      let resolveDetail: (value: Organization) => void = () => {}
      mockGetOrganization.mockReturnValue(
        new Promise<Organization>((resolve) => { resolveDetail = resolve }),
      )
      mockGetMembers.mockResolvedValue({
        members: [makeMember('user-1', 'owner')],
        total: 1,
      })

      const refreshPromise = useOrganizationStore.getState().refreshOrganizationAccess('team-a')
      // 回包途中用户切到了 team-b
      useOrganizationStore.setState({ selectedOrganization: orgB, currentUserRole: 'owner', members: [] })
      resolveDetail(makeOrganization({ id: 'team-a', owner_id: 'user-1' }))
      await refreshPromise

      const state = useOrganizationStore.getState()
      expect(state.selectedOrganization?.id).toBe('team-b')
      expect(state.currentUserRole).toBe('owner')
      expect(state.members).toEqual([])
    })

    it('keeps existing state and does not throw when the refresh request fails', async () => {
      const { useOrganizationStore } = await import('./use-organization-store.js')
      const org = makeOrganization({ id: 'team-1', owner_id: 'user-9' })

      useOrganizationStore.setState({
        organizations: [org],
        selectedOrganization: org,
        currentUserRole: 'editor',
        members: [],
      })
      mockGetOrganization.mockRejectedValue(new Error('network down'))
      mockGetMembers.mockRejectedValue(new Error('network down'))

      await expect(
        useOrganizationStore.getState().refreshOrganizationAccess('team-1'),
      ).resolves.toBeUndefined()

      const state = useOrganizationStore.getState()
      expect(state.selectedOrganization?.owner_id).toBe('user-9')
      expect(state.currentUserRole).toBe('editor')
      expect(state.error).toBeNull()
    })
  })

  it('prefers the last opened organization when startup list is ordered by newest first', async () => {
    const { useOrganizationStore } = await import('./use-organization-store.js')

    const latestCreated = makeOrganization({
      id: 'team-newest',
      name: 'Newest Team',
      created_at: '2026-06-18T00:00:00.000Z',
      updated_at: '2026-06-18T00:00:00.000Z',
    })
    const lastOpened = makeOrganization({
      id: 'team-last-opened',
      name: 'Last Opened Team',
      created_at: '2026-06-16T00:00:00.000Z',
      updated_at: '2026-06-16T00:00:00.000Z',
    })
    const personal = makeOrganization({
      id: 'personal-1',
      name: 'Personal',
      type: 'personal',
      is_default: true,
    })

    useOrganizationStore.setState({
      selectedOrganization: null,
      lastOpenedOrganizationId: lastOpened.id,
    })
    mockGetOrganizations.mockResolvedValue({
      organizations: [latestCreated, lastOpened, personal],
      total: 3,
    })

    await useOrganizationStore.getState().loadOrganizations()

    expect(useOrganizationStore.getState().getEffectiveOrganization()?.id).toBe(lastOpened.id)
  })

  it('falls back when the last opened organization is no longer available', async () => {
    const { useOrganizationStore } = await import('./use-organization-store.js')

    const latestCreated = makeOrganization({
      id: 'team-newest',
      name: 'Newest Team',
      created_at: '2026-06-18T00:00:00.000Z',
      updated_at: '2026-06-18T00:00:00.000Z',
    })
    const personal = makeOrganization({
      id: 'personal-1',
      name: 'Personal',
      type: 'personal',
      is_default: true,
    })

    useOrganizationStore.setState({
      selectedOrganization: null,
      lastOpenedOrganizationId: 'team-missing',
    })
    mockGetOrganizations.mockResolvedValue({
      organizations: [latestCreated, personal],
      total: 2,
    })

    await useOrganizationStore.getState().loadOrganizations()

    expect(useOrganizationStore.getState().getEffectiveOrganization()?.id).toBe(personal.id)
  })

  it('keeps only last opened organization memory when clearing session data', async () => {
    const { useOrganizationStore } = await import('./use-organization-store.js')

    const lastOpened = makeOrganization({
      id: 'team-last-opened',
      name: 'Last Opened Team',
    })

    useOrganizationStore.setState({
      organizations: [lastOpened],
      selectedOrganization: lastOpened,
      lastOpenedOrganizationId: lastOpened.id,
      currentUserRole: 'owner',
      members: [
        {
          id: 'member-1',
          organization_id: lastOpened.id,
          user_id: 'user-1',
          role: 'owner',
          joined_at: '2026-06-17T00:00:00.000Z',
        },
      ],
    })

    useOrganizationStore.getState().clearAll()

    expect(useOrganizationStore.getState().organizations).toEqual([])
    expect(useOrganizationStore.getState().selectedOrganization).toBeNull()
    expect(useOrganizationStore.getState().lastOpenedOrganizationId).toBe(lastOpened.id)
    expect(useOrganizationStore.getState().currentUserRole).toBeNull()
    expect(useOrganizationStore.getState().members).toEqual([])
  })
})
