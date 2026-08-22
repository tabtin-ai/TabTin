import { describe, expect, it, vi } from 'vitest'

import { createCloudResourceInFolder } from '../createCloudResourceInFolder'

describe('createCloudResourceInFolder', () => {
  it('passes the current folder as collectionId to the resource create handler', () => {
    const createTabDoc = vi.fn()

    createCloudResourceInFolder(
      { tabdoc: createTabDoc },
      'tabdoc',
      'collection-1',
    )

    expect(createTabDoc).toHaveBeenCalledWith({
      collectionId: 'collection-1',
      parentDocumentId: null,
      parentItemId: null,
    })
  })

  it('passes null collectionId when creating from cloud drive root', () => {
    const createTabDoc = vi.fn()

    createCloudResourceInFolder(
      { tabdoc: createTabDoc },
      'tabdoc',
      null,
    )

    expect(createTabDoc).toHaveBeenCalledWith({
      collectionId: null,
      parentDocumentId: null,
      parentItemId: null,
    })
  })

  it('passes parentItemId for knowledge-tree child create ', () => {
    const createTabDoc = vi.fn()

    createCloudResourceInFolder(
      { tabdoc: createTabDoc },
      'tabdoc',
      null,
      { parentItemId: 'ctx-parent-1' },
    )

    expect(createTabDoc).toHaveBeenCalledWith({
      collectionId: null,
      parentDocumentId: null,
      parentItemId: 'ctx-parent-1',
    })
  })
})
