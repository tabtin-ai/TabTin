/**
 * desktopAppsCatalog 直接吃真实 packages/apps/<id>/app.json（vitest 走 Vite 的
 * import.meta.glob，不 mock）——断言的是 manifest 数据与映射规则的真实合成结果。
 */
import { describe, expect, it } from 'vitest'
import {
  getManifestCatalogEntry,
  getManifestDistribution,
  getManifestOrder,
  resolveSectionFromManifest,
} from './desktopAppsCatalog'

describe('resolveSectionFromManifest（manifest desktopGroup → 三分组映射）', () => {
  it('cloudResources → 协作组', () => {
    expect(resolveSectionFromManifest('tabdata')).toBe('collaborative')
    expect(resolveSectionFromManifest('tabdoc')).toBe('collaborative')
    expect(resolveSectionFromManifest('tabtracker')).toBe('collaborative')
    expect(resolveSectionFromManifest('tabslide')).toBe('collaborative')
  })

  it('localResources → 单机组', () => {
    expect(resolveSectionFromManifest('terminal')).toBe('local')
    expect(resolveSectionFromManifest('tabfolder')).toBe('local')
  })

  it('extensions → 其他组（marketplace 扩展）', () => {
    expect(resolveSectionFromManifest('cowart')).toBe('other')
  })

  it('capabilities 组语义混杂，刻意不映射 → null 交由保障名单兜底', () => {
    expect(resolveSectionFromManifest('tabweb')).toBeNull()
  })

  it('repo 内无 manifest（skill / 远端安装 app）→ null', () => {
    expect(resolveSectionFromManifest('skill')).toBeNull()
    expect(resolveSectionFromManifest('nonexistent-app')).toBeNull()
  })
})

describe('getManifestOrder / getManifestDistribution / getManifestCatalogEntry', () => {
  it('order 来自 manifest catalog.order', () => {
    expect(getManifestOrder('tabdata')).toBe(1)
    expect(getManifestOrder('tabdoc')).toBe(2)
    expect(getManifestOrder('tabtracker')).toBe(10)
  })

  it('缺 order 的 manifest 返回 undefined（tabfolder 未声明 order）', () => {
    expect(getManifestOrder('tabfolder')).toBeUndefined()
    expect(getManifestOrder('skill')).toBeUndefined()
  })

  it('distribution 来自 manifest 顶层字段', () => {
    expect(getManifestDistribution('tabdata')).toBe('builtin')
    expect(getManifestDistribution('cowart')).toBe('marketplace')
    expect(getManifestDistribution('skill')).toBeUndefined()
  })

  it('无 manifest 的 appId 返回 undefined', () => {
    expect(getManifestCatalogEntry('nonexistent-app')).toBeUndefined()
  })
})
