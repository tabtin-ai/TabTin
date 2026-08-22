import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const createButtonSource = readFileSync(
  resolve(__dirname, '../SidebarCloudDocsCreateButton.tsx'),
  'utf8',
)
const panelSource = readFileSync(
  resolve(__dirname, '../SidebarCloudDocsPanel.tsx'),
  'utf8',
)
const knowledgePanelSource = readFileSync(
  resolve(__dirname, '../cloud-docs/CloudDocsKnowledgePanel.tsx'),
  'utf8',
)
const treeSource = readFileSync(
  resolve(__dirname, '../cloud-docs/CloudDocsKnowledgeTree.tsx'),
  'utf8',
)

describe('SidebarCloudDocsCreateButton placement', () => {
  it('keeps create on search row of all-view tree panel only', () => {
    expect(panelSource).not.toContain('SidebarCloudDocsHeader')
    expect(panelSource).toContain('<SidebarCloudDocsBrowseNav')
    expect(knowledgePanelSource).toContain('<SidebarCloudDocsCreateButton')
    expect(createButtonSource).toContain('data-testid="cloud-docs-sidebar-create"')
    expect(createButtonSource).toContain('SIDEBAR_CHROME_ACTION')
  })

  it('opens create menu via hover and click', () => {
    expect(createButtonSource).toContain('modal={false}')
    expect(createButtonSource).toContain('onClick={openCreateMenuOnClick}')
    expect(createButtonSource).toContain('onPointerEnter={scheduleOpenCreateMenu}')
    expect(createButtonSource).toContain('onPointerLeave={scheduleCloseCreateMenu}')
    expect(createButtonSource).toContain('onPointerEnter={keepCreateMenuOpen}')
    expect(createButtonSource).toContain('createMenuHoveringRef')
  })

  it('offers Feishu import from the cloud-docs create menu at cloud-drive root', () => {
    expect(knowledgePanelSource).toContain(
      "useEffectiveFeature('feishu_import', effectiveOrganizationId)",
    )
    expect(createButtonSource).toContain('onImportFeishu?: () => void')
    expect(createButtonSource).toContain('{onImportFeishu ? (')
    expect(createButtonSource).toContain("t('home.assetBrowser.externalResources'")
    expect(createButtonSource).toContain("t('home.assetBrowser.feishu'")
    expect(createButtonSource).toContain('onImportFeishu()')
    expect(knowledgePanelSource).toContain('<FeishuImportDialog')
    expect(knowledgePanelSource).toContain('collectionId={null}')
  })

  it('lays out search hits full-width like tree rows', () => {
    expect(treeSource).toMatch(/as="button"\s*\n\s*fullWidth/)
    expect(treeSource).not.toContain("t('sidebar:cloudDocs.tree.searchResults'")
  })

  it('wires knowledge tree load error to manual reload ', () => {
    expect(knowledgePanelSource).toContain('onRetry={refreshTree}')
    expect(treeSource).toContain('CloudDocsListLoadError')
    expect(treeSource).toContain('onRetry')
  })
})
