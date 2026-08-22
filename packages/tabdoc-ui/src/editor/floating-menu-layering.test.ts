import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function readEditorSource(relativePath: string) {
  return readFileSync(resolve(process.cwd(), 'src/editor', relativePath), 'utf8')
}

describe('TabDoc floating menu layering', () => {
  it('uses an opaque dropdown surface for slash command menus', () => {
    const floatingSurfaceSource = readEditorSource('floating-menu-surface.ts')
    const slashCommandSource = readEditorSource('slash-command.tsx')
    const editorShellSource = readEditorSource('DocEditorViewShell.tsx')
    const standaloneEditorSource = readEditorSource('DocStandaloneEditor.tsx')
    const prosemirrorStyles = readEditorSource('prosemirror.css')

    expect(floatingSurfaceSource).toContain('tabdoc-floating-menu-surface')
    expect(slashCommandSource).toContain('TABDOC_SLASH_COMMAND_MENU_CLASS')
    expect(slashCommandSource).toContain('TABDOC_FLOATING_MENU_SURFACE_CLASS')
    expect(slashCommandSource).toContain('OVERLAY_SURFACE_CLASS')
    expect(slashCommandSource).toContain('z-dropdown')
    expect(prosemirrorStyles).toContain('.tabdoc-floating-menu-surface')
    expect(prosemirrorStyles).toContain('background-color: hsl(var(--glass-bg-overlay, 0 0% 100%)) !important;')
    expect(editorShellSource).toContain('className={TABDOC_SLASH_COMMAND_MENU_CLASS}')
    expect(standaloneEditorSource).toContain('className={TABDOC_SLASH_COMMAND_MENU_CLASS}')
  })

  it('keeps bubble toolbar popovers above editor text', () => {
    const prosemirrorStyles = readEditorSource('prosemirror.css')

    expect(readEditorSource('bubble-menu.tsx')).toContain('TABDOC_FLOATING_MENU_SURFACE_CLASS')
    expect(readEditorSource('bubble-menu.tsx')).toContain('z-dropdown')
    expect(readEditorSource('selectors/node-selector.tsx')).toContain('TABDOC_FLOATING_MENU_SURFACE_CLASS')
    expect(readEditorSource('selectors/color-selector.tsx')).toContain('TABDOC_FLOATING_MENU_SURFACE_CLASS')
    expect(readEditorSource('selectors/link-selector.tsx')).toContain('TABDOC_FLOATING_MENU_SURFACE_CLASS')
    expect(prosemirrorStyles).toContain('[data-tippy-root]:has(.tabdoc-floating-menu-surface)')
    expect(prosemirrorStyles).toContain('z-index: var(--z-dropdown, 55) !important;')
    expect(prosemirrorStyles).toContain('z-index: var(--z-dropdown, 55);')
  })

  it('closes the document toolbar dropdown when the active document changes', () => {
    const editorShellSource = readEditorSource('DocEditorViewShell.tsx')
    const prosemirrorStyles = readEditorSource('prosemirror.css')
    const toolbarSource = readEditorSource('DocEditorToolbar.tsx')

    expect(editorShellSource).toContain("<DocEditorToolbar key={finalToolbarProps.doc?.id ?? 'empty-doc-toolbar'}")
    expect(toolbarSource).toContain('tabdoc-toolbar-dropdown-menu min-w-[240px]')
    expect(toolbarSource).toContain('tabdoc-toolbar-dropdown-menu min-w-[180px]')
    expect(prosemirrorStyles).toContain(".tabdoc-toolbar-dropdown-menu[data-state='closed']")
    expect(prosemirrorStyles).toContain('display: none !important;')
    expect(toolbarSource).toContain('const [moreMenuOpen, setMoreMenuOpen] = useState(false)')
    expect(toolbarSource).toContain('setMoreMenuOpen(false)')
    expect(toolbarSource).toContain('}, [doc?.id])')
    expect(toolbarSource).toContain('<DropdownMenu modal={false} open={moreMenuOpen} onOpenChange={setMoreMenuOpen}>')
  })
})
