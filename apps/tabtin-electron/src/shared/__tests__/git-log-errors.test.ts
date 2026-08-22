import { describe, expect, it } from 'vitest'
import { isEmptyRepositoryLogError } from '../git-log-errors'

describe('isEmptyRepositoryLogError', () => {
  it('recognizes zero-commit repository messages', () => {
    expect(
      isEmptyRepositoryLogError("fatal: your current branch 'main' does not have any commits yet"),
    ).toBe(true)
    expect(isEmptyRepositoryLogError("fatal: bad default revision 'HEAD'")).toBe(true)
  })

  it('does not treat generic or unknown-revision failures as empty repos', () => {
    expect(isEmptyRepositoryLogError('fatal: not a git repository')).toBe(false)
    expect(isEmptyRepositoryLogError('Permission denied')).toBe(false)
    expect(
      isEmptyRepositoryLogError(
        "fatal: ambiguous argument 'abc123': unknown revision or path not in the working tree",
      ),
    ).toBe(false)
  })
})
