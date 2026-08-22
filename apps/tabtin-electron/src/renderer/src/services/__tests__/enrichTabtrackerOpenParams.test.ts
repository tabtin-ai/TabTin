/**
 * enrichTabtrackerOpenParams — Tracker 预览链接打开时补 meta.taskId
 *
 * 回归：Agent 对话里 tabtin://resource/tracker/<id> 经 ResourceRouter 落地后，
 * 若不写 meta.taskId，tabtrackerHandler.renderPane 会落到列表面板而非详情。
 */

import { describe, it, expect } from 'vitest'
import { enrichTabtrackerOpenParams } from '../resourceRouter'

describe('enrichTabtrackerOpenParams', () => {
  it('type=tabtracker 且无 meta → 注入 spaceId + taskId=id', () => {
    const out = enrichTabtrackerOpenParams(
      { type: 'tabtracker', id: 'trk-1', title: '每日同步' },
      'space-abc',
    )
    expect(out.type).toBe('tabtracker')
    expect(out.id).toBe('trk-1')
    expect(out.meta).toEqual({ spaceId: 'space-abc', taskId: 'trk-1' })
  })

  it('已有 taskId / spaceId 时不覆盖', () => {
    const out = enrichTabtrackerOpenParams(
      {
        type: 'tabtracker',
        id: 'trk-1',
        meta: { spaceId: 'space-keep', taskId: 'task-keep', runId: 'run-1' },
      },
      'space-abc',
    )
    expect(out.meta).toEqual({
      spaceId: 'space-keep',
      taskId: 'task-keep',
      runId: 'run-1',
    })
  })

  it('仅有 eventId 时复用为详情 id，并补 spaceId', () => {
    const out = enrichTabtrackerOpenParams(
      { type: 'tabtracker', id: 'panel-scope', meta: { eventId: 'evt-9' } },
      'space-abc',
    )
    expect(out.meta?.taskId).toBe('evt-9')
    expect(out.meta?.spaceId).toBe('space-abc')
    expect(out.meta?.eventId).toBe('evt-9')
  })

  it('非 tabtracker 原样返回', () => {
    const params = { type: 'tabdoc', id: 'doc-1' }
    expect(enrichTabtrackerOpenParams(params, 'space-abc')).toBe(params)
  })
})
