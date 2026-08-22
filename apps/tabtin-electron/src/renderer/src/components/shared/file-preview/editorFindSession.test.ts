import { describe, expect, it, vi } from 'vitest'
import { EditorFindSession, pickPreferredMatchIndex } from './editorFindSession'
import { DEFAULT_WORD_SEPARATORS } from './editorFindTypes'
import type { editor as MonacoEditorNS } from 'monaco-editor/esm/vs/editor/editor.api'

type FindMatch = MonacoEditorNS.FindMatch

function makeRange(line: number, column: number, endColumn?: number): MonacoEditorNS.IRange {
  return {
    startLineNumber: line,
    startColumn: column,
    endLineNumber: line,
    endColumn: endColumn ?? column + 3,
  }
}

function makeMatch(line: number, column: number): FindMatch {
  return { range: makeRange(line, column), matches: null } as FindMatch
}

function createMockEditor(options: {
  valueLength: number
  matches?: FindMatch[]
  model?: MonacoEditorNS.ITextModel | null
}) {
  const matches = options.matches ?? []
  const model =
    options.model === null
      ? null
      : ({
          getValueLength: () => options.valueLength,
          findMatches: vi.fn(() => matches),
        } as unknown as MonacoEditorNS.ITextModel)

  const deltaDecorations = vi.fn((_old: string[], next: unknown[]) =>
    next.map((_, i) => `dec-${i}`),
  )
  const setPosition = vi.fn()
  const revealRangeInCenter = vi.fn()
  const revealLineInCenter = vi.fn()

  const editor = {
    getModel: () => model,
    deltaDecorations,
    setPosition,
    revealRangeInCenter,
    revealLineInCenter,
    focus: vi.fn(),
  } as unknown as MonacoEditorNS.IStandaloneCodeEditor

  return {
    editor,
    model,
    deltaDecorations,
    setPosition,
    revealRangeInCenter,
    revealLineInCenter,
  }
}

describe('pickPreferredMatchIndex', () => {
  const matches = [
    { range: { startLineNumber: 2, startColumn: 1 } },
    { range: { startLineNumber: 5, startColumn: 3 } },
    { range: { startLineNumber: 5, startColumn: 10 } },
    { range: { startLineNumber: 8, startColumn: 1 } },
  ]

  it('defaults to the first match when prefer is absent', () => {
    expect(pickPreferredMatchIndex(matches)).toBe(0)
  })

  it('picks the first match on the preferred line when column is absent', () => {
    expect(pickPreferredMatchIndex(matches, { line: 5 })).toBe(1)
  })

  it('picks the closest column on the preferred line', () => {
    expect(pickPreferredMatchIndex(matches, { line: 5, column: 11 })).toBe(2)
    expect(pickPreferredMatchIndex(matches, { line: 5, column: 2 })).toBe(1)
  })

  it('falls back to the first match when the preferred line has no hits', () => {
    expect(pickPreferredMatchIndex(matches, { line: 99, column: 1 })).toBe(0)
  })
})

describe('EditorFindSession.apply', () => {
  it('returns false and does not consume key when model is empty', () => {
    const { editor, deltaDecorations, setPosition } = createMockEditor({
      valueLength: 0,
      matches: [makeMatch(3, 1)],
    })
    const session = new EditorFindSession(editor)

    expect(
      session.apply({
        query: 'foo',
        key: 1,
        preferOccurrence: { line: 3 },
      }),
    ).toBe(false)

    expect(deltaDecorations).not.toHaveBeenCalled()
    expect(setPosition).not.toHaveBeenCalled()

    // 内容到位后同一 key 仍应可 apply
    const ready = createMockEditor({
      valueLength: 12,
      matches: [makeMatch(3, 1)],
    })
    const readySession = new EditorFindSession(ready.editor)
    expect(
      readySession.apply({
        query: 'foo',
        key: 1,
        preferOccurrence: { line: 3 },
      }),
    ).toBe(true)
    expect(ready.setPosition).toHaveBeenCalledWith({ lineNumber: 3, column: 1 })
  })

  it('returns false when model is missing', () => {
    const { editor, deltaDecorations } = createMockEditor({
      valueLength: 10,
      model: null,
    })
    const session = new EditorFindSession(editor)
    expect(session.apply({ query: 'foo', key: 2 })).toBe(false)
    expect(deltaDecorations).toHaveBeenCalledWith([], [])
  })

  it('paints only the preferred hit and reveals it', () => {
    const matches = [makeMatch(2, 1), makeMatch(5, 3), makeMatch(5, 10)]
    const { editor, deltaDecorations, setPosition, revealRangeInCenter } = createMockEditor({
      valueLength: 40,
      matches,
    })
    const session = new EditorFindSession(editor)

    expect(
      session.apply({
        query: 'foo',
        key: 7,
        preferOccurrence: { line: 5, column: 11 },
      }),
    ).toBe(true)

    expect(deltaDecorations).toHaveBeenCalled()
    const next = deltaDecorations.mock.calls.at(-1)?.[1] as Array<{
      range: { startLineNumber: number; startColumn: number }
      options: { inlineClassName?: string }
    }>
    expect(next).toHaveLength(1)
    expect(next[0].range.startLineNumber).toBe(5)
    expect(next[0].range.startColumn).toBe(10)
    expect(next[0].options.inlineClassName).toBe('tabtin-editor-find-match-current')
    expect(setPosition).toHaveBeenCalledWith({ lineNumber: 5, column: 10 })
    expect(revealRangeInCenter).toHaveBeenCalled()
  })

  it('passes regex, case and whole-word options to Monaco', () => {
    const { editor, model } = createMockEditor({
      valueLength: 40,
      matches: [makeMatch(1, 1)],
    })
    const session = new EditorFindSession(editor)

    session.apply({
      query: 'Foo',
      key: 8,
      caseSensitive: false,
      isRegex: true,
      wholeWord: true,
    })

    expect(model?.findMatches).toHaveBeenCalledWith(
      'Foo',
      false,
      true,
      false,
      DEFAULT_WORD_SEPARATORS,
      false,
      5000,
    )

    session.apply({
      query: 'Ä',
      key: 9,
      caseMode: 'smart',
    })
    expect(model?.findMatches).toHaveBeenLastCalledWith(
      'Ä',
      false,
      false,
      true,
      null,
      false,
      5000,
    )
  })

  it('clear removes decorations so a full model replace will not stretch them', () => {
    const { editor, deltaDecorations } = createMockEditor({
      valueLength: 20,
      matches: [makeMatch(1, 1)],
    })
    const session = new EditorFindSession(editor)
    session.apply({ query: 'foo', key: 3 })
    deltaDecorations.mockClear()

    session.clear()
    expect(deltaDecorations).toHaveBeenCalledWith(['dec-0'], [])
  })
})
