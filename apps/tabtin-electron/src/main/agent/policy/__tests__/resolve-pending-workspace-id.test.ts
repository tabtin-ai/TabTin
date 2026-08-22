import { describe, expect, it } from 'vitest'
import { resolvePendingQueryWorkspaceId } from '../resolve-pending-workspace-id'

describe('resolvePendingQueryWorkspaceId ( cold start)', () => {
  it('匹配 threadId 时返回 trim 后的 workspaceId', () => {
    expect(
      resolvePendingQueryWorkspaceId('session-1', [
        { threadId: 'other', workspaceId: 'ws-other' },
        { threadId: 'session-1', workspaceId: '  ws-hot  ' },
      ]),
    ).toBe('ws-hot')
  })

  it('无匹配或 workspaceId 为空时返回 undefined（交给 ForWorkspace fail-closed）', () => {
    expect(
      resolvePendingQueryWorkspaceId('session-1', [
        { threadId: 'session-1', workspaceId: '   ' },
        { threadId: 'session-2', workspaceId: 'ws-2' },
      ]),
    ).toBeUndefined()
    expect(resolvePendingQueryWorkspaceId('session-1', [])).toBeUndefined()
  })
})
