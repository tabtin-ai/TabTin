import { describe, expect, it } from 'vitest'
import {
  buildGitLogArgs,
  GIT_LOG_LINE_FORMAT,
  parseGitDecorate,
  parseGitLogLine,
} from '../git-log-format'

describe('buildGitLogArgs', () => {
  it('keeps the default line-history command unchanged', () => {
    expect(buildGitLogArgs()).toEqual([
      'log',
      '-n50',
      `--format=${GIT_LOG_LINE_FORMAT}`,
    ])
    expect(buildGitLogArgs({ limit: 50 })).toEqual([
      'log',
      '-n50',
      `--format=${GIT_LOG_LINE_FORMAT}`,
    ])
  })

  it('uses all-refs topo log only when graph is true', () => {
    const args = buildGitLogArgs({ graph: true })
    expect(args).toEqual([
      'log',
      '--all',
      '--topo-order',
      '--decorate=full',
      '-n200',
      '--format=%H%x1f%h%x1f%P%x1f%d%x1f%s%x1f%an%x1f%aI',
    ])
  })
})

describe('parseGitDecorate', () => {
  it('parses HEAD, local branch, remote and tag from full decorate', () => {
    expect(
      parseGitDecorate(
        ' (HEAD -> refs/heads/feat/x, refs/remotes/origin/feat/x, refs/tags/v1.2)',
      ),
    ).toEqual([
      { kind: 'head', name: 'HEAD' },
      { kind: 'branch', name: 'feat/x' },
      { kind: 'remote', name: 'origin/feat/x' },
      { kind: 'tag', name: 'v1.2' },
    ])
  })

  it('parses detached HEAD', () => {
    expect(parseGitDecorate('(HEAD)')).toEqual([{ kind: 'head', name: 'HEAD' }])
  })
})

describe('parseGitLogLine', () => {
  it('parses the default 5-field line without parents or refs', () => {
    const item = parseGitLogLine(
      'abc\x1fabc1234\x1fFix login\x1fYang\x1f2026-08-14T00:00:00+08:00',
      false,
    )
    expect(item).toEqual({
      hash: 'abc',
      shortHash: 'abc1234',
      subject: 'Fix login',
      authorName: 'Yang',
      authoredAt: '2026-08-14T00:00:00+08:00',
    })
    expect(item?.parents).toBeUndefined()
    expect(item?.refs).toBeUndefined()
  })

  it('parses graph fields into parents and refs', () => {
    const item = parseGitLogLine(
      [
        'm1',
        'm1short',
        'a1 b1',
        ' (HEAD -> refs/heads/main)',
        'Merge feat',
        'Yang',
        '2026-08-14T00:00:00+08:00',
      ].join('\x1f'),
      true,
    )
    expect(item?.parents).toEqual(['a1', 'b1'])
    expect(item?.refs).toEqual([
      { kind: 'head', name: 'HEAD' },
      { kind: 'branch', name: 'main' },
    ])
    expect(item?.subject).toBe('Merge feat')
  })
})
