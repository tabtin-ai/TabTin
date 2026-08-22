import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function readEditorSource(relativePath: string) {
  return readFileSync(resolve(process.cwd(), 'src/editor', relativePath), 'utf8')
}

describe('Table chrome pane active wiring ', () => {
  it('passes pane visibility into TableChromeOverlay and delete button', () => {
    const shell = readEditorSource('DocEditorViewShell.tsx')
    expect(shell).toContain('isPaneActive?: boolean')
    expect(shell).toContain('isVisible?: boolean')
    expect(shell).toContain('const tableChromeActive = isPaneActive && isVisible')
    expect(shell).toContain('<TableSelectionDeleteButton active={tableChromeActive} />')
    expect(shell).toContain('<TableChromeOverlay active={tableChromeActive} />')
  })
})
