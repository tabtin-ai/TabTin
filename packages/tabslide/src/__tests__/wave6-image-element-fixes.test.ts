/**
 * Wave 6 ImageElement 回归测试:
 * - B2-05: handleCropDrag 在 zoom≠1 时用 canvasScale 修正屏幕坐标
 * - B2-06: applyCrop / applyCircleCrop / removeCrop 操作前推入 undo 快照
 * - B2-08: reuploadOfflineImages 成功后调用 scheduleSave 回调
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

/* ══════════════════════════════════════════════════════
 * B2-05: handleCropDrag 裁剪拖拽坐标使用 zoom 修正
 * ══════════════════════════════════════════════════════ */

describe('B2-05: handleCropDrag applies zoom scaling', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../components/elements/ImageElement.tsx'),
    'utf-8',
  )

  it('reads zoom from useSlideStore.getState().zoom', () => {
    expect(src).toContain('useSlideStore.getState().zoom')
  })

  it('multiplies element dimensions by zoom before dividing screen delta', () => {
    expect(src).toMatch(/element\.width\s*\*\s*zoom/)
    expect(src).toMatch(/element\.height\s*\*\s*zoom/)
  })

  it('does not divide dx/dy by raw element.width/height (old pattern)', () => {
    const handleCropDragSection = src.slice(
      src.indexOf('const onMove = (me: MouseEvent)'),
      src.indexOf('const onUp = ()'),
    )
    const lines = handleCropDragSection.split('\n')
    const rawDivisions = lines.filter((line) =>
      /dx\s*\/\s*element\.width/.test(line) || /dy\s*\/\s*element\.height/.test(line),
    )
    expect(rawDivisions).toHaveLength(0)
  })
})

/* ══════════════════════════════════════════════════════
 * B2-06: 裁剪操作支持 Ctrl+Z 撤销
 * ══════════════════════════════════════════════════════ */

describe('B2-06: crop operations push undo snapshot', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../components/elements/ImageElement.tsx'),
    'utf-8',
  )

  it('imports useHistoryStore', () => {
    expect(src).toMatch(/import\s+\{[^}]*useHistoryStore[^}]*\}/)
  })

  it('applyCrop calls pushSnapshot before updateElement', () => {
    const applyCropBlock = src.slice(
      src.indexOf('const applyCrop'),
      src.indexOf('const applyCircleCrop'),
    )
    const snapshotIdx = applyCropBlock.indexOf('pushSnapshot')
    const updateIdx = applyCropBlock.indexOf('updateElement')
    expect(snapshotIdx).toBeGreaterThan(-1)
    expect(updateIdx).toBeGreaterThan(-1)
    expect(snapshotIdx).toBeLessThan(updateIdx)
  })

  it('applyCircleCrop calls pushSnapshot before updateElement', () => {
    const applyCircleBlock = src.slice(
      src.indexOf('const applyCircleCrop'),
      src.indexOf('const removeCrop'),
    )
    const snapshotIdx = applyCircleBlock.indexOf('pushSnapshot')
    const updateIdx = applyCircleBlock.indexOf('updateElement')
    expect(snapshotIdx).toBeGreaterThan(-1)
    expect(updateIdx).toBeGreaterThan(-1)
    expect(snapshotIdx).toBeLessThan(updateIdx)
  })

  it('removeCrop calls pushSnapshot before updateElement', () => {
    const removeCropBlock = src.slice(
      src.indexOf('const removeCrop'),
      src.indexOf('const isCurrentlyEllipse'),
    )
    const snapshotIdx = removeCropBlock.indexOf('pushSnapshot')
    const updateIdx = removeCropBlock.indexOf('updateElement')
    expect(snapshotIdx).toBeGreaterThan(-1)
    expect(updateIdx).toBeGreaterThan(-1)
    expect(snapshotIdx).toBeLessThan(updateIdx)
  })
})

/* ══════════════════════════════════════════════════════
 * B2-08: reuploadOfflineImages 成功后触发保存
 * ══════════════════════════════════════════════════════ */

describe('B2-08: reuploadOfflineImages triggers save on success', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../utils/image-reupload.ts'),
    'utf-8',
  )

  it('reuploadOfflineImages accepts scheduleSave parameter', () => {
    expect(src).toMatch(/reuploadOfflineImages\(\s*\n?\s*uploadFn.*,\s*\n?\s*scheduleSave/)
  })

  it('calls scheduleSave when successCount > 0', () => {
    expect(src).toMatch(/successCount\s*>\s*0\s*&&\s*scheduleSave/)
  })

  it('scheduleSave parameter is optional (backward compatible)', () => {
    expect(src).toMatch(/scheduleSave\?\s*:\s*\(\)\s*=>\s*void/)
  })
})

/* ══════════════════════════════════════════════════════
 * B2-08 (host): SlideEditorHost passes scheduleSave to reuploadOfflineImages
 * ══════════════════════════════════════════════════════ */

describe('B2-08 (host): SlideEditorHost passes save callback', () => {
  const hostSrc = fs.readFileSync(
    path.resolve(
      __dirname,
      '../../../../apps/tabtin-electron/src/renderer/src/components/slide/SlideEditorHost.tsx',
    ),
    'utf-8',
  )

  it('passes scheduleSave callback to reuploadOfflineImages', () => {
    expect(hostSrc).toMatch(/reuploadOfflineImages\(handleUploadImage,\s*\(/)
  })

  it('scheduleSave calls enqueueSave with latest presentation', () => {
    const startIdx = hostSrc.indexOf('reuploadOfflineImages(handleUploadImage')
    const reuploadBlock = hostSrc.slice(
      startIdx,
      hostSrc.indexOf('.catch((err)', startIdx),
    )
    expect(reuploadBlock).toContain('enqueueSave')
    expect(reuploadBlock).toContain('useSlideStore.getState().presentation')
  })
})
