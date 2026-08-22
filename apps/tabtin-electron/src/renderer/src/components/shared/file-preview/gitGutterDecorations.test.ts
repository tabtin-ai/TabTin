import { describe, expect, it } from 'vitest'
import { buildGitGutterMarkers } from './gitGutterDecorations'

describe('buildGitGutterMarkers', () => {
  it('marks added lines green', () => {
    expect(buildGitGutterMarkers('one\ntwo\n', 'one\ntwo\nthree\n')).toEqual([
      { lineNumber: 3, kind: 'added' },
    ])
  })

  it('marks replacement lines blue as modified', () => {
    expect(buildGitGutterMarkers('one\ntwo\n', 'one\nchanged\n')).toEqual([
      { lineNumber: 2, kind: 'modified' },
    ])
  })

  it('anchors a pure deletion to the following current line', () => {
    expect(buildGitGutterMarkers('one\ntwo\nthree\n', 'one\nthree\n')).toEqual([
      { lineNumber: 2, kind: 'deleted' },
    ])
  })

  it('anchors a deletion at the beginning to the first current line', () => {
    expect(buildGitGutterMarkers('removed\none\ntwo\n', 'one\ntwo\n')).toEqual([
      { lineNumber: 1, kind: 'deleted' },
    ])
  })

  it('keeps mixed replacement and insertion hunks independently classified', () => {
    expect(buildGitGutterMarkers('one\ntwo\nthree\n', 'one\nchanged\nthree\nfour\n')).toEqual([
      { lineNumber: 2, kind: 'modified' },
      { lineNumber: 4, kind: 'added' },
    ])
  })

  it('clamps a trailing deletion to the final line', () => {
    expect(buildGitGutterMarkers('one\ntwo\nthree\n', 'one\n')).toEqual([
      { lineNumber: 1, kind: 'deleted' },
    ])
  })

  it('anchors deletion of the whole file to line one', () => {
    expect(buildGitGutterMarkers('one\ntwo\n', '')).toEqual([
      { lineNumber: 1, kind: 'deleted' },
    ])
  })

  it('treats an untracked file as all added', () => {
    expect(buildGitGutterMarkers('', 'one\ntwo\n')).toEqual([
      { lineNumber: 1, kind: 'added' },
      { lineNumber: 2, kind: 'added' },
    ])
  })

  it('normalizes CRLF before comparing', () => {
    expect(buildGitGutterMarkers('one\r\ntwo\r\n', 'one\ntwo\n')).toEqual([])
    expect(buildGitGutterMarkers('one\r\ntwo\r\n', 'one\r\nchanged\r\n')).toEqual([
      { lineNumber: 2, kind: 'modified' },
    ])
  })

  it('returns no markers for equal content', () => {
    expect(buildGitGutterMarkers('same\n', 'same\n')).toEqual([])
  })
})
