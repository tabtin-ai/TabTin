import { describe, expect, it } from 'vitest'
import {
  resolveDefaultAgentsSkillsDir,
  resolveDefaultInteropRoots,
  resolveGlobalInteropSkillDirs,
  resolveWorkspaceAgentsSkillsDir,
  resolveWorkspaceClientSkillDirs,
} from '../interop-roots.js'

describe('interop-roots', () => {
  it('defaults to ~/.agents/skills when env unset', () => {
    expect(resolveDefaultAgentsSkillsDir({}, () => '/Users/demo')).toBe(
      '/Users/demo/.agents/skills',
    )
  })

  it('respects TABTIN_AGENTS_SKILLS_DIR override', () => {
    expect(
      resolveDefaultAgentsSkillsDir(
        { TABTIN_AGENTS_SKILLS_DIR: '/custom/skills' },
        () => '/Users/demo',
      ),
    ).toBe('/custom/skills')
  })

  it('builds workspace interop path (compat: first = .agents/skills)', () => {
    expect(resolveWorkspaceAgentsSkillsDir('/repo/project')).toBe(
      '/repo/project/.agents/skills',
    )
    expect(resolveWorkspaceAgentsSkillsDir('')).toBeNull()
  })

  it('lists all client skill dirs under workspace root ', () => {
    expect(resolveWorkspaceClientSkillDirs('/repo')).toEqual([
      '/repo/.agents/skills',
      '/repo/.cursor/skills',
      '/repo/.claude/skills',
      '/repo/.codex/skills',
    ])
    expect(resolveWorkspaceClientSkillDirs('')).toEqual([])
  })

  it('lists global multi-client interop roots ', () => {
    expect(resolveGlobalInteropSkillDirs({ env: {}, homedir: () => '/Users/demo' })).toEqual([
      '/Users/demo/.agents/skills',
      '/Users/demo/.cursor/skills',
      '/Users/demo/.claude/skills',
      '/Users/demo/.codex/skills',
    ])
  })

  it('env override replaces .agents slot but keeps other clients', () => {
    expect(
      resolveGlobalInteropSkillDirs({
        env: { TABTIN_AGENTS_SKILLS_DIR: '/custom/skills' },
        homedir: () => '/Users/demo',
      }),
    ).toEqual([
      '/custom/skills',
      '/Users/demo/.cursor/skills',
      '/Users/demo/.claude/skills',
      '/Users/demo/.codex/skills',
    ])
  })

  it('dedupes global + optional workspace roots', () => {
    const roots = resolveDefaultInteropRoots({
      env: {},
      homedir: () => '/Users/demo',
      workspaceRoots: ['/Users/demo', '/repo'],
    })
    expect(roots).toEqual([
      '/Users/demo/.agents/skills',
      '/Users/demo/.cursor/skills',
      '/Users/demo/.claude/skills',
      '/Users/demo/.codex/skills',
      '/repo/.agents/skills',
      '/repo/.cursor/skills',
      '/repo/.claude/skills',
      '/repo/.codex/skills',
    ])
  })
})
