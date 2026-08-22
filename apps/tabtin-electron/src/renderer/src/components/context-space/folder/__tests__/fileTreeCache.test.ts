import { describe, expect, it } from 'vitest'
import type { FileEntry } from '../types'
import {
  isStalePathAfterDirectoryReload,
  mergeReloadedDirectoryEntries,
  pruneExpandedForReloadedDirectory,
  type FileTreeEntriesMap,
} from '../fileTreeCache'

const dir = (path: string): FileEntry => ({
  name: path.split('/').pop() ?? path,
  path,
  isDirectory: true,
  size: 0,
  modifiedAt: null,
})

const file = (path: string): FileEntry => ({
  name: path.split('/').pop() ?? path,
  path,
  isDirectory: false,
  size: 0,
  modifiedAt: null,
})

describe('fileTreeCache', () => {
  it('keeps expanded child cache when an ancestor reload finishes later', () => {
    const prev: FileTreeEntriesMap = {
      '/workspace': [dir('/workspace/src')],
      '/workspace/src': [file('/workspace/src/index.ts')],
    }

    const next = mergeReloadedDirectoryEntries(prev, '/workspace', [
      dir('/workspace/src'),
      file('/workspace/README.md'),
    ])

    expect(next['/workspace']).toEqual([
      dir('/workspace/src'),
      file('/workspace/README.md'),
    ])
    expect(next['/workspace/src']).toEqual([file('/workspace/src/index.ts')])
  })

  it('drops cache and expanded state for directories removed by a reload', () => {
    const prev: FileTreeEntriesMap = {
      '/workspace': [dir('/workspace/src')],
      '/workspace/src': [file('/workspace/src/index.ts')],
      '/workspace/src/components': [file('/workspace/src/components/App.tsx')],
    }

    const nextEntries = mergeReloadedDirectoryEntries(prev, '/workspace', [
      file('/workspace/README.md'),
    ])
    const nextExpanded = pruneExpandedForReloadedDirectory(
      new Set(['/workspace', '/workspace/src', '/workspace/src/components']),
      '/workspace',
      [file('/workspace/README.md')],
    )

    expect(nextEntries['/workspace']).toEqual([file('/workspace/README.md')])
    expect(nextEntries['/workspace/src']).toBeUndefined()
    expect(nextEntries['/workspace/src/components']).toBeUndefined()
    expect([...nextExpanded]).toEqual(['/workspace'])
  })

  it('detects stale selection after parent reload drops a renamed child', () => {
    const entries = [dir('/workspace/src-renamed'), file('/workspace/README.md')]
    expect(
      isStalePathAfterDirectoryReload('/workspace/src/index.ts', '/workspace', entries),
    ).toBe(true)
    expect(
      isStalePathAfterDirectoryReload('/workspace/src-renamed/index.ts', '/workspace', entries),
    ).toBe(false)
    expect(isStalePathAfterDirectoryReload('/workspace', '/workspace', entries)).toBe(false)
    expect(isStalePathAfterDirectoryReload(null, '/workspace', entries)).toBe(false)
  })
})
