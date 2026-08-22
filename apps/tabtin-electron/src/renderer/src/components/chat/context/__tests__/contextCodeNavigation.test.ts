import { describe, expect, it } from 'vitest'

import { resolveContextCodeNavigationTarget } from '../contextCodeNavigation'

describe('context code source navigation', () => {
  it('opens relative code context paths under the Agent working directory', () => {
    const target = resolveContextCodeNavigationTarget(
      { file_path: 'src/app.ts' },
      'C:\\work\\TabTin',
    )

    expect(target).toMatchObject({
      rootPath: 'C:/work/TabTin',
      absoluteFilePath: 'C:/work/TabTin/src/app.ts',
      title: 'TabTin',
    })
    expect(target?.tabId).toBe(btoa(unescape(encodeURIComponent('C:/work/TabTin'))))
  })

  it('uses explicit context root_path when it matches the Agent working directory', () => {
    const target = resolveContextCodeNavigationTarget(
      { file_path: '/projects/source/pkg/index.ts', root_path: '/projects/source' },
      '/projects/source',
    )

    expect(target).toMatchObject({
      rootPath: '/projects/source',
      absoluteFilePath: '/projects/source/pkg/index.ts',
      title: 'source',
    })
  })

  it('accepts explicit root_path that differs from Agent working_dir when the file is inside that root', () => {
    const target = resolveContextCodeNavigationTarget(
      { file_path: '/projects/source/pkg/index.ts', root_path: '/projects/source' },
      '/projects/current-agent',
    )

    expect(target).toMatchObject({
      rootPath: '/projects/source',
      absoluteFilePath: '/projects/source/pkg/index.ts',
      title: 'source',
    })
  })

  it('resolves relative file_path against explicit root_path even when working_dir differs', () => {
    const target = resolveContextCodeNavigationTarget(
      { file_path: 'pkg/index.ts', root_path: '/projects/source' },
      '/projects/current-agent',
    )

    expect(target).toMatchObject({
      rootPath: '/projects/source',
      absoluteFilePath: '/projects/source/pkg/index.ts',
    })
  })

  it('does not open a TabCode tab when the source file is outside the resolved root', () => {
    expect(
      resolveContextCodeNavigationTarget(
        { file_path: '/tmp/outside.ts' },
        '/projects/source',
      ),
    ).toBeNull()
  })

  it('rejects absolute path that escapes the explicit root_path', () => {
    expect(
      resolveContextCodeNavigationTarget(
        { file_path: '/tmp/outside.ts', root_path: '/projects/source' },
        '/projects/source',
      ),
    ).toBeNull()
  })

  it('prefers an open TabCode root that contains the absolute file path', () => {
    const target = resolveContextCodeNavigationTarget(
      { file_path: '/projects/source/pkg/index.ts' },
      '/projects/current-agent',
      { preferredRootPaths: ['/projects/source'] },
    )

    expect(target).toMatchObject({
      rootPath: '/projects/source',
      absoluteFilePath: '/projects/source/pkg/index.ts',
    })
  })

  it('picks the longest preferred root when multiple open roots contain the file', () => {
    const target = resolveContextCodeNavigationTarget(
      { file_path: '/projects/source/pkg/index.ts', root_path: '/projects' },
      '/projects/current-agent',
      { preferredRootPaths: ['/projects', '/projects/source'] },
    )

    expect(target?.rootPath).toBe('/projects/source')
  })
})
