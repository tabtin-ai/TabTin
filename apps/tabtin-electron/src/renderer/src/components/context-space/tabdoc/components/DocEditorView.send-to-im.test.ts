/**
 * TabDoc 编辑器宿主注入 onSendToIM / onRequestEditAccess
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
// components → tabdoc → context-space → components → src → renderer → src → tabtin-electron
const electronRoot = resolve(here, '../../../../../../..')
const repoRoot = resolve(electronRoot, '../..')
const docEditorViewSource = readFileSync(
  join(here, 'DocEditorView.tsx'),
  'utf8',
)
const docEditorToolbarSource = readFileSync(
  join(repoRoot, 'packages/tabdoc-ui/src/editor/DocEditorToolbar.tsx'),
  'utf8',
)

describe('DocEditor send-to-im host wiring', () => {
  it('exposes onSendToIM callback in tabdoc-ui toolbar', () => {
    expect(docEditorToolbarSource).toContain('onSendToIM?: () => void')
    expect(docEditorToolbarSource).toContain('onSendToIM')
  })

  it('DocEditorView opens SendToIMDialog with document resource card', () => {
    expect(docEditorViewSource).toContain('SendToIMDialog')
    expect(docEditorViewSource).toContain('onSendToIM: sendToIMResource ? handleOpenSendToIM : undefined')
    expect(docEditorViewSource).toContain("type: 'document'")
  })
})

describe('DocEditor request-edit-access host wiring', () => {
  it('exposes onRequestEditAccess in tabdoc-ui toolbar', () => {
    expect(docEditorToolbarSource).toContain('onRequestEditAccess?: () => void')
    expect(docEditorToolbarSource).toContain('requestEditAccess')
  })

  it('DocEditorView wires viewer-only request edit callback', () => {
    expect(docEditorViewSource).toContain('requestResourceEditAccess')
    expect(docEditorViewSource).toContain('onRequestEditAccess:')
    expect(docEditorViewSource).toContain('isPermissionInsufficientForEditing(currentUserRole)')
  })
})
