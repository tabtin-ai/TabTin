import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const cloudSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/context-space/registry/homeSections/cloudResources.tsx'),
  'utf8',
)
const cloudDisplaySelectSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/context-space/registry/homeSections/selectCloudResourcesDisplayItems.ts'),
  'utf8',
)
const homeSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/context-space/ContextHome.tsx'),
  'utf8',
)
const menuSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/context-space/ResourceContextMenu.tsx'),
  'utf8',
)
const sharedApiSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/services/sharedResourcesApi.ts'),
  'utf8',
)

describe('#7755 cloud-docs-domain all-view is flat inventory', () => {
  it('routes displayItems through selectCloudResourcesDisplayItems', () => {
    expect(cloudSource).toContain("from './selectCloudResourcesDisplayItems'")
    expect(cloudSource).toContain('selectCloudResourcesDisplayItems({')
    expect(cloudSource).toContain('云文档域「全部」与单类型筛选同为扁平清单')
  })
})

describe('cloud-docs-domain excludes local tabfolder', () => {
  it('does not treat tabfolder as a cloud-docs resource type', () => {
    expect(cloudSource).toContain(
      "const CLOUD_DOCS_DOMAIN_TYPES = new Set(['tabdata', 'tabdoc', 'file', 'tabfiles'])",
    )
    expect(cloudSource).toContain('不含本机 tabfolder')
  })

  // ：云文档支持普通文件，不含本机 tabfolder
  it('includes plain files (file/tabfiles) but not tabfolder in cloud-docs domain', () => {
    expect(cloudSource).toContain("CLOUD_DOCS_FILE_TYPES = new Set(['file', 'tabfiles'])")
    expect(cloudSource).not.toMatch(/CLOUD_DOCS_DOMAIN_TYPES = new Set\(\[[^\]]*'tabfolder'/)
  })
})

describe('#7561 cloud drive excludes local tabfolder', () => {
  it('does not list tabfolder in CLOUD_RESOURCE_TYPES', () => {
    // 云盘白名单 spread CLOUD_FILE_RESOURCE_TYPES，后者也不含 tabfolder
    expect(cloudSource).toContain('')
    expect(cloudSource).toMatch(
      /CLOUD_RESOURCE_TYPES = new Set\(\[[\s\S]*?CLOUD_FILE_RESOURCE_TYPES/,
    )
    // 显式 'tabfolder' 不得再出现在 CLOUD_RESOURCE_TYPES 字面量里
    const typesBlock = cloudSource.match(
      /const CLOUD_RESOURCE_TYPES = new Set\(\[[\s\S]*?\]\)/,
    )?.[0] ?? ''
    expect(typesBlock).not.toContain("'tabfolder'")
  })
})

describe('#6863 cloud shared-with-me filter contract', () => {
  it('does not blind-dedupe shared items when opening 分享给我 filter', () => {
    // 展示项选择已抽到 selectCloudResourcesDisplayItems；分享筛选契约仍落在该纯函数
    expect(cloudSource).toContain('selectCloudResourcesDisplayItems({')
    expect(cloudDisplaySelectSource).toContain('if (showShared)')
    expect(cloudDisplaySelectSource).toContain('return sharedCloudItems.filter')
    expect(cloudSource).toContain('不再按 allCloudItems.resource_id 盲去重')
    expect(cloudDisplaySelectSource).toContain('dedupePreferForeignShared')

    expect(homeSource).toContain('if (sharedOnly)')
    expect(homeSource).toContain('return sharedExtraItems.filter')
  })

  it('loads TabFiles shared-with-me and gates cloud menu by can_*', () => {
    expect(sharedApiSource).toContain('/context/files/shared-with-me')
    expect(menuSource).toContain('can_share === true')
    expect(menuSource).toContain("resourceType={shareResourceType}")
    expect(menuSource).toContain("item?.item_type === 'tabfiles'")
  })

  it('labels plain-file access management as sharing a file, not inviting collaborators', () => {
    expect(menuSource).toContain("shareResourceType === 'file'")
    expect(menuSource).toContain("t('home.shareFile', { defaultValue: '分享文件' })")
  })
})
