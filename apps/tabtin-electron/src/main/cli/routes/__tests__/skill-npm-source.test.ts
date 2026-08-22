import { describe, expect, it } from 'vitest'
import {
  assertValidSkillsAddSource,
  formatNpxSkillsAddFailure,
  normalizeNpmPackageName,
  parseSkillsAddInput,
  rewriteGithubBrowserTitle,
} from '../skill-npm-source'

describe('normalizeNpmPackageName', () => {
  it('strips npm: prefix and trims', () => {
    expect(normalizeNpmPackageName('  npm:@scope/foo  ')).toBe('@scope/foo')
    expect(normalizeNpmPackageName('@scope/bar')).toBe('@scope/bar')
    expect(normalizeNpmPackageName('')).toBe('')
  })

  it('returns only the source when a full skills add command is pasted', () => {
    expect(normalizeNpmPackageName('npx skills add https://github.com/anthropics/skills --skill algorithmic-art')).toBe(
      'https://github.com/anthropics/skills',
    )
  })

  it('rewrites pasted GitHub browser titles ', () => {
    expect(
      normalizeNpmPackageName('npx skills add GitHub - anthropics/skills: Public repository for'),
    ).toBe('anthropics/skills')
    expect(
      normalizeNpmPackageName('GitHub - mattpocock/skills: A bunch of skills'),
    ).toBe('mattpocock/skills')
  })
})

describe('rewriteGithubBrowserTitle', () => {
  it('extracts owner/repo from browser tab titles', () => {
    expect(rewriteGithubBrowserTitle('GitHub - anthropics/skills: Public repository for')).toBe(
      'anthropics/skills',
    )
    expect(rewriteGithubBrowserTitle('anthropics/skills: Public repository for agents')).toBe(
      'anthropics/skills',
    )
  })
})

describe('parseSkillsAddInput', () => {
  it('parses a pasted npx skills add command with --skill', () => {
    expect(parseSkillsAddInput('npx skills add https://github.com/anthropics/skills --skill algorithmic-art')).toEqual({
      source: 'https://github.com/anthropics/skills',
      skills: ['algorithmic-art'],
    })
  })

  it('parses source with --skill and -y flags', () => {
    expect(parseSkillsAddInput('https://github.com/anthropics/skills --skill algorithmic-art -y')).toEqual({
      source: 'https://github.com/anthropics/skills',
      skills: ['algorithmic-art'],
    })
  })

  it('parses npm-prefixed package sources', () => {
    expect(parseSkillsAddInput('npm:@scope/foo')).toEqual({
      source: '@scope/foo',
      skills: [],
    })
  })

  it('skips junk leading tokens like bare npx ', () => {
    expect(parseSkillsAddInput('npx https://github.com/mattpocock/skills.git')).toEqual({
      source: 'https://github.com/mattpocock/skills.git',
      skills: [],
    })
  })
})

describe('assertValidSkillsAddSource', () => {
  it('rejects bare GitHub / npx tokens', () => {
    expect(() => assertValidSkillsAddSource('GitHub')).toThrow(/不是有效的 Skill 源/)
    expect(() => assertValidSkillsAddSource('npx')).toThrow(/不是有效的 Skill 源/)
  })

  it('accepts owner/repo and URLs', () => {
    expect(() => assertValidSkillsAddSource('anthropics/skills')).not.toThrow()
    expect(() => assertValidSkillsAddSource('https://github.com/mattpocock/skills.git')).not.toThrow()
  })
})

describe('formatNpxSkillsAddFailure', () => {
  it('strips ANSI banner and explains invalid clone source', () => {
    const raw = [
      '\u001B[38;5;250m███████╗\u001B[0m',
      'o  Source: GitHub',
      'x  Failed to clone repository',
      "|  Failed to clone GitHub: fatal: repository 'GitHub' does not exist",
      '—  Installation failed',
    ].join('\n')
    const msg = formatNpxSkillsAddFailure(raw, 'GitHub', 1)
    expect(msg).not.toMatch(/█/)
    expect(msg).toMatch(/不要粘贴浏览器标题/)
  })

  it('maps curl 28 network resets to a clear network message', () => {
    const raw = [
      'Failed to clone https://github.com/mattpocock/skills.git',
      'error: RPC failed; curl 28 Recv failure: Connection was reset',
      'fatal: expected flush after ref listing',
    ].join('\n')
    expect(formatNpxSkillsAddFailure(raw, 'https://github.com/mattpocock/skills.git', 1)).toMatch(/网络中断/)
  })
})
