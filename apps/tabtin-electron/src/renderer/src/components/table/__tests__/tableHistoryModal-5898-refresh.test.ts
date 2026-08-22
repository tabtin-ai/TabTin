/**
 * ：历史面板刷新风暴与 VersionItem DOM 结构回归
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const modalSourcePath = path.resolve(__dirname, '../TableHistoryModal.tsx')
const viewContainerPath = path.resolve(
  __dirname,
  '../../view/ViewContainer.tsx',
)

describe('#5898 TableHistoryModal refresh + DOM', () => {
  it('VersionItem 不再使用外层 button 嵌套内层 button', () => {
    const source = fs.readFileSync(modalSourcePath, 'utf-8')
    const versionItemStart = source.indexOf('function VersionItem(')
    const namedVersionStart = source.indexOf('function NamedVersionItem(')
    expect(versionItemStart).toBeGreaterThan(-1)
    expect(namedVersionStart).toBeGreaterThan(versionItemStart)

    const versionItemSource = source.slice(versionItemStart, namedVersionStart)
    expect(versionItemSource).toContain('role="button"')
    expect(versionItemSource).toContain('ViewConversationButton')
    expect(versionItemSource).toContain('type="button"')
    // 外层必须是 div，不能再是 <button> 包住内层操作按钮
    expect(versionItemSource).toMatch(/return \(\s*<div\b/)
    expect(versionItemSource).not.toMatch(/return \(\s*<button\b/)
  })

  it('fetchHistory / fetchNamedVersions 带 request-id 忽略乱序响应', () => {
    const source = fs.readFileSync(modalSourcePath, 'utf-8')
    expect(source).toContain('historyRequestIdRef')
    expect(source).toContain('namedVersionsRequestIdRef')
    expect(source).toContain('historyRequestIdRef.current !== requestId')
    expect(source).toContain('namedVersionsRequestIdRef.current !== requestId')
    expect(source).toContain('shouldAbsorbExternalHistoryRefresh')
    expect(source).toContain("decision === 'absorb'")
  })

  it('ViewContainer 不再用逐行 recordSig 驱动历史刷新', () => {
    const source = fs.readFileSync(viewContainerPath, 'utf-8')
    expect(source).toContain('buildTableHistoryRefreshKey')
    expect(source).not.toContain('recordSig')
    expect(source).not.toMatch(/updated_at \?\? record\.version/)
  })
})
