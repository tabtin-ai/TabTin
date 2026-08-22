import { describe, expect, it, beforeEach, vi } from 'vitest'

const warn = vi.hoisted(() => vi.fn())

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import {
  getResourceDragBlockReason,
  logResourceDragBlocked,
  resetResourceDragDiagForTests,
} from '../resourceDragDiagnostics'

describe('resourceDragDiagnostics', () => {
  beforeEach(() => {
    warn.mockClear()
    resetResourceDragDiagForTests()
  })

  it('classifies block reasons', () => {
    expect(getResourceDragBlockReason({ id: '' })).toBe('empty_id')
    expect(getResourceDragBlockReason({ id: 'local:tmp' })).toBe('local_id')
    expect(getResourceDragBlockReason({ id: 'ctx-1' }, { foreignShared: true })).toBe('foreign_shared')
    expect(getResourceDragBlockReason({ id: 'ctx-1' }, { deleting: true })).toBe('deleting')
    expect(getResourceDragBlockReason({ id: 'ctx-1' }, { batchMode: true })).toBe('batch_mode')
    expect(getResourceDragBlockReason({ id: 'ctx-1' })).toBeNull()
  })

  it('dedupes blocked logs per resource+reason', () => {
    logResourceDragBlocked({ id: '', resource_id: 'doc-1' }, 'empty_id')
    logResourceDragBlocked({ id: '', resource_id: 'doc-1' }, 'empty_id')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      'drag blocked before dragstart (draggable=false)',
      expect.objectContaining({ reason: 'empty_id', resource_id: 'doc-1' }),
    )
  })
})
