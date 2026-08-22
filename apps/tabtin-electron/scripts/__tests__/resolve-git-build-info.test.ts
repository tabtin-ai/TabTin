import { describe, expect, it, vi } from 'vitest'
import { resolveGitBuildInfo, injectGitBuildInfoEnv } from '../resolve-git-build-info.mjs'

describe('resolveGitBuildInfo', () => {
  it('显式 env 优先于 git', () => {
    const runGit = vi.fn(() => 'deadbeefcafe')
    const info = resolveGitBuildInfo({
      env: { VITE_GIT_COMMIT: 'abc123def456', VITE_GIT_BRANCH: 'release/0.1.0' },
      runGit,
    })
    expect(info).toEqual({ commit: 'abc123def456', branch: 'release/0.1.0' })
    expect(runGit).not.toHaveBeenCalled()
  })

  it('env 为空时回退 git，detached HEAD 的 branch 置空', () => {
    const runGit = vi.fn((args) => {
      if (args.includes('--short=12')) return 'e3646f2c8bd7'
      if (args.includes('--abbrev-ref')) return 'HEAD'
      return ''
    })
    expect(resolveGitBuildInfo({ env: {}, runGit })).toEqual({
      commit: 'e3646f2c8bd7',
      branch: '',
    })
  })

  it('git 不可用时返回空字符串', () => {
    expect(resolveGitBuildInfo({ env: {}, runGit: () => '' })).toEqual({
      commit: '',
      branch: '',
    })
  })
})

describe('injectGitBuildInfoEnv', () => {
  it('只在未设置时写入 env，并打日志', () => {
    const env = {}
    const logs = []
    const info = injectGitBuildInfoEnv({
      env,
      runGit: (args) => (args.includes('--short=12') ? 'e3646f2c8bd7' : 'release-20260609-0.0.1'),
      log: (msg) => logs.push(msg),
    })
    expect(info).toEqual({ commit: 'e3646f2c8bd7', branch: 'release-20260609-0.0.1' })
    expect(env.VITE_GIT_COMMIT).toBe('e3646f2c8bd7')
    expect(env.VITE_GIT_BRANCH).toBe('release-20260609-0.0.1')
    expect(logs[0]).toContain('VITE_GIT_COMMIT="e3646f2c8bd7"')
  })

  it('不覆盖已有 env', () => {
    const env = { VITE_GIT_COMMIT: 'preset', VITE_GIT_BRANCH: 'preset-branch' }
    injectGitBuildInfoEnv({
      env,
      runGit: () => 'should-not-use',
      log: () => {},
    })
    expect(env.VITE_GIT_COMMIT).toBe('preset')
    expect(env.VITE_GIT_BRANCH).toBe('preset-branch')
  })
})
