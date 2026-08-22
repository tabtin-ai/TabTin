import { afterEach, describe, expect, it, vi } from 'vitest'
import { logGitActionFailure } from './gitActionDiagnostics'

describe('logGitActionFailure', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('redacts absolute project paths from renderer diagnostics', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rootPath = 'C:\\workspace\\secret-project'
    const relPath = 'src/App.tsx'
    const error = `fatal: pathspec 'C:\\workspace\\secret-project\\src\\App.tsx' did not match any files`

    logGitActionFailure('stage-file-tree-node', rootPath, [relPath], error)

    expect(warn).toHaveBeenCalledWith(
      '[TabCode:GitAction] failed',
      expect.objectContaining({
        action: 'stage-file-tree-node',
        rootBase: 'secret-project',
        pathCount: 1,
        error: expect.stringContaining('<git-root>'),
      }),
    )

    const diagnostics = warn.mock.calls[0]?.[1]
    expect(JSON.stringify(diagnostics)).not.toContain(rootPath)
  })
})
