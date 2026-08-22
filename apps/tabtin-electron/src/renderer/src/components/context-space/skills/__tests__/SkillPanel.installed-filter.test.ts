/**
 * filterSkillsByTab · 「已安装」Tab 过滤契约
 *
 * 回归「停用即消失」bug：停用 ≠ 卸载。后端停用后保留 SkillEnablement 行
 * （installed=true、enabled=false），「已安装」Tab 必须仍展示该 skill（灰显、可原地重开），
 * 只有从没在本 Space 装过（installed=false 且无 installed_version_seq）才隐藏。
 *
 * filterSkillsByTab 是纯函数，已抽到 skillPanelFilters.ts。这里直接 import 该纯模块，
 * 不再拉起 SkillPanel 的重依赖（smartsheet-ui / table-ui 等），避免 mock 不全导致的
 * 模块求值期失败。下方少量打桩为历史保留，对纯模块无影响。
 */
import { describe, it, expect, vi } from 'vitest'
import type { SkillIndexEntry, SkillConfig } from '@/skills/types'

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: () => null,
  ScrollArea: ({ children }: any) => children,
  Input: () => null,
  toast: { success: vi.fn(), error: vi.fn() },
  Tooltip: ({ children }: any) => children,
  Switch: () => null,
  ConfirmDialog: () => null,
  DropdownMenu: ({ children }: any) => children,
  DropdownMenuTrigger: ({ children }: any) => children,
  DropdownMenuContent: ({ children }: any) => children,
  DropdownMenuItem: ({ children }: any) => children,
  DropdownMenuSeparator: () => null,
}))

vi.mock('@/hooks/queries/skills', () => ({
  useSkillsListQuery: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
  useSkillConfigsQuery: () => ({ data: {}, refetch: vi.fn() }),
  useEnableSkillMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDisableSkillMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDiscardSkillMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteSkillMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpgradeSkillMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveAsCopyMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateSkillVisibilityMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSkillContentQuery: () => ({ data: '', isLoading: false, isError: false, refetch: vi.fn() }),
  usePublishSkillMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  skillKeys: { all: ['skills'], list: (id: string) => ['skills', 'list', id], configs: (id: string) => ['skills', 'configs', id], content: (k: string) => ['skills', 'content', k] },
}))

vi.mock('@/stores/useAuthStore', () => ({ useAuthStore: (sel: any) => sel({ user: { id: 'user-1' } }) }))
vi.mock('@/stores/useSpaceStore', () => ({ useSpaceStore: (sel: any) => sel({ spaces: [{ id: 'space-1', organization_id: 'wt-1' }] }) }))
vi.mock('@/stores/useOrganizationStore', () => ({ useOrganizationStore: (sel: any) => sel({ organizations: [] }) }))
vi.mock('../useSkillSync', () => ({ useSkillSync: vi.fn() }))
vi.mock('../SkillConfigDialog', () => ({ SkillConfigDialog: () => null }))
vi.mock('../CreateSkillDialog', () => ({ CreateSkillDialog: () => null }))
vi.mock('../ImportDialog', () => ({ ImportDialog: () => null }))
vi.mock('../SkillMarketplace', () => ({ SkillMarketplace: () => null }))
vi.mock('../SkillMdEditor', () => ({ SkillMdEditor: () => null }))
vi.mock('@utils/cn', () => ({ cn: (...a: any[]) => a.filter(Boolean).join(' ') }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

const USER = 'user-1'

function mk(partial: Partial<SkillIndexEntry>): SkillIndexEntry {
  return {
    skill_id: partial.skill_key || 'id',
    name: partial.name || 'n',
    source: 'user',
    ...partial,
  } as SkillIndexEntry
}

// owner 的 user skill：停用（行还在）→ installed=true、enabled=false
const mineDisabled = mk({ skill_key: 'user:mine-disabled', owner_user_id: USER, installed: true, enabled: false, installed_version_seq: 2 })
// owner 的 user skill：启用
const mineEnabled = mk({ skill_key: 'user:mine-enabled', owner_user_id: USER, installed: true, enabled: true, installed_version_seq: 2 })
// owner 的 user skill：从没在本 Space 装过（无行）→ installed=false、无 version_seq
const mineNeverInstalled = mk({ skill_key: 'user:mine-never', owner_user_id: USER, installed: false, enabled: false })
// 团队他人发布、本 Space 已安装但停用 → 仍要留在「已安装」
const teamDisabled = mk({ skill_key: 'user:team-disabled', owner_user_id: 'other', visibility: 'organization', installed: true, enabled: false, installed_version_seq: 3 })
// 旧后端没下发 installed 字段，但有 installed_version_seq → 兜底视为已安装
const legacyInstalled = mk({ skill_key: 'user:legacy', owner_user_id: USER, enabled: false, installed_version_seq: 5 })
// 内置 / 本机：永远在「已安装」
const builtin = mk({ skill_key: 'platform:viz/widget', source: 'platform' })
const device = mk({ skill_key: 'device:cli-x', source: 'device' })
const marketplaceAppInstalled = mk({
  skill_key: 'app:tabtin-office-skills-pack/meeting-notes-to-actions',
  source: 'app',
  distribution: 'marketplace',
  installed: true,
  enabled: true,
})
const marketplaceAppUninstalled = mk({
  skill_key: 'app:tabtin-office-skills-pack/weekly-report-builder',
  source: 'app',
  distribution: 'marketplace',
  installed: false,
  enabled: false,
})

const NO_CONFIGS: Record<string, SkillConfig> = {}

describe('filterSkillsBySearch · 标题与详情', () => {
  it('搜索 /table-operator 时命中显示标题中的 slash 命令', async () => {
    const { filterSkillsBySearch } = await import('../skillPanelFilters')
    const target = mk({
      skill_id: 'table-operator',
      skill_key: 'app:tabdata/table-operator',
      source: 'app',
      name: 'Table Operator',
      description: 'Operate tabular data',
    })
    const unrelated = mk({
      skill_id: 'browser-operator',
      skill_key: 'app:tabweb/browser-operator',
      source: 'app',
      name: 'Browser Operator',
      description: 'Operate browser sessions',
    })

    const keys = filterSkillsBySearch([target, unrelated], '/table-operator').map(s => s.skill_key)

    expect(keys).toEqual(['app:tabdata/table-operator'])
  })

  it('斜杠搜索不因隐藏命名空间 tabdata 误命中 table skill', async () => {
    const { filterSkillsBySearch } = await import('../skillPanelFilters')
    const tableOperator = mk({
      skill_id: 'table-operator',
      skill_key: 'app:tabdata/table-operator',
      source: 'app',
      name: 'Table Operator',
      description: '表格结构与数据操作',
    })
    const tabdoc = mk({
      skill_id: 'tabdoc-operator',
      skill_key: 'app:tabdoc/tabdoc-operator',
      source: 'app',
      name: 'TabDoc Operator',
      description: 'Create and manage documents',
    })

    const keys = filterSkillsBySearch([tableOperator, tabdoc], '/tabd').map(s => s.skill_key)

    expect(keys).toEqual(['app:tabdoc/tabdoc-operator'])
  })

  it('斜杠搜索不会把 slash 去掉后匹配详情文案', async () => {
    const { filterSkillsBySearch } = await import('../skillPanelFilters')
    const tabdoc = mk({
      skill_id: 'tabdoc-operator',
      skill_key: 'app:tabdoc/tabdoc-operator',
      source: 'app',
      name: 'TabDoc Operator',
      description: 'Create and manage documents',
    })
    const widget = mk({
      skill_id: 'visualization/tabtin-widget',
      skill_key: 'platform:visualization/tabtin-widget',
      source: 'platform',
      name: 'Tabtin Widget',
      description: '长期可编辑产物可使用 TabDoc。',
    })

    const keys = filterSkillsBySearch([widget, tabdoc], '/tabdoc').map(s => s.skill_key)

    expect(keys).toEqual(['app:tabdoc/tabdoc-operator'])
  })

  it('普通搜索短词也可以命中详情文案', async () => {
    const { filterSkillsBySearch } = await import('../skillPanelFilters')
    const target = mk({
      skill_id: 'image-helper',
      skill_key: 'user:image-helper',
      source: 'user',
      name: 'Image Helper',
      description: 'AI image workflow',
    })
    const unrelated = mk({
      skill_id: 'document-helper',
      skill_key: 'user:document-helper',
      source: 'user',
      name: 'Document Helper',
      description: 'Draft long documents',
    })

    const keys = filterSkillsBySearch([target, unrelated], 'ai').map(s => s.skill_key)

    expect(keys).toEqual(['user:image-helper'])
  })
})

describe('filterSkillsByTab · 已安装 Tab（enabled）', () => {
  it('停用但已安装的 user/team skill 仍出现在「已安装」（核心回归）', async () => {
    const { filterSkillsByTab } = await import('../skillPanelFilters')
    const all = [mineDisabled, mineEnabled, mineNeverInstalled, teamDisabled, legacyInstalled, builtin, device]
    const keys = filterSkillsByTab('enabled', all, NO_CONFIGS, USER).map(s => s.skill_key)

    expect(keys).toContain('user:mine-disabled')
    expect(keys).toContain('user:team-disabled')
    expect(keys).toContain('user:mine-enabled')
  })

  it('从没在本 Space 装过的个人 skill 不进「已安装」', async () => {
    const { filterSkillsByTab } = await import('../skillPanelFilters')
    const keys = filterSkillsByTab('enabled', [mineNeverInstalled, mineDisabled], NO_CONFIGS, USER).map(s => s.skill_key)

    expect(keys).not.toContain('user:mine-never')
    expect(keys).toContain('user:mine-disabled')
  })

  it('内置 / 本机 skill 永远在「已安装」', async () => {
    const { filterSkillsByTab } = await import('../skillPanelFilters')
    const keys = filterSkillsByTab('enabled', [builtin, device], NO_CONFIGS, USER).map(s => s.skill_key)

    expect(keys).toContain('platform:viz/widget')
    expect(keys).toContain('device:cli-x')
  })

  it('marketplace app skill 只有安装后才进「已安装」', async () => {
    const { filterSkillsByTab } = await import('../skillPanelFilters')
    const keys = filterSkillsByTab(
      'enabled',
      [marketplaceAppInstalled, marketplaceAppUninstalled],
      NO_CONFIGS,
      USER,
    ).map(s => s.skill_key)

    expect(keys).toContain('app:tabtin-office-skills-pack/meeting-notes-to-actions')
    expect(keys).not.toContain('app:tabtin-office-skills-pack/weekly-report-builder')
  })

  it('旧后端无 installed 字段时按 installed_version_seq 兜底视为已安装', async () => {
    const { filterSkillsByTab } = await import('../skillPanelFilters')
    const keys = filterSkillsByTab('enabled', [legacyInstalled], NO_CONFIGS, USER).map(s => s.skill_key)

    expect(keys).toContain('user:legacy')
  })

  it('「我的」Tab 仍按 owner 归属，不受 installed 影响', async () => {
    const { filterSkillsByTab } = await import('../skillPanelFilters')
    const keys = filterSkillsByTab('mine', [mineNeverInstalled, mineDisabled, teamDisabled, builtin], NO_CONFIGS, USER).map(s => s.skill_key)

    expect(keys).toContain('user:mine-never')
    expect(keys).toContain('user:mine-disabled')
    expect(keys).not.toContain('user:team-disabled')
    expect(keys).not.toContain('platform:viz/widget')
  })

  it('「我的」Tab 排除组织静态快照，只保留私有原件', async () => {
    const { filterSkillsByTab } = await import('../skillPanelFilters')
    const mineShared = mk({
      skill_key: 'user:mine-shared',
      owner_user_id: USER,
      visibility: 'organization',
      installed: true,
      enabled: true,
    })
    const keys = filterSkillsByTab(
      'mine',
      [mineShared, teamDisabled, mineNeverInstalled, builtin],
      NO_CONFIGS,
      USER,
    ).map(s => s.skill_key)

    expect(keys).not.toContain('user:mine-shared')
    expect(keys).toContain('user:mine-never')
    expect(keys).not.toContain('user:team-disabled')
    expect(keys).not.toContain('platform:viz/widget')
  })

  it('组织共享 Tab：含我自己共享出去的 + 他人组织共享', async () => {
    const { filterSkillsByTab } = await import('../skillPanelFilters')
    const mineShared = mk({
      skill_key: 'user:mine-shared',
      owner_user_id: USER,
      visibility: 'organization',
      organization_id: 'org-a',
      installed: true,
      enabled: true,
    })
    const teamInOrg = mk({
      ...teamDisabled,
      organization_id: 'org-a',
    })
    const keys = filterSkillsByTab(
      'organization',
      [mineShared, teamInOrg, mineNeverInstalled, builtin],
      NO_CONFIGS,
      USER,
      'org-a',
    ).map(s => s.skill_key)

    expect(keys).toContain('user:mine-shared')
    expect(keys).toContain('user:team-disabled')
    expect(keys).not.toContain('user:mine-never')
    expect(keys).not.toContain('platform:viz/widget')
  })
})

describe('matchesSourceGroupFilter · 组织共享 chip', () => {
  it('organization chip 含 owner 自己共享的快照；mine 只保留私有原件', async () => {
    const { matchesSourceGroupFilter } = await import('../skillSourceGroups')
    const mineShared = mk({
      skill_key: 'user:mine-shared',
      owner_user_id: USER,
      visibility: 'organization',
      organization_id: 'org-a',
    })
    const otherShared = mk({
      skill_key: 'user:other-shared',
      owner_user_id: 'other',
      visibility: 'organization',
      organization_id: 'org-a',
    })
    const minePrivate = mk({
      skill_key: 'user:mine-private',
      owner_user_id: USER,
      visibility: 'private',
    })

    expect(matchesSourceGroupFilter(mineShared, 'organization', USER, 'org-a')).toBe(true)
    expect(matchesSourceGroupFilter(otherShared, 'organization', USER, 'org-a')).toBe(true)
    expect(matchesSourceGroupFilter(minePrivate, 'organization', USER, 'org-a')).toBe(false)
    expect(matchesSourceGroupFilter(mineShared, 'mine', USER, 'org-a')).toBe(false)
  })

  it('#8678：组织精选只保留挂在当前组织的 skill', async () => {
    const { matchesSourceGroupFilter, isOrganizationSharedUserSkill } = await import('../skillSourceGroups')
    const sharedToA = mk({
      skill_key: 'user:shared-a',
      owner_user_id: USER,
      visibility: 'organization',
      organization_id: 'org-a',
    })
    const sharedToB = mk({
      skill_key: 'user:shared-b',
      owner_user_id: USER,
      visibility: 'organization',
      organization_id: 'org-b',
    })
    const missingOrg = mk({
      skill_key: 'user:shared-missing',
      owner_user_id: 'other',
      visibility: 'organization',
    })

    expect(isOrganizationSharedUserSkill(sharedToA, 'org-a')).toBe(true)
    expect(isOrganizationSharedUserSkill(sharedToB, 'org-a')).toBe(false)
    expect(isOrganizationSharedUserSkill(missingOrg, 'org-a')).toBe(false)
    expect(matchesSourceGroupFilter(sharedToA, 'organization', USER, 'org-a')).toBe(true)
    expect(matchesSourceGroupFilter(sharedToB, 'organization', USER, 'org-a')).toBe(false)
    expect(matchesSourceGroupFilter(sharedToB, 'organization', USER, null)).toBe(false)
  })
})

describe('问题2 去重 · 本机折叠进「我的」', () => {
  it('classifyTopChipGroup：device → mine；自己的组织快照只归 organization', async () => {
    const { classifyTopChipGroup } = await import('../skillSourceGroups')
    expect(classifyTopChipGroup(device, USER)).toBe('mine')
    expect(classifyTopChipGroup(mk({ skill_key: 'user:mine', owner_user_id: USER }), USER)).toBe('mine')
    expect(classifyTopChipGroup(builtin, USER)).toBe('builtin')
    expect(classifyTopChipGroup(mk({
      skill_key: 'app:tabtin-workflow-skills-pack/grill-before-build',
      source: 'app',
      distribution: 'marketplace',
      app_id: 'tabtin-workflow-skills-pack',
    }), USER)).toBe('builtin')
    expect(classifyTopChipGroup(marketplaceAppInstalled, USER)).toBe('public_market')
    expect(classifyTopChipGroup(teamDisabled, USER)).toBe('organization')
    expect(classifyTopChipGroup(
      mk({ skill_key: 'user:mine-shared', owner_user_id: USER, visibility: 'organization' }),
      USER,
    )).toBe('organization')
  })

  it('matchesTopChipFilter：自己的组织快照只在 organization，不与 mine 双出现', async () => {
    const { matchesTopChipFilter } = await import('../skillSourceGroups')
    const mine = mk({ skill_key: 'user:mine', owner_user_id: USER, visibility: 'private' })
    const mineOrg = mk({
      skill_key: 'user:mine-org',
      owner_user_id: USER,
      visibility: 'organization',
      organization_id: 'org-a',
    })
    const teamInOrg = mk({
      ...teamDisabled,
      organization_id: 'org-a',
    })
    expect(matchesTopChipFilter(mine, 'mine', USER, 'org-a')).toBe(true)
    expect(matchesTopChipFilter(device, 'mine', USER, 'org-a')).toBe(true)
    expect(matchesTopChipFilter(mineOrg, 'mine', USER, 'org-a')).toBe(false)
    expect(matchesTopChipFilter(mineOrg, 'organization', USER, 'org-a')).toBe(true)
    expect(matchesTopChipFilter(builtin, 'mine', USER, 'org-a')).toBe(false)
    expect(matchesTopChipFilter(teamInOrg, 'organization', USER, 'org-a')).toBe(true)
  })

  it('isRecommendedMarketCatalogSkill：只保留压缩包 pack；已获取仍留在推荐', async () => {
    const { isRecommendedMarketCatalogSkill, isMarketplaceMineSkill } = await import('../skillSourceGroups')
    expect(isRecommendedMarketCatalogSkill(builtin)).toBe(false)
    expect(isRecommendedMarketCatalogSkill(marketplaceAppUninstalled)).toBe(false)
    expect(isRecommendedMarketCatalogSkill(marketplaceAppInstalled)).toBe(false)
    const zipSkill = mk({
      skill_key: 'app:tabtin-writing-tools-pack/humanizer-zh',
      source: 'app',
      distribution: 'marketplace',
      app_id: 'tabtin-writing-tools-pack',
      category: 'writing',
    })
    expect(isRecommendedMarketCatalogSkill(zipSkill)).toBe(true)
    const acquired = mk({
      ...zipSkill,
      acquired: true,
    })
    expect(isMarketplaceMineSkill(acquired, USER)).toBe(true)
    expect(isRecommendedMarketCatalogSkill(acquired)).toBe(true)
  })

  it('matchesMineScope：owner 的组织 Skill 仍进入我的，本机只进入 device', async () => {
    const { matchesMineScope } = await import('../skillSourceGroups')
    const mine = mk({ skill_key: 'user:mine', owner_user_id: USER, visibility: 'private' })
    const mineOrg = mk({ skill_key: 'user:mine-org', owner_user_id: USER, visibility: 'organization' })
    expect(matchesMineScope(mine, 'all')).toBe(true)
    expect(matchesMineScope(device, 'all')).toBe(true)
    expect(matchesMineScope(mine, 'created')).toBe(true)
    expect(matchesMineScope(device, 'created')).toBe(false)
    expect(matchesMineScope(mineOrg, 'all')).toBe(true)
    expect(matchesMineScope(mineOrg, 'created')).toBe(true)
    expect(matchesMineScope(device, 'device')).toBe(true)
    expect(matchesMineScope(mine, 'device')).toBe(false)
  })
})

describe('统一市场「我的」归属口径', () => {
  it('分享后当前组织快照只进组织精选，我的只保留私有原件', async () => {
    const { isMarketplaceMineShelfSkill, matchesTopChipFilter } = await import('../skillSourceGroups')
    const privateOriginal = mk({
      skill_id: 'private-id',
      skill_key: 'user:222222',
      name: '222222',
      owner_user_id: USER,
      visibility: 'private',
    })
    const organizationSnapshot = mk({
      skill_id: 'snapshot-id',
      skill_key: 'user:222222-org-org-a',
      name: '222222',
      owner_user_id: USER,
      organization_id: 'org-a',
      visibility: 'organization',
      acquired: true,
    })
    const skills = [privateOriginal, organizationSnapshot]

    const mineKeys = skills
      .filter(skill => isMarketplaceMineShelfSkill(skill, USER, 'org-a'))
      .map(skill => skill.skill_key)
    const organizationKeys = skills
      .filter(skill => matchesTopChipFilter(skill, 'organization', USER, 'org-a'))
      .map(skill => skill.skill_key)

    expect(mineKeys).toEqual(['user:222222'])
    expect(organizationKeys).toEqual(['user:222222-org-org-a'])

    const acquiredFromTeammate = mk({
      skill_key: 'user:teammate-acquired',
      owner_user_id: 'other-user',
      organization_id: 'org-a',
      visibility: 'organization',
      acquired: true,
    })
    const ownedInOtherOrganization = mk({
      skill_key: 'user:owned-in-org-b',
      owner_user_id: USER,
      organization_id: 'org-b',
      visibility: 'organization',
      acquired: false,
    })
    expect(isMarketplaceMineShelfSkill(acquiredFromTeammate, USER, 'org-a')).toBe(true)
    expect(isMarketplaceMineShelfSkill(ownedInOtherOrganization, USER, 'org-a')).toBe(false)
    expect(isMarketplaceMineShelfSkill({
      ...ownedInOtherOrganization,
      acquired: true,
    }, USER, 'org-a')).toBe(false)
  })

  it('切到 B 组织后，我的只显示私有原件，A 组织快照不冒充当前组织分享', async () => {
    const { isMarketplaceMineShelfSkill } = await import('../skillSourceGroups')
    const { getSkillDetailProductState } = await import('../skillProductState')
    const privateOriginal = mk({
      skill_id: 'private-id',
      skill_key: 'user:cross-org-skill',
      owner_user_id: USER,
      visibility: 'private',
    })
    const snapshotSharedToA = mk({
      skill_id: 'snapshot-a-id',
      skill_key: 'user:cross-org-skill-org-a',
      owner_user_id: USER,
      organization_id: 'org-a',
      visibility: 'organization',
      acquired: true,
    })

    const mineInB = [privateOriginal, snapshotSharedToA]
      .filter(skill => isMarketplaceMineShelfSkill(skill, USER, 'org-b'))

    expect(mineInB.map(skill => skill.skill_key)).toEqual(['user:cross-org-skill'])
    expect(getSkillDetailProductState(mineInB[0], USER, 'mine')).toMatchObject({
      canShowMakeTeamVisible: true,
      canShowRemoveFromOrg: false,
    })
  })

  it('收录用户创建/导入/已获取；平台与 App 内置不进「我的」，本机与未获取压缩包不进主网格', async () => {
    const { isMarketplaceMineSkill } = await import('../skillSourceGroups')
    const created = mk({
      skill_key: 'user:created',
      owner_user_id: USER,
      acquired: false,
      installed: false,
    })
    const imported = mk({
      skill_key: 'user:imported',
      owner_user_id: USER,
      acquired: false,
      installed: false,
      meta: { import_source_url: 'https://example.com/imported-skill' },
    })
    const platformBuiltin = mk({
      skill_key: 'platform:device/operations',
      source: 'platform',
      acquired: false,
      installed: false,
    })
    const appOperator = mk({
      skill_key: 'app:tabdata/table-operator',
      source: 'app',
      distribution: 'builtin',
      acquired: false,
      installed: false,
    })
    const marketPackUnacquired = mk({
      skill_key: 'app:tabtin-writing-tools-pack/humanizer-zh',
      source: 'app',
      distribution: 'marketplace',
      app_id: 'tabtin-writing-tools-pack',
      acquired: false,
      installed: false,
    })
    const marketPackAcquired = mk({
      ...marketPackUnacquired,
      acquired: true,
    })
    const ownedOrganizationSnapshot = mk({
      skill_key: 'user:owned-organization-snapshot',
      owner_user_id: USER,
      visibility: 'organization',
      acquired: true,
    })

    expect(isMarketplaceMineSkill(created, USER)).toBe(true)
    expect(isMarketplaceMineSkill(imported, USER)).toBe(true)
    expect(isMarketplaceMineSkill(platformBuiltin, USER)).toBe(false)
    expect(isMarketplaceMineSkill(appOperator, USER)).toBe(false)
    expect(isMarketplaceMineSkill(marketPackUnacquired, USER)).toBe(false)
    expect(isMarketplaceMineSkill(marketPackAcquired, USER)).toBe(true)
    expect(isMarketplaceMineSkill(ownedOrganizationSnapshot, USER)).toBe(true)
    expect(isMarketplaceMineSkill(device, USER)).toBe(false)
  })

  it('列表级：其他组织的自有 Skill 进入我的，非归属组织的组织精选不可见', async () => {
    const {
      isMarketplaceMineSkill,
      matchesMineScope,
      matchesTopChipFilter,
    } = await import('../skillSourceGroups')
    const ownedInOtherOrganization = mk({
      skill_key: 'user:owned-in-org-b',
      owner_user_id: USER,
      visibility: 'organization',
      organization_id: 'org-b',
    })
    const teammateInOtherOrganization = mk({
      skill_key: 'user:teammate-in-org-b',
      owner_user_id: 'other-user',
      visibility: 'organization',
      organization_id: 'org-b',
    })
    const teammateInCurrentOrganization = mk({
      skill_key: 'user:teammate-in-org-a',
      owner_user_id: 'other-user',
      visibility: 'organization',
      organization_id: 'org-a',
    })
    const skills = [
      ownedInOtherOrganization,
      teammateInOtherOrganization,
      teammateInCurrentOrganization,
    ]

    const mineKeys = skills
      .filter(skill => isMarketplaceMineSkill(skill, USER))
      .filter(skill => matchesMineScope(skill, 'all'))
      .map(skill => skill.skill_key)
    const organizationKeys = skills
      .filter(skill => matchesTopChipFilter(skill, 'organization', USER, 'org-a'))
      .map(skill => skill.skill_key)

    expect(mineKeys).toContain('user:owned-in-org-b')
    expect(organizationKeys).toEqual(['user:teammate-in-org-a'])
  })

  // ：本人创建的 Skill 分享到组织后，组织精选货架不应再要「获取」。
  it('本人共享到组织的 Skill 即使 acquired=false 也算已管理；队友未获取则否', async () => {
    const { isMarketplaceSkillManaged } = await import('../skillSourceGroups')
    const sharedOwn = mk({
      skill_key: 'user:mine-shared',
      owner_user_id: USER,
      visibility: 'organization',
      acquired: false,
      installed: false,
    })
    const sharedOther = mk({
      skill_key: 'user:other-shared',
      owner_user_id: 'other',
      visibility: 'organization',
      acquired: false,
      installed: false,
    })
    const sharedOtherAcquired = mk({
      skill_key: 'user:other-shared-acquired',
      owner_user_id: 'other',
      visibility: 'organization',
      acquired: true,
      installed: false,
    })

    expect(isMarketplaceSkillManaged(sharedOwn, USER)).toBe(true)
    expect(isMarketplaceSkillManaged(sharedOther, USER)).toBe(false)
    expect(isMarketplaceSkillManaged(sharedOtherAcquired, USER)).toBe(true)
    expect(isMarketplaceSkillManaged(sharedOther, USER, { configuredAgentCount: 1 })).toBe(true)
    expect(isMarketplaceSkillManaged(sharedOther, USER, { localDiscovery: true })).toBe(true)
  })
})
