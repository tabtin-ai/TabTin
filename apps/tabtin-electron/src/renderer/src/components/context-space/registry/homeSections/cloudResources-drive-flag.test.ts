/**
 * ：CLOUD_DOCS_SHOW_DRIVE 只收敛主导航「云文档」域的普通文件面；
 * 任务模式「更多」云盘入口与 default 呈现始终开放。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const cloudSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/context-space/registry/homeSections/cloudResources.tsx'),
  'utf8',
)
const flagsSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/utils/featureFlags.ts'),
  'utf8',
)
const desktopSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/context-space/desktopAppsModel.tsx'),
  'utf8',
)

describe('#7160 CLOUD_DOCS_SHOW_DRIVE gate', () => {
  it('defines CLOUD_DOCS_SHOW_DRIVE defaulting off', () => {
    expect(flagsSource).toContain('export const CLOUD_DOCS_SHOW_DRIVE')
    expect(flagsSource).toContain("VITE_CLOUD_DOCS_SHOW_DRIVE === 'true'")
  })

  it('keeps full DOMAIN_TYPES constant but filters via getActiveCloudDocsDomainTypes', () => {
    expect(cloudSource).toContain(
      "const CLOUD_DOCS_DOMAIN_TYPES = new Set(['tabdata', 'tabdoc', 'file', 'tabfiles'])",
    )
    expect(cloudSource).toContain('function getActiveCloudDocsDomainTypes')
    expect(cloudSource).toContain("return new Set(['tabdata', 'tabdoc'])")
    expect(cloudSource).toContain('getActiveCloudDocsDomainTypes().has(t)')
  })

  it('keeps task-mode 云盘 entry always; gates cloud-docs-domain upload/files on the flag', () => {
    expect(desktopSource).toContain("id: 'cloud-resources'")
    expect(desktopSource).not.toContain('if (CLOUD_DOCS_SHOW_DRIVE)')
    expect(desktopSource).not.toMatch(/import \{ CLOUD_DOCS_SHOW_DRIVE/)
    expect(cloudSource).toContain('(!isCloudDocsDomain || CLOUD_DOCS_SHOW_DRIVE)')
    expect(cloudSource).toContain("'tabfiles'")
  })

  it('hides batch move in 云文档 while keeping it available in 云盘', () => {
    expect(cloudSource).toMatch(
      /!isCloudDocsDomain && \(\s*<Button[\s\S]*?onClick=\{openBatchMovePicker\}/,
    )
    expect(cloudSource).toMatch(
      /!isCloudDocsDomain && \(\s*<CollectionMovePickerOverlay/,
    )
  })

  it('activates forced org collection refresh when cloud-resources becomes active ', () => {
    expect(cloudSource).toContain("apphome:cloud-resources")
    expect(cloudSource).toContain('shouldForceCloudFolderRefreshOnActivate')
    expect(cloudSource).toContain("forceRefreshOrganizationCollections(driveOrganizationId, 'activate')")
  })
})
