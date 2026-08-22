/**
 * Wave 3 Editor Interaction fixes — regression tests
 *
 * P1: C1-01, C1-04, C4-04, KB-01, KB-02, KB-03, KB-04, C5-01/02, C5-04
 * P2: C5-12, C4-07, C1-06
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const readSrc = (relPath: string) =>
  fs.readFileSync(path.resolve(__dirname, relPath), 'utf-8')

const slideShowSrc = readSrc('../components/SlideShow.tsx')
const useKeyboardSrc = readSrc('../hooks/useKeyboard.ts')
const useClipboardSrc = readSrc('../hooks/useClipboard.ts')
const moveableSrc = readSrc('../components/interactive/MoveableWrapper.tsx')
const layersTabSrc = readSrc('../panels/right-sidebar/LayersTab.tsx')
const useSlideStoreSrc = readSrc('../store/slide/index.ts')
const selectionActionSrc = readSrc('../store/slide/slices/selection/action.ts')
const slideEditorSrc = readSrc('../components/SlideEditor.tsx')

const hostPath = path.resolve(
  __dirname,
  '../../../../apps/tabtin-electron/src/renderer/src/components/slide/SlideEditorHost.tsx',
)
const hostExists = fs.existsSync(hostPath)
const hostSrc = hostExists ? fs.readFileSync(hostPath, 'utf-8') : ''

// ═══════════════════════════════════════════════
// KB-01: SlideShow uses keymapManager
// ═══════════════════════════════════════════════

describe('KB-01: SlideShow uses keymapManager instead of window keydown', () => {
  it('imports keymapManager and KeyboardPriority', () => {
    expect(slideShowSrc).toContain("import { keymapManager, KeyboardPriority }")
  })

  it('registers with KeyboardPriority.OVERLAY', () => {
    expect(slideShowSrc).toContain('keymapManager.register(KeyboardPriority.OVERLAY')
  })

  it('does NOT directly addEventListener keydown on window', () => {
    expect(slideShowSrc).not.toContain("window.addEventListener('keydown'")
  })

  it('handler returns true for consumed keys', () => {
    const fnStart = slideShowSrc.indexOf('const handleKeyDown = (e: KeyboardEvent): boolean | void')
    expect(fnStart).toBeGreaterThan(-1)
    const fnBody = slideShowSrc.slice(fnStart, fnStart + 1200)
    const returnTrueCount = (fnBody.match(/return true/g) || []).length
    expect(returnTrueCount).toBeGreaterThanOrEqual(4)
  })
})

// ═══════════════════════════════════════════════
// KB-04: tryPasteClipboardImage Promise has .catch()
// ═══════════════════════════════════════════════

describe('KB-04: tryPasteClipboardImage has error handling', () => {
  it('has .catch() on the clipboard paste promise chain', () => {
    const pasteChainStart = useKeyboardSrc.indexOf('tryImage.then')
    expect(pasteChainStart).toBeGreaterThan(-1)
    const chainBlock = useKeyboardSrc.slice(pasteChainStart, pasteChainStart + 300)
    expect(chainBlock).toContain('.catch(')
  })
})

// ═══════════════════════════════════════════════
// C4-04: Paste updates cross-element references via idMap
// ═══════════════════════════════════════════════

describe('C4-04: Paste updates fromId/toId via idMap', () => {
  it('iterates newElements to update line fromId/toId', () => {
    expect(useClipboardSrc).toContain("el.type === 'line'")
    expect(useClipboardSrc).toContain('line.fromId')
    expect(useClipboardSrc).toContain('line.toId')
    expect(useClipboardSrc).toContain('idMap.has(line.fromId)')
  })
})

// ═══════════════════════════════════════════════
// C4-07 (P2): Paste unlocks locked element copies
// ═══════════════════════════════════════════════

describe('C4-07: Paste unlocks locked element copies', () => {
  it('sets locked = false after regenerateNestedIds', () => {
    const regenIdx = useClipboardSrc.indexOf('regenerateNestedIds(newEl)')
    expect(regenIdx).toBeGreaterThan(-1)
    const afterRegen = useClipboardSrc.slice(regenIdx, regenIdx + 100)
    expect(afterRegen).toContain('if (newEl.locked) newEl.locked = false')
  })
})

// ═══════════════════════════════════════════════
// C5-01+C5-02: Lock indicator positioned by targets
// ═══════════════════════════════════════════════

describe('C5-01+C5-02: Lock indicator uses targets bounding box', () => {
  it('does NOT use hardcoded left 50%', () => {
    const lockSection = moveableSrc.slice(
      moveableSrc.indexOf('lockedCount > 0'),
      moveableSrc.indexOf('lockedCount > 0') + 800,
    )
    expect(lockSection).not.toContain("left: '50%'")
  })

  it('computes position from target elements', () => {
    const lockSection = moveableSrc.slice(
      moveableSrc.indexOf('lockedCount > 0'),
      moveableSrc.indexOf('lockedCount > 0') + 800,
    )
    expect(lockSection).toContain('for (const t of targets)')
  })

  it('applies counter-zoom scaling', () => {
    const lockSection = moveableSrc.slice(
      moveableSrc.indexOf('lockedCount > 0'),
      moveableSrc.indexOf('lockedCount > 0') + 800,
    )
    expect(lockSection).toContain('1 / zoom')
  })
})

// ═══════════════════════════════════════════════
// C5-04: LayersTab expanded group allows individual member selection
// ═══════════════════════════════════════════════

describe('C5-04: LayersTab expanded group member direct selection', () => {
  it('declares onSelectDirect in LayerListProps', () => {
    expect(layersTabSrc).toContain('onSelectDirect?:')
  })

  it('member click uses onSelectDirect for non-append mode', () => {
    expect(layersTabSrc).toContain('onSelectDirect([member.id])')
  })

  it('append mode still uses onSelect', () => {
    expect(layersTabSrc).toContain('onSelect(member.id, true)')
  })
})

// ═══════════════════════════════════════════════
// C5-12 (P2): selectAll resets isEditing
// ═══════════════════════════════════════════════

describe('C5-12: selectAll resets isEditing', () => {
  it('selectAll implementation sets isEditing: false', () => {
    const implStart = selectionActionSrc.indexOf('selectAll = () => {')
    expect(implStart).toBeGreaterThan(-1)
    const body = selectionActionSrc.slice(implStart, implStart + 300)
    expect(body).toContain('isEditing: false')
  })

  it('selectAll implementation sets editingElementId: null', () => {
    const implStart = selectionActionSrc.indexOf('selectAll = () => {')
    const body = selectionActionSrc.slice(implStart, implStart + 300)
    expect(body).toContain('editingElementId: null')
  })
})

// ═══════════════════════════════════════════════
// C1-04: resetStore exists and SlideEditor calls it on unmount
// ═══════════════════════════════════════════════

describe('C1-04: resetStore for singleton cleanup', () => {
  it('useSlideStore declares resetStore action', () => {
    expect(useSlideStoreSrc).toContain('createSelectionSlice')
    expect(selectionActionSrc).toContain('resetStore')
  })

  it('resetStore resets presentation to null', () => {
    const implStart = selectionActionSrc.indexOf('resetStore = () =>')
    expect(implStart).toBeGreaterThan(-1)
    const body = selectionActionSrc.slice(implStart, implStart + 400)
    expect(body).toContain('presentation: null')
  })

  it('SlideEditor wires singleton cleanup through lifecycle helper', () => {
    expect(slideEditorSrc).toContain('attachSlideEditorStoreLifecycle')
    expect(slideEditorSrc).toContain('return attachSlideEditorStoreLifecycle()')
  })
})

// ═══════════════════════════════════════════════
// C1-01: SlideEditorHost implements handleExportImages
// ═══════════════════════════════════════════════

describe('C1-01: SlideEditorHost handleExportImages', () => {
  it.skipIf(!hostExists)('defines handleExportImages callback', () => {
    expect(hostSrc).toContain('handleExportImages')
  })

  it.skipIf(!hostExists)('calls downloadAllPagesAsImages', () => {
    expect(hostSrc).toContain('downloadAllPagesAsImages')
  })

  it.skipIf(!hostExists)('passes onExportImages to SlideEditor', () => {
    expect(hostSrc).toContain('onExportImages={handleExportImages}')
  })
})

// ═══════════════════════════════════════════════
// C1-06 (P2): Leave save deduplication
// ═══════════════════════════════════════════════

describe('C1-06: Leave save deduplication', () => {
  const freshHostSrc = hostExists ? fs.readFileSync(hostPath, 'utf-8') : ''

  it.skipIf(!hostExists)('uses hasFiredLeaveSaveRef shared ref', () => {
    expect(freshHostSrc).toContain('hasFiredLeaveSaveRef')
  })

  it.skipIf(!hostExists)('has fireLeaveSaveOnce function', () => {
    expect(freshHostSrc).toContain('fireLeaveSaveOnce')
  })

  it.skipIf(!hostExists)('registers same handler for both beforeunload and pagehide', () => {
    const beforeUnload = freshHostSrc.indexOf("addEventListener('beforeunload', fireLeaveSaveOnce")
    const pageHide = freshHostSrc.indexOf("addEventListener('pagehide', fireLeaveSaveOnce")
    expect(beforeUnload).toBeGreaterThan(-1)
    expect(pageHide).toBeGreaterThan(-1)
  })

  it.skipIf(!hostExists)('unmount cleanup also checks hasFiredLeaveSaveRef', () => {
    const marker = 'if (thumbnailRetryTimerRef.current) clearTimeout(thumbnailRetryTimerRef.current)'
    const unmountArea = freshHostSrc.indexOf(marker)
    expect(unmountArea).toBeGreaterThan(-1)
    const afterUnmount = freshHostSrc.slice(unmountArea, unmountArea + 400)
    expect(afterUnmount).toContain('hasFiredLeaveSaveRef')
  })
})
