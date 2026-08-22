import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorInstance } from 'novel'

export interface BodyDocFindMatch {
  kind: 'body'
  from: number
  to: number
}

export interface TitleDocFindMatch {
  kind: 'title'
  start: number
  end: number
}

export type DocFindMatch = BodyDocFindMatch | TitleDocFindMatch

export function isBodyDocFindMatch(match: DocFindMatch): match is BodyDocFindMatch {
  return match.kind === 'body'
}

interface SearchTextIndex {
  text: string
  positions: number[]
}

interface DocFindPluginState {
  matches: DocFindMatch[]
  activeIndex: number
  decorations: DecorationSet
}

const emptyDocFindState: DocFindPluginState = {
  matches: [],
  activeIndex: -1,
  decorations: DecorationSet.empty,
}

const docFindPluginKey = new PluginKey<DocFindPluginState>('tabdocFind')

function buildSearchTextIndex(doc: ProseMirrorNode): SearchTextIndex {
  let text = ''
  const positions: number[] = []
  let previousTextEnd = -1

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true

    if (previousTextEnd >= 0 && pos > previousTextEnd) {
      text += '\n'
      positions.push(-1)
    }

    text += node.text
    for (let i = 0; i < node.text.length; i += 1) {
      positions.push(pos + i)
    }
    previousTextEnd = pos + node.text.length
    return true
  })

  return { text, positions }
}

export function findTextInDoc(doc: ProseMirrorNode, query: string): BodyDocFindMatch[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return []

  const index = buildSearchTextIndex(doc)
  const haystack = index.text.toLocaleLowerCase()
  const matches: BodyDocFindMatch[] = []

  let start = 0
  while (start <= haystack.length - normalizedQuery.length) {
    const foundAt = haystack.indexOf(normalizedQuery, start)
    if (foundAt < 0) break

    const matchedPositions = index.positions.slice(foundAt, foundAt + normalizedQuery.length)
    if (matchedPositions.length === normalizedQuery.length && matchedPositions.every(pos => pos >= 0)) {
      matches.push({
        kind: 'body',
        from: matchedPositions[0],
        to: matchedPositions[matchedPositions.length - 1] + 1,
      })
    }

    start = foundAt + Math.max(1, normalizedQuery.length)
  }

  return matches
}

/** 文档内查找：匹配顶部标题输入框中的文本（与正文 find 同口径，大小写不敏感）。 */
export function findTextInPlaintext(text: string, query: string): TitleDocFindMatch[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const source = text ?? ''
  if (!normalizedQuery || !source.trim()) return []

  const haystack = source.toLocaleLowerCase()
  const matches: TitleDocFindMatch[] = []

  let start = 0
  while (start <= haystack.length - normalizedQuery.length) {
    const foundAt = haystack.indexOf(normalizedQuery, start)
    if (foundAt < 0) break
    matches.push({
      kind: 'title',
      start: foundAt,
      end: foundAt + normalizedQuery.length,
    })
    start = foundAt + Math.max(1, normalizedQuery.length)
  }

  return matches
}

function asElement(value: unknown): HTMLElement | null {
  if (value instanceof HTMLElement) return value
  if (value instanceof Text) return value.parentElement
  return null
}

function resolveMatchElement(editor: EditorInstance, match: BodyDocFindMatch): HTMLElement | null {
  const { view } = editor
  const direct = asElement(view.nodeDOM(match.from))
  if (direct) return direct

  try {
    const domAtPos = view.domAtPos(match.from)
    const element = asElement(domAtPos.node)
    return element?.closest('.ProseMirror > *') as HTMLElement | null
      ?? element
  } catch {
    return null
  }
}

function scrollMatchIntoContainer(editor: EditorInstance, match: BodyDocFindMatch, scrollContainer: HTMLElement): void {
  const containerRect = scrollContainer.getBoundingClientRect()
  let matchTop: number | null = null

  try {
    matchTop = editor.view.coordsAtPos(match.from).top
  } catch {
    const element = resolveMatchElement(editor, match)
    matchTop = element?.getBoundingClientRect().top ?? null
  }

  if (matchTop == null) return

  const targetTop = matchTop - containerRect.top + scrollContainer.scrollTop - (scrollContainer.clientHeight * 0.35)

  scrollContainer.scrollTo({
    top: Math.max(0, targetTop),
    behavior: 'smooth',
  })
}

export function selectTitleFindMatch(
  input: HTMLInputElement | HTMLTextAreaElement,
  _match: TitleDocFindMatch,
): void {
  if (typeof window !== 'undefined') {
    window.requestAnimationFrame(() => {
      input.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }
}

export function selectDocFindMatch(
  editor: EditorInstance,
  match: BodyDocFindMatch,
  scrollContainer?: HTMLElement | null,
): void {
  const { state, view } = editor
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, match.from)))
  if (scrollContainer && typeof window !== 'undefined') {
    window.requestAnimationFrame(() => scrollMatchIntoContainer(editor, match, scrollContainer))
  }
}

function buildDocFindDecorations(
  doc: ProseMirrorNode,
  matches: BodyDocFindMatch[],
  activeIndex: number,
): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty

  return DecorationSet.create(
    doc,
    matches.map((match, index) => Decoration.inline(
      match.from,
      match.to,
      {
        class: index === activeIndex
          ? 'tabdoc-find-match tabdoc-find-match-active'
          : 'tabdoc-find-match',
      },
    )),
  )
}

export function createDocFindExtension() {
  return Extension.create({
    name: 'tabdocFind',

    addProseMirrorPlugins() {
      return [
        new Plugin<DocFindPluginState>({
          key: docFindPluginKey,
          state: {
            init: () => emptyDocFindState,
            apply(transaction, previous, _oldState, newState) {
              const meta = transaction.getMeta(docFindPluginKey) as {
                matches: BodyDocFindMatch[]
                activeIndex: number
              } | undefined

              if (meta) {
                return {
                  matches: meta.matches,
                  activeIndex: meta.activeIndex,
                  decorations: buildDocFindDecorations(newState.doc, meta.matches, meta.activeIndex),
                }
              }

              if (transaction.docChanged && previous.matches.length > 0) {
                return {
                  ...previous,
                  decorations: previous.decorations.map(transaction.mapping, transaction.doc),
                }
              }

              return previous
            },
          },
          props: {
            decorations(state) {
              return docFindPluginKey.getState(state)?.decorations ?? DecorationSet.empty
            },
          },
        }),
      ]
    },
  })
}

export function updateDocFindDecorations(
  editor: EditorInstance,
  matches: BodyDocFindMatch[],
  activeIndex: number,
): void {
  editor.view.dispatch(editor.state.tr.setMeta(docFindPluginKey, { matches, activeIndex }))
}
