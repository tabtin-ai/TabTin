/**
 * ：画像拉取契约 — 无 agent 不请求；query/cache 带 agent 作用域。
 */
import { describe, expect, it } from 'vitest'
import {
  buildUserPortraitCacheKey,
  buildUserPortraitMeQuery,
  resolveUserPortraitFetchScope,
} from '../user-portrait-fetch-contract'

describe('user-portrait-fetch-contract ', () => {
  it('缺 agentId / orgId 时不形成请求 scope', () => {
    expect(resolveUserPortraitFetchScope('org-1', null)).toBeNull()
    expect(resolveUserPortraitFetchScope('org-1', '')).toBeNull()
    expect(resolveUserPortraitFetchScope('', 'agent-1')).toBeNull()
    expect(resolveUserPortraitFetchScope(null, 'agent-1')).toBeNull()
  })

  it('有 org+agent 时返回 trim 后的 scope', () => {
    expect(resolveUserPortraitFetchScope('  org-1  ', '  agent-1  ')).toEqual({
      orgId: 'org-1',
      agentId: 'agent-1',
    })
  })

  it('cache key 为 org::agent', () => {
    expect(buildUserPortraitCacheKey('org-a', 'agent-b')).toBe('org-a::agent-b')
  })

  it('me query 含 agent_id=', () => {
    const qs = buildUserPortraitMeQuery('f0c5bece-ac56-470e-a478-7883f5743979')
    expect(qs).toBe('agent_id=f0c5bece-ac56-470e-a478-7883f5743979')
  })
})
