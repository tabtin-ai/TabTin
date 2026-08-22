import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/context-space/registry/homeSections/cloudResources.tsx'),
  'utf8',
)
const feishuDialogSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/context-space/feishu/FeishuImportDialog.tsx'),
  'utf8',
)
const zhContext = JSON.parse(readFileSync(
  join(process.cwd(), 'src/renderer/src/i18n/locales/zh-CN/context.json'),
  'utf8',
))
const enContext = JSON.parse(readFileSync(
  join(process.cwd(), 'src/renderer/src/i18n/locales/en-US/context.json'),
  'utf8',
))

const tooltipKeys = [
  'newFolder',
  'newResource',
  'importAction',
  'importFolderAction',
  'switchToGridView',
  'switchToListView',
  'batchAction',
  'batchCancel',
  'batchMove',
  'batchDelete',
  'batchSelectedCount',
]

describe('CloudResourcesHome sidebar scroll contract ', () => {
  it('sidebar list panel keeps flex-col so ScrollArea can shrink and scroll', () => {
    // 侧栏分支若只写 min-h-0 flex-1 而不 flex-col，ScrollArea 会随内容撑高、滚不动。
    expect(source).toContain("layout === 'sidebar'")
    expect(source).toMatch(
      /isSidebarLayout[\s\S]*?SIDEBAR_LIST_PANEL[\s\S]*?flex min-h-0 flex-1 flex-col/,
    )
    expect(source).toMatch(
      /isSidebarLayout[\s\S]*?SIDEBAR_LIST_PANEL_SCROLL[\s\S]*?SIDEBAR_SCROLLBAR_TYPE/,
    )
  })

  it('cloud-docs sidebar create lives beside search on all-view (not CloudResourcesHome)', () => {
    // 新建在「全部」搜索行；CloudResourcesHome 侧栏不再渲染 create dropdown
    expect(source).not.toContain('data-testid="cloud-docs-sidebar-create"')
    expect(source).not.toContain('showSidebarCreate')
    expect(source).toContain('createHandlersFromProp')
    expect(source).toContain('createCloudResourceInFolder(createHandlers, appId, browseFolderId)')
  })
})

describe('CloudResourcesHome create menu external resources', () => {
  it('includes 外部资源 / 飞书 entry and FeishuImportDialog wiring', () => {
    expect(source).toContain("useEffectiveFeature('feishu_import', organizationId)")
    expect(source).toContain('{feishuImportEnabled ? (')
    expect(source).toContain("t('home.assetBrowser.externalResources'")
    expect(source).toContain("t('home.assetBrowser.feishu'")
    expect(source).toContain('FeishuImportDialog')
    expect(source).toContain('setFeishuImportOpen(true)')
    expect(source).toContain('{feishuImportEnabled ? (\n        <FeishuImportDialog')
    expect(source).toContain('w-[200px]')
    expect(zhContext.home.assetBrowser.externalResources).toBe('外部资源')
    expect(zhContext.home.assetBrowser.feishu).toBe('飞书')
    expect(enContext.home.assetBrowser.externalResources).toBe('External resources')
    expect(enContext.home.assetBrowser.feishu).toBe('Feishu')
  })

  it('uses a named external setup guide instead of exposing its URL', () => {
    expect(zhContext.home.assetBrowser.feishuProviderDesc).toContain('每位成员')
    expect(zhContext.home.assetBrowser.feishuSetupGuideAction).toBe('查看接入教程')
    expect(enContext.home.assetBrowser.feishuSetupGuideAction).toBe('View setup guide')
    expect(feishuDialogSource).toContain('FEISHU_SETUP_GUIDE_URL')
    expect(feishuDialogSource).toContain('openExternal?.(FEISHU_SETUP_GUIDE_URL)')
    expect(feishuDialogSource).toContain('handleOpenSetupGuide()')
    expect(JSON.stringify(zhContext)).not.toContain('https://assets.example.com')
  })
})

describe('CloudResourcesHome icon tooltip contract', () => {
  it('keeps toolbar actions labelled with text buttons and icon-only trailing controls', () => {
    expect(source).toContain("t('home.assetBrowser.newFolder'")
    expect(source).toContain("t('home.assetBrowser.createAction'")
    expect(source).toContain("t('home.assetBrowser.importFolderAction'")
    expect(source).toContain("defaultValue: '分享给我'")
    expect(source).toContain("defaultValue: '集中管理组织内的文档、表格与文件'")
    expect(source).toContain("defaultValue: '切换到宫格视图'")
    expect(source).toContain("defaultValue: '切换到列表视图'")
    expect(source).toContain("t('home.assetBrowser.batchAction'")
    expect(source).toContain("t('home.assetBrowser.batchMove'")
    expect(source).toContain("t('home.assetBrowser.batchDelete'")
    expect(source).toContain("t('home.assetBrowser.batchSelectedCount'")
    expect(source).toContain("t('home.assetBrowser.dragToAgentHint'")

    expect(source).toContain('CONTEXT_PAGE_TOOLBAR_BTN')
    expect(source).toContain('{createActionLabel}')
    expect(source).toContain('ContextPageToolbarIconButton')
    expect(source).toContain('{newFolderLabel}')
    expect(source).toContain('<FolderPlus className="h-3.5 w-3.5" />')
    expect(source).toContain('<FolderUp className="h-3.5 w-3.5" />')
    expect(source).toContain('<ContextPageToolbarImportButton')
    expect(source).toContain('icon={FileInput}')
    expect(source).toContain("setAttribute('webkitdirectory', '')")
    expect(source).not.toContain('accept={RESOURCE_IMPORT_ACCEPT}')
    expect(source).not.toContain('CONTEXT_PAGE_TOOLBAR_ICON_BTN')

    expect(source).toContain('<IconButtonTooltip content={sharedWithMeLabel}>')
    expect(source).toContain('aria-label={sharedWithMeLabel}')
    expect(source).not.toContain('title={sharedWithMeLabel}')

    expect(source).toContain('<IconButtonTooltip content={viewModeToggleLabel}>')
    expect(source).toContain('aria-label={viewModeToggleLabel}')
    expect(source).not.toContain('title={viewModeToggleLabel}')
  })

  it('opens create menu via DropdownMenu hover and defers folder input until menu close ', () => {
    expect(source).toContain('<DropdownMenu')
    expect(source).toContain('modal={false}')
    expect(source).toContain('onClick={openCreateMenuOnClick}')
    expect(source).toContain('onPointerEnter={scheduleOpenCreateMenu}')
    expect(source).toContain('onPointerLeave={scheduleCloseCreateMenu}')
    expect(source).toContain('onPointerEnter={keepCreateMenuOpen}')
    expect(source).toContain('createMenuHoveringRef')
    expect(source).toContain('<DropdownMenuSeparator')
    expect(source).toContain('startCreateFolderAfterMenuClose()')
    expect(source).toMatch(
      /startCreateFolderAfterMenuClose[\s\S]*?setCreateMenuOpenSafe\(false\)[\s\S]*?setTimeout\([\s\S]*?startCreateFolder\(\)/,
    )
    expect(source).not.toMatch(/onSelect=\{\(\) => \{\s*startCreateFolder\(\)/)
    expect(source).not.toContain('onFocus={openCreateMenu}')
    expect(source).not.toContain('<Popover')
    expect(source).not.toMatch(/CLOUD_QUICK_ACTION_TYPES[\s\S]{0,200}'tabmemo'/)
    expect(source).not.toMatch(/CLOUD_QUICK_ACTION_TYPES[\s\S]{0,200}'tabvideo'/)
    expect(source).not.toMatch(/CLOUD_RESOURCE_TYPES = new Set\(\[[\s\S]*'tabmemo'/)
    expect(source).not.toMatch(/TYPE_FILTER_BUTTONS[\s\S]{0,200}'tabmemo'/)
    // ：云盘类型筛选去掉「视频」分段；tabvideo 资源仍可出现在「全部」
    expect(source).not.toMatch(/TYPE_FILTER_BUTTONS[\s\S]{0,200}'tabvideo'/)
  })

  it('defines the new tooltip keys in supported context locales', () => {
    for (const key of tooltipKeys) {
      expect(zhContext.home.assetBrowser[key]).toBeTruthy()
      expect(enContext.home.assetBrowser[key]).toBeTruthy()
    }
    expect(zhContext.home.cloudDriveSubtitle).toBeTruthy()
    expect(enContext.home.cloudDriveSubtitle).toBeTruthy()
    expect(zhContext.home.assetBrowser.dragToAgentHint).toBeTruthy()
    expect(enContext.home.assetBrowser.dragToAgentHint).toBeTruthy()
    expect(zhContext.home.assetBrowser.importInvalidTypeDesc).toContain('{{formats}}')
    expect(enContext.home.assetBrowser.importInvalidTypeDesc).toContain('{{formats}}')
    expect(zhContext.home.assetBrowser.importFileTooLargeDesc).toContain('{{maxSizeMb}}')
    expect(enContext.home.assetBrowser.importFileTooLargeDesc).toContain('{{maxSizeMb}}')
    expect(zhContext.home.assetBrowser.importFolderSummaryDesc).toContain('{{folderName}}')
    expect(enContext.home.assetBrowser.importFolderSummaryDesc).toContain('{{folderName}}')
  })
})
