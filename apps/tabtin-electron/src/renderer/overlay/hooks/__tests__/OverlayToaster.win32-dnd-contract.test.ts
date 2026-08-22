/**
 * OverlayToaster：Windows 空 toast 上报 contentVisible，避免 OLE DnD 被顶层 HWND 打断。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  join(process.cwd(), 'src/renderer/overlay/components/OverlayToaster.tsx'),
  'utf8',
)

describe('OverlayToaster Windows empty-toast contract ', () => {
  it('reports toast content visibility to main for OLE DnD shield', () => {
    expect(source).toContain('setToastContentVisible')
    expect(source).toContain('hasVisible')
  })
})
