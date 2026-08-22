/**
 * TabTin IDE Monaco themes — muted palette.
 *
 * Light: rose keywords, violet strings, terracotta functions, teal types,
 * steel variables. Dark is the desaturated counterpart — avoid neon Dark+
 * cyan/lime.
 *
 * Registered once via configureMonacoWorkers(); consumers switch with
 * getMonacoIdeThemeName() + useMonacoThemeSync.
 */

import type * as Monaco from 'monaco-editor'

export const MONACO_IDE_THEME_DARK = 'tabtin-ide-dark'
export const MONACO_IDE_THEME_LIGHT = 'tabtin-ide-light'

/** System mono stack aligned with modern IDEs. */
export const MONACO_IDE_FONT_FAMILY =
  'ui-monospace, "SF Mono", Menlo, "Cascadia Code", Consolas, "Liberation Mono", monospace'

export const MONACO_IDE_FONT_SIZE = 12
export const MONACO_IDE_LINE_HEIGHT = 18

export function getMonacoIdeThemeName(isDark = document.documentElement.classList.contains('dark')): string {
  return isDark ? 'vs-dark' : 'vs'
}

let registered = false

/** Light: rose keywords, violet strings, terracotta funcs. */
const LIGHT_RULES: Monaco.editor.ITokenThemeRule[] = [
  { token: 'comment', foreground: '6A737D', fontStyle: 'italic' },
  { token: 'string', foreground: '8250DF' },
  { token: 'string.escape', foreground: '0550AE' },
  { token: 'keyword', foreground: 'CF2F7B' },
  { token: 'number', foreground: 'CF2F7B' },
  { token: 'regexp', foreground: 'CF2F7B' },
  { token: 'type', foreground: '1A7F8E' },
  { token: 'class', foreground: '1A7F8E' },
  { token: 'interface', foreground: '1A7F8E' },
  { token: 'namespace', foreground: '1A7F8E' },
  { token: 'type.identifier', foreground: '1A7F8E' },
  { token: 'variable', foreground: '0550AE' },
  { token: 'variable.predefined', foreground: '0550AE' },
  { token: 'identifier', foreground: '1F2328' },
  { token: 'function', foreground: 'A67C2A' },
  { token: 'member', foreground: 'A67C2A' },
  { token: 'tag', foreground: 'CF2F7B' },
  { token: 'attribute.name', foreground: '0550AE' },
  { token: 'attribute.value', foreground: '8250DF' },
  { token: 'delimiter', foreground: '1F2328' },
  { token: 'delimiter.html', foreground: '6A737D' },
  { token: 'metatag', foreground: 'CF2F7B' },
  { token: 'meta', foreground: '6A737D' },
  { token: 'constant', foreground: '0550AE' },
  { token: 'operator', foreground: '1F2328' },
]

/** Dark: muted rose/violet/teal — no neon cyan/lime. */
const DARK_RULES: Monaco.editor.ITokenThemeRule[] = [
  { token: 'comment', foreground: '6E7681', fontStyle: 'italic' },
  { token: 'string', foreground: 'B794F4' },
  { token: 'string.escape', foreground: '7EB8DA' },
  { token: 'keyword', foreground: 'D67B9C' },
  { token: 'number', foreground: 'D67B9C' },
  { token: 'regexp', foreground: 'D67B9C' },
  { token: 'type', foreground: '5EB3C0' },
  { token: 'class', foreground: '5EB3C0' },
  { token: 'interface', foreground: '5EB3C0' },
  { token: 'namespace', foreground: '5EB3C0' },
  { token: 'type.identifier', foreground: '5EB3C0' },
  { token: 'variable', foreground: '7EB8DA' },
  { token: 'variable.predefined', foreground: '7EB8DA' },
  { token: 'identifier', foreground: 'E6EDF3' },
  { token: 'function', foreground: 'D4A574' },
  { token: 'member', foreground: 'D4A574' },
  { token: 'tag', foreground: 'D67B9C' },
  { token: 'attribute.name', foreground: '7EB8DA' },
  { token: 'attribute.value', foreground: 'B794F4' },
  { token: 'delimiter', foreground: 'E6EDF3' },
  { token: 'delimiter.html', foreground: '6E7681' },
  { token: 'metatag', foreground: 'D67B9C' },
  { token: 'meta', foreground: '6E7681' },
  { token: 'constant', foreground: '7EB8DA' },
  { token: 'operator', foreground: 'E6EDF3' },
]

export function registerMonacoIdeThemes(monaco: typeof Monaco): void {
  if (registered) return
  registered = true

  monaco.editor.defineTheme(MONACO_IDE_THEME_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: DARK_RULES,
    colors: {
      'editor.background': '#1C2128',
      'editor.foreground': '#E6EDF3',
      'editorLineNumber.foreground': '#6E7681',
      'editorLineNumber.activeForeground': '#E6EDF3',
      'editor.lineHighlightBackground': '#262C36',
      'editor.selectionBackground': '#264F7880',
      'editor.inactiveSelectionBackground': '#3A3D4180',
      'editorIndentGuide.background1': '#3D444D',
      'editorIndentGuide.activeBackground1': '#6E7681',
      'editorCursor.foreground': '#E6EDF3',
      'editorWhitespace.foreground': '#3D444D',
      'editorGutter.background': '#1C2128',
      'editorWidget.background': '#262C36',
      'editorWidget.border': '#3D444D',
      'editor.findMatchBackground': '#9E6A03AA',
      'editor.findMatchHighlightBackground': '#F2CC6080',
      'diffEditor.insertedTextBackground': '#2EA04333',
      'diffEditor.removedTextBackground': '#F8514933',
      'diffEditor.insertedLineBackground': '#2EA04322',
      'diffEditor.removedLineBackground': '#F8514922',
      'scrollbarSlider.background': '#6E768166',
      'scrollbarSlider.hoverBackground': '#6E7681AA',
      'scrollbarSlider.activeBackground': '#E6EDF366',
    },
  })

  monaco.editor.defineTheme(MONACO_IDE_THEME_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: LIGHT_RULES,
    colors: {
      'editor.background': '#FFFFFF',
      'editor.foreground': '#1F2328',
      'editorLineNumber.foreground': '#8C959F',
      'editorLineNumber.activeForeground': '#1F2328',
      'editor.lineHighlightBackground': '#F6F8FA',
      'editor.selectionBackground': '#ADD6FF80',
      'editor.inactiveSelectionBackground': '#E5EBF180',
      'editorIndentGuide.background1': '#D0D7DE',
      'editorIndentGuide.activeBackground1': '#8C959F',
      'editorCursor.foreground': '#1F2328',
      'editorWhitespace.foreground': '#D0D7DE',
      'editorGutter.background': '#FFFFFF',
      'editorWidget.background': '#F6F8FA',
      'editorWidget.border': '#D0D7DE',
      'editor.findMatchBackground': '#FFDF5D99',
      'editor.findMatchHighlightBackground': '#FFDF5D66',
      'diffEditor.insertedTextBackground': '#DAFBE133',
      'diffEditor.removedTextBackground': '#FFEBE933',
      'diffEditor.insertedLineBackground': '#DAFBE166',
      'diffEditor.removedLineBackground': '#FFEBE966',
      'scrollbarSlider.background': '#8C959F66',
      'scrollbarSlider.hoverBackground': '#8C959FAA',
      'scrollbarSlider.activeBackground': '#1F232866',
    },
  })
}
