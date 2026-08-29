import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const skillsDir = resolve(__dirname, '..')

function readSkillSource(fileName: string): string {
  return readFileSync(resolve(skillsDir, fileName), 'utf8')
}

describe('SkillPanel builtin UI contract', () => {
  it('keeps Marketplace as an independent desktop panel entry', () => {
    const desktopSource = readFileSync(resolve(skillsDir, '../DesktopPanel.tsx'), 'utf8')
    const handlerSource = readFileSync(resolve(skillsDir, '../registry/handlers/marketplace.tsx'), 'utf8')

    expect(desktopSource).toContain("['capabilities', 'cloudResources', 'localResources', 'market', 'extensions', 'other']")
    expect(desktopSource).toContain("market: 'desktop.group.market'")
    expect(desktopSource).toContain("skill: 'cloudResources'")
    expect(desktopSource).toContain("marketplace: 'market'")
    expect(handlerSource).toContain("appId: 'marketplace'")
    expect(handlerSource).toContain("appEntryMode: 'panel'")
    expect(handlerSource).toContain('LazyMarketplacePanel')
  })

  it('keeps builtin source/version/toggle controls out of the detail pane', () => {
    const source = readSkillSource('SkillPanel.tsx')

    expect(source).not.toContain('onOpenFolder')
    expect(source).not.toContain('onOpenInCode')
    expect(source).not.toContain('FolderOpen')
    expect(source).toContain('SkillCurrentVersionChip')
    expect(source).toContain('SkillCategoryBadge')
    expect(source).toContain('SkillDetailActionsMenu')
    expect(source).toContain('DropdownMenuTrigger')
    expect(source).not.toContain('canShowPublishDraft')
    expect(source).not.toContain("t('skills.publishDraft')")
    expect(source).not.toContain('handlePublishDraft')
    expect(source).not.toContain('publishDialog')
  })

  it('WC：快速使用经泛化解析器（builtin 注册表 + user 库快照两套并存），详情页不再硬编码 tabtin-widget', () => {
    const source = readSkillSource('SkillPanel.tsx')
    const resolverSource = readFileSync(
      resolve(skillsDir, '../../../components/chat/composer-presets/presets/skills/skillQuickUse.ts'),
      'utf8',
    )

    // SkillPanel 去硬编码：改用 resolveSkillQuickUse，quick_use 是 preset 列表（非单个）。
    expect(source).toContain('resolveSkillQuickUse(skill)')
    expect(source).toContain('const canQuickUse = quickUseList.length > 0')
    expect(source).toContain('quickUseList.map(preset')
    expect(source).not.toContain('isTabtinWidgetQuickUseSkill')
    expect(source).not.toContain('TABTIN_WIDGET_QUICK_USE_PRESET_ID')
    expect(source).toContain('preset.presetId')
    expect(source).toContain('handleInsertQuickUse(preset)')
    expect(source).toContain('buildSkillQuickUseGeneratedState(preset)')
    expect(source).not.toContain('setActiveQuickUse')
    expect(source).not.toContain('<SkillQuickUseDialog')
    expect(source).toContain('source: \'skill_detail_quick_use\'')
    expect(source).toContain("t('skills.quickUse.sectionTitle')")

    // 解析器两套来源并存：builtin 保留 tabtin-widget 匹配；user 来源遍历 quick_use 列表动态注册 preset。
    expect(resolverSource).toContain("value === 'tabtin-widget'")
    expect(resolverSource).toContain('registerUserQuickUsePreset')
    expect(resolverSource).toContain('rendered_prompt: buildSkillQuickUsePrompt(')
    expect(resolverSource).toContain('renderer: SKILL_QUICK_USE_PREVIEW_RENDERER')
    expect(resolverSource).toContain('buildSkillQuickUseGeneratedState')
    expect(resolverSource).toContain('): ResolvedSkillQuickUse[]')
  })

  it('keeps SKILL.md reference content below metadata sections and removes bottom action bar', () => {
    const source = readSkillSource('SkillPanel.tsx')
    const skillMdIndex = source.lastIndexOf('<SkillMdEditor')

    expect(source).not.toContain('{/* Actions')
    expect(skillMdIndex).toBeGreaterThan(source.indexOf('{/* Versions'))
    expect(source).toContain('flex h-full min-h-0 flex-col px-5 py-4')
    expect(source).toContain('className="pt-5"')
    expect(source).toContain('fillRemaining')
  })

  it('我的 owner user Skill 在详情右上角显示编辑入口，正文区不重复显示', () => {
    const source = readSkillSource('SkillPanel.tsx')

    expect(source).toContain('const canShowEditAction = mineManagement && canEditFiles')
    expect(source).toContain('{canShowEditAction && (')
    expect(source).toContain('onClick={() => setEditorOpen(true)}')
    expect(source).toContain('<Pencil className="h-4 w-4" />')
    expect(source).toContain("aria-label={t('skills.editor.edit')}")
    expect(source).toContain('editableOverride={canEditFiles}')
    expect(source).toContain('hideEntryButton')
    expect(source).toContain('editorOpen={editorOpen}')
    expect(source).toContain('onEditorOpenChange={setEditorOpen}')
    expect(source).not.toContain('hideEntryButton={!mineManagement || !canEditFiles}')
  })

  it('组织精选按货架场景打开 owner 快照，只保留移出组织动作', () => {
    const panelSource = readSkillSource('SkillPanel.tsx')
    const sectionSource = readSkillSource('SkillsSection.tsx')
    const stateSource = readSkillSource('skillProductState.ts')

    expect(panelSource).toContain("if (effectiveSourceFilter === 'organization') return 'organization'")
    expect(panelSource).toContain('openDetail(skill, detailOriginForVisibleShelf(skill))')
    expect(stateSource).toContain("panelTab === 'organization'")
    expect(stateSource).toContain('&& isOrganizationSnapshot')
    expect(stateSource).toContain('canShowChangeCategory: isMineTab && isOwner && isUserSkill && !isOrganizationSnapshot')
    expect(stateSource).toContain('canShowDelete: isMineTab && isOwner && isUserSkill && !isOrganizationSnapshot')
    expect(panelSource).toContain('await deleteSkillSilent({ skillId: skill.skill_id })')
    expect(sectionSource).toContain('await deleteSkillSilent({ skillId: skill.skill_id })')
    expect(panelSource).not.toContain('updateSkillVisibilitySilent')
    expect(sectionSource).not.toContain('updateSkillVisibilitySilent')
  })

  it('does not persist enabled state for builtin config saves', () => {
    const source = readSkillSource('SkillConfigDialog.tsx')

    expect(source).toContain('const isBuiltin = isBuiltinCatalogSkill(skill)')
    expect(source).toContain('enabled: isBuiltin ? undefined : draftEnabled')
    expect(source).toContain('{!isBuiltin ? (')
  })

  it('keeps settings-page free of user-gate enable switches', () => {
    const source = readSkillSource('SkillsSection.tsx')
    const filtersSource = readSkillSource('skillPanelFilters.ts')

    expect(source).toContain("from './skillPanelFilters'")
    expect(source).toContain('isSkillEnabledInCurrentSpace')
    expect(source).not.toContain('<Switch')
    expect(source).not.toContain('canToggleSkillAvailability')
    expect(source).not.toContain('useEnableSkillMutation')
    expect(filtersSource).toContain('export function canToggleSkillAvailability')
    expect(filtersSource).toContain('return false')
    expect(filtersSource).toContain('return skill.enabled !== false')
    expect(filtersSource).not.toContain('return config?.enabled === true')
  })

  it('keeps installed marketplace skills visible in Installed groups', () => {
    const panelSource = readSkillSource('SkillPanel.tsx')
    const groupSource = readSkillSource('skillSourceGroups.ts')
    const filtersSource = readSkillSource('skillPanelFilters.ts')

    expect(groupSource).toContain("['mine', 'organization', 'builtin', 'device', 'public_market']")
    expect(groupSource).not.toContain("'unpublished'")
    // Installed 只展示已启用/已安装：内置/本机常在，user 来源按是否在本 Space 启用。
    // 纯过滤逻辑已抽到 skillPanelFilters.ts。
    expect(filtersSource).toContain("if (group === 'builtin' || group === 'device') return true")
    expect(filtersSource).toContain('return isSkillInstalledInSpace(skill, skillConfigs)')
    // 来源 chip 图标走 SOURCE_CHIP_ICONS 映射（含 public_market → Store），不再用 switch/case。
    expect(panelSource).toContain('SOURCE_CHIP_ICONS')
    expect(panelSource).toContain('public_market: Store')
    expect(panelSource).not.toContain("if (group === 'public_market') return false")
    expect(panelSource).not.toContain("if (group === 'public_market') continue")
  })

  it('技能库卡片/详情不再暴露用户总闸 Switch', () => {
    const source = readSkillSource('SkillPanel.tsx')
    const filtersSource = readSkillSource('skillPanelFilters.ts')

    expect(source).not.toContain('<Switch')
    expect(source).not.toContain('useEnableSkillMutation')
    expect(source).not.toContain('onToggleEnabled')
    expect(source).not.toContain('skills.panel.disableAction')
    expect(source).not.toContain('ReadinessDot')
    expect(filtersSource).toContain('export function canToggleSkillAvailability')
    expect(filtersSource).toContain('return false')

    const settingsSource = readSkillSource('SkillsSection.tsx')
    expect(settingsSource).toContain("if (!enabled) return t('skills.readiness.disabled')")
    expect(settingsSource).toContain('label={getReadinessLabel(readiness, enabled)}')
  })

  it('marketplace 可卸载；Mine 可删；技能库不再暴露总闸启停', () => {
    const source = readSkillSource('SkillPanel.tsx')
    const stateSource = readSkillSource('skillProductState.ts')
    const filtersSource = readSkillSource('skillPanelFilters.ts')

    expect(stateSource).toContain("export type SkillDetailKind = 'builtin' | 'my_skill' | 'organization_skill' | 'marketplace_installed'")
    expect(stateSource).toContain('canToggleAvailability: false')
    expect(stateSource).toContain("canShowUninstall: isInstalledTab && detailKind === 'marketplace_installed'")
    expect(stateSource).toContain('canShowDelete: isMineTab && isOwner && isUserSkill')
    expect(stateSource).toContain('canShowRemoveFromOrg:')
    expect(stateSource).not.toContain('canShowUnlist:')
    expect(stateSource).toContain('canShowChangeCategory: isMineTab && isOwner && isUserSkill')
    expect(source).toContain("group === 'mine' || group === 'device'")
    expect(source).toContain('{canShowMakeTeamVisible && (')
    expect(source).toContain('shareSkillToOrganization')
    expect(source).not.toContain('updateSkillVisibilitySilent')
    expect(source).toContain('shareInFlight')
    expect(filtersSource).toContain('return skill.enabled !== false')
    expect(source).toContain('<SkillCurrentVersionChip')
    expect(source).toContain("aria-label={t('skills.panel.moreActions')}")
    expect(source).toContain("t('skills.categoryDialog.menuItem')")
    expect(source).toContain('SKILL_MARKET_CATEGORY_ORDER.map((item)')
    expect(source).toContain("`skills.marketplaceCategory.${item}`")
    expect(source).not.toContain('SKILL_CATEGORY_GROUPS.map')
    expect(source).not.toContain('SKILL_CATEGORY_UNCLASSIFIED_VALUE')
    expect(source).not.toContain('const showConfigSection = !builtin || needsConfig')
  })

  it('keeps Marketplace product copy consistent', () => {
    const en = JSON.parse(readFileSync(resolve(skillsDir, '../../../i18n/locales/en-US/context.json'), 'utf8'))
    const zh = JSON.parse(readFileSync(resolve(skillsDir, '../../../i18n/locales/zh-CN/context.json'), 'utf8'))
    const panelSource = readSkillSource('SkillPanel.tsx')

    // 单一网格改版：去掉横向 tab、三分区与旧的「只看已启用」，保留来源筛选和详情抽屉。
    expect(panelSource).not.toContain('SKILL_PANEL_TABS')
    expect(panelSource).not.toContain('activeTab')
    expect(panelSource).toContain("const PINNED_SOURCE_CHIPS: TopChipGroup[] = ['mine', 'organization', 'builtin']")
    expect(panelSource).not.toContain('onlyEnabled')
    expect(panelSource).not.toContain("t('skills.panel.onlyEnabled')")
    expect(panelSource).toContain("t('skills.panel.filterAll')")
    expect(en.skills.panel.onlyEnabled).toBeUndefined()
    expect(zh.skills.panel.onlyEnabled).toBeUndefined()
    expect(en.desktop.group.market).toBe('Enhancements')
    expect(en.marketplace.tabs.skills).toBe('Skill Marketplace')
    expect(en.marketplace.tabs.apps).toBe('App Marketplace')
    expect(en.skills.readiness.disabled).toBe('Disabled')
    expect(en.skills.mineSubGroup.unpublished).toBeUndefined()
    expect(en.skills.mineSubGroupTip).toBeUndefined()
    expect(en.skills.publishDraft).toBeUndefined()
    expect(en.skills.versionHistory.button).toBe('Version history')
    expect(en.skills.versionHistory.currentButton).toBe('Current version · Version history')
    expect(zh.skills.versionHistory.currentButton).toBe('当前版本 · 版本历史')
    expect(en.skills.panel.moreActions).toBe('More actions')
    expect(en.skills.panel.enableAction).toBe('Enable')
    expect(en.skills.panel.disableAction).toBe('Disable')
    expect(en.skills.categoryDialog.menuItem).toBe('Change category')
    expect(en.skills.sourceGroup5.public_market).toBe('Skill Marketplace')
    expect(en.skills.panel.enabledSourceShort.public_market).toBe('Skill Marketplace')
    expect(en.skills.panel.enabledSourceShort.organization).toBe('Organization')
    expect(en.skillMarket.title).toBe('Skill Marketplace')
    expect(zh.desktop.group.market).toBe('增强')
    expect(zh.marketplace.tabs.skills).toBe('Skill 市场')
    expect(zh.marketplace.tabs.apps).toBe('应用市场')
    expect(zh.skills.readiness.disabled).toBe('已停用')
    expect(zh.skills.mineSubGroup.unpublished).toBeUndefined()
    expect(zh.skills.mineSubGroupTip).toBeUndefined()
    expect(zh.skills.publishDraft).toBeUndefined()
    expect(zh.skills.panel.moreActions).toBe('更多操作')
    expect(zh.skills.panel.enableAction).toBe('启用')
    expect(zh.skills.panel.disableAction).toBe('停用')
    expect(zh.skills.categoryDialog.menuItem).toBe('修改分类')
    expect(zh.skills.sourceGroup5.public_market).toBe('Skill 市场')
    expect(zh.skills.panel.enabledSourceShort.public_market).toBe('Skill 市场')
    expect(zh.skillMarket.title).toBe('Skill 市场')
  })

  it('市场卡片状态靠左，管理进入多 Agent 配置而不是技能详情抽屉', () => {
    const panelSource = readSkillSource('SkillPanel.tsx')
    const dialogSource = readSkillSource('AssignSkillToAgentDialog.tsx')

    expect(panelSource).toContain("'mr-auto text-caption font-medium'")
    expect(panelSource).toContain("t('skills.marketplace.configuredAgentCount'")
    expect(panelSource).toContain('isMarketplaceSkillManaged(skill, uid')
    expect(panelSource).not.toContain('managedInTabTin || skill.installed === true || enabled')
    expect(panelSource).not.toContain('managedInTabTin={isMineChipActive}')
    expect(panelSource).toContain('onManage ?? onOpen')
    expect(panelSource).toContain('className="mt-2.5 flex shrink-0 items-center justify-end gap-2"')
    expect(panelSource).toContain("'flex h-[128px] min-w-0 flex-col overflow-hidden")
    expect(panelSource).toContain('<MarketplaceCardText')
    expect(panelSource).toContain('lines={2}')
    expect(panelSource).toContain('const isPrimaryAction = !installed')
    expect(panelSource).toContain("!isPrimaryAction && 'bg-muted/60 hover:bg-muted'")
    expect(panelSource).not.toContain('bg-teal-700')
    expect(panelSource).toContain('{!sharedByMe && (!localDiscovery || onManage) ? (')
    expect(panelSource).toMatch(/localDiscovery[\s\S]{0,220}onManage=\{/)
    expect(panelSource).toContain('<AssignSkillToAgentDialog')

    expect(dialogSource).toContain('selectedAgentIds')
    expect(dialogSource).toContain('useAttachAgentSkillMutation')
    expect(dialogSource).toContain('useDetachAgentSkillMutation')
    expect(dialogSource).toContain('useEnableSkillMutation')
    expect(dialogSource).toContain('!isDeviceSkill(skill)')
    expect(dialogSource).toContain('!isMarketplaceMineSkill(skill, currentUserId)')
    expect(dialogSource).toContain('Promise.allSettled')
    expect(dialogSource).toContain('syncSelectionFromServer')
    expect(dialogSource).toContain('notifyManager.batch')
    expect(dialogSource).toContain('deferQueryInvalidation: true')
    expect(dialogSource).toContain("t('skills.marketplace.agentDialog.save')")
    // 批量结果先原子写回缓存，再关弹层；携带判定认 agent_enabled。
    expect(dialogSource).toContain('onOpenChange(false)')
    expect(dialogSource).toMatch(/await syncSelectionFromServer\(effectiveCanonicalKey\)[\s\S]*?onOpenChange\(false\)/)
    expect(dialogSource).toContain('isAgentCarryingSkill')
    expect(dialogSource).toContain('shouldSeedSelectionFromAssignments')
    expect(dialogSource).not.toContain('assignmentSignature')
  })

  it('市场“我的”不复用旧二级筛选，并单列当前 Space 本机发现', () => {
    const panelSource = readSkillSource('SkillPanel.tsx')
    const dialogSource = readSkillSource('AssignSkillToAgentDialog.tsx')

    expect(panelSource).toContain('const showMineScopeFilter = !marketplaceMode')
    expect(panelSource).toContain('isMarketplaceMineShelfSkill(skill, currentUserId, organizationId)')
    expect(panelSource).toContain('const machineDiscoveredSkills = useMemo')
    expect(panelSource).toContain("normalizeSkillSource(skill.source) === 'device'")
    expect(panelSource).toContain('dedupeMachineDiscoveredSkills(')
    expect(panelSource).toContain('machineDiscoveredSkills.length > 0')
    expect(panelSource).toContain('const [localDiscoverOpen, setLocalDiscoverOpen] = useState(true)')
    expect(panelSource).toContain("t('skills.marketplace.localDiscover.title')")
    expect(panelSource).toContain('skill.acquired_copy_skill_key || skill.skill_key || \'\'')
    expect(panelSource).toContain('managedSkill.acquired_copy_skill_key || managedSkill.skill_key || \'\'')
    expect(panelSource).toMatch(/localDiscovery[\s\S]{0,220}onManage=\{/)
    expect(dialogSource).toContain('!isDeviceSkill(skill)')
    expect(dialogSource).toContain('!isMarketplaceMineSkill(skill, currentUserId)')
    expect(dialogSource).toContain('skillCanonicalKey: effectiveCanonicalKey')
    expect(dialogSource).toContain('Promise.allSettled')
    expect(panelSource).not.toContain("t('skills.marketplace.localDiscover.importAction')")
    expect(panelSource).not.toContain("t('skills.marketplace.localDiscover.availableStatus')")
    expect(panelSource).not.toContain('handleImportDiscoveredSkill(skill)')
  })

  it('#8955：市场「+」仅在「我的」货架渲染（推荐 / 组织精选不露创建入口）', () => {
    const panelSource = readSkillSource('SkillPanel.tsx')
    const mcpSource = readFileSync(
      resolve(skillsDir, '../../space-settings/McpPanel.tsx'),
      'utf8',
    )

    // 技能：+ 菜单包在 isMineChipActive 条件内
    expect(panelSource).toMatch(/\{isMineChipActive \? \(\s*<DropdownMenu>/)
    expect(panelSource).toContain("aria-label={t('skills.marketplace.actionsLabel')}")

    // 连接器：对称，仅 marketSource === 'mine'
    expect(mcpSource).toMatch(/\{marketSource === 'mine' \? \(\s*<DropdownMenu>/)
    expect(mcpSource).toContain("t('mcpConnections.marketplace.actionsLabel'")
  })

  it('#9128：推荐货架详情强制隐藏卸载；卸载前先关详情抽屉', () => {
    const panelSource = readSkillSource('SkillPanel.tsx')

    expect(panelSource).toContain('suppressUninstall={marketplaceMode && effectiveSourceFilter === \'builtin\'}')
    expect(panelSource).toContain('const canShowUninstall = canShowUninstallRaw && !suppressUninstall')
    expect(panelSource).toContain('closeDetail()')
    expect(panelSource).toMatch(/closeDetail\(\)\s*\n\s*setUninstallTarget\(skill\)/)
  })

  it('组织连接器按真实分享者展示静态快照动作', () => {
    const mcpSource = readFileSync(
      resolve(skillsDir, '../../space-settings/McpPanel.tsx'),
      'utf8',
    )

    expect(mcpSource).toContain('const sharedByMe = isOrgConnectionSharedByCurrentUser(')
    expect(mcpSource).toContain('relationLabel={sharedByMe')
    expect(mcpSource).toContain('hideAction={sharedByMe}')
    expect(mcpSource).toContain('canUninstallMarketplaceConnector')
    expect(mcpSource).toContain('shouldShowMarketplaceUninstall')
    expect(mcpSource).toContain('action: state.action')
    expect(mcpSource).toContain('onUninstall={')
    expect(mcpSource).toContain('requestUninstallConnection')
    expect(mcpSource).toContain('className="ml-auto text-caption font-medium text-primary-text"')
    expect(mcpSource).not.toContain(
      "forceManageAction\n                      onOpen={() => setCatalogDetail({\n                        kind: 'organization'",
    )
  })

  it('保存合并发布：写文件 + 按数据库发布版本自动 publish', () => {
    const editorSource = readSkillSource('SkillEditorDialog.tsx')
    const panelSource = readSkillSource('SkillPanel.tsx')
    const sectionSource = readSkillSource('SkillsSection.tsx')
    const createSource = readSkillSource('CreateSkillDialog.tsx')
    const shareSource = readSkillSource('skillShare.ts')

    // 保存 = 写本地文件 + 自动 publish（原 PublishDialog 的发布逻辑合并进保存）。
    // 发布版本只通过 version_label 进入后端，不再回写 SKILL.md frontmatter。
    // Phase B：多文件编辑器——SKILL.md 仍走 skill:write-content，发布改为递归收集整个
    // skill 目录成 files[]（取代旧的写死单文件 `files: [{ path: 'SKILL.md', content: raw }]`）。
    expect(editorSource).toContain('writeSkillContent({ spaceId, organizationId, skillKey, content:')
    expect(editorSource).toContain('publishMutation.mutateAsync')
    expect(editorSource).toContain('collectSkillFiles(')
    expect(editorSource).toContain('files: collected.files')
    expect(editorSource).not.toContain("files: [{ path: 'SKILL.md', content: raw }]")

    // 共享给组织：所有来源都物化静态快照，原件不会改成组织可见。
    expect(shareSource).toContain('shareSkillToOrganization')
    expect(shareSource).toContain("mode: 'organization_snapshot'")
    expect(shareSource).toContain("slug_conflict_policy: 'reject'")
    expect(shareSource).not.toContain("mode: 'same_skill'")
    expect(panelSource).toContain('shareSkillToOrganization')
    expect(sectionSource).toContain('shareSkillToOrganization')
    expect(panelSource).not.toContain('updateSkillVisibilitySilent')
    expect(panelSource).not.toContain('skillAlreadyHasPublishedVersion')
    expect(sectionSource).not.toContain('skillAlreadyHasPublishedVersion')
    // 组织精选：共享者卡片只显示关系状态，不再提供管理 CTA；同事仍走获取/管理。
    expect(panelSource).toContain("t('skills.marketplace.sharedByMe')")
    expect(panelSource).toContain("organizationShelf={effectiveSourceFilter === 'organization'}")
    expect(panelSource).toContain('className="ml-auto text-caption font-medium text-primary-text"')

    // 新建 = 后端 create 自动发布 0.0.1；Electron 用 skeleton_content 本地落盘，避免 dirty。
    expect(createSource).toContain('result.skeleton_content')
    expect(createSource).toContain('writeSkillContent({ spaceId, organizationId, skillKey, content: skeleton })')
    expect(createSource).not.toContain('usePublishSkillMutation')
    // 新建只负责创建；启用统一留到 Skill 详情，不在创建弹窗展示现场选择或写启用参数。
    expect(createSource).not.toContain('SkillSpacePicker')
    expect(createSource).not.toContain('const [enableAfterCreate')
    expect(createSource).not.toContain("skills.createDialog.enableAfterCreate")
    expect(createSource).not.toContain('enable_agent_ids')
    // 新建与市场筛选 / 修改分类共用 6 个一级分类，不再暴露历史 27 细分类。
    expect(createSource).toContain('SKILL_MARKET_CATEGORY_ORDER.map((item)')
    expect(createSource).toContain('t(`skills.marketplaceCategory.${item}`)')
    expect(createSource).toContain('useState<string>(SKILL_MARKET_CATEGORY_ORDER[0])')
    expect(createSource).not.toContain('SKILL_CATEGORY_GROUPS')
    // 表单变高时页脚不能溢出白底（Space 多选场景）；中间区用 DialogScrollBody 贴边滚动。
    expect(createSource).toContain('flex max-h-[85vh] max-w-md flex-col overflow-hidden')
    expect(createSource).toContain('DialogScrollBody')
    expect(createSource).toContain('DialogFooter className="shrink-0"')

    // 去掉：手动发布弹窗 + 「当前工作区 / 本地改动」中间态
    expect(panelSource).not.toContain('PublishDialog')
    expect(panelSource).not.toContain('useSkillEditState')
  })

  it('WA：版本历史经独立弹窗暴露，版本相关 hooks 封装在 SkillVersionHistoryDialog / SkillCurrentVersionChip 而非 SkillPanel', () => {
    const panelSource = readSkillSource('SkillPanel.tsx')
    const dialogSource = readSkillSource('SkillVersionHistoryDialog.tsx')
    const chipSource = readSkillSource('SkillCurrentVersionChip.tsx')
    const resolveSource = readSkillSource('skillCurrentVersion.ts')

    // 详情页挂载当前在用 chip + 版本历史弹窗；版本 hooks 不下沉到 SkillPanel。
    expect(panelSource).toContain('<SkillCurrentVersionChip')
    expect(panelSource).toContain('canShowVersionHistory')
    expect(panelSource).toContain('<SkillVersionHistoryDialog')
    expect(panelSource).not.toContain('latest_version_label || skill.version')
    expect(panelSource).not.toContain('useSkillVersionsListQuery')
    expect(panelSource).not.toContain('useActivateSkillVersionMutation')
    expect(panelSource).not.toContain('`v${skill.installed_version_seq}`')

    // 当前在用 chip 自拉版本列表解析 SemVer，禁止用 version_seq 拼展示号。
    expect(chipSource).toContain('useSkillVersionsListQuery')
    expect(chipSource).toContain('resolveCurrentSkillVersionLabel')
    expect(resolveSource).toContain('绝不')
    expect(resolveSource).not.toContain('`v${skill.installed_version_seq}`')

    // 版本切换能力集中在独立弹窗里；不暴露 Package revert（与「设为当前」重复）。
    expect(dialogSource).toContain('useSkillVersionsListQuery')
    expect(dialogSource).toContain('useActivateSkillVersionMutation')
    expect(dialogSource).not.toContain('useRevertSkillMutation')
    expect(dialogSource).not.toContain('skills.versionHistory.revert')
    expect(dialogSource).not.toContain('`v${v.version_seq}`')
  })
})
