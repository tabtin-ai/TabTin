import { describe, expect, it } from 'vitest'

import { SHARED_SESSION_TAB_TYPE } from '@/components/chat/shared-view/sharedSessionConstants'
import { sharedSessionHandler } from '../sharedsession'

describe('sharedsession handler keepAlive ', () => {
  it('切走即卸载，避免回首页与 hidden ChatPanel 同帧挂卸打出 ', () => {
    expect(sharedSessionHandler.type).toBe(SHARED_SESSION_TAB_TYPE)
    expect(sharedSessionHandler.renderMode).toBe('pane')
    expect(sharedSessionHandler.keepAlive).toBe(false)
    expect(sharedSessionHandler.persistOnly).toBe(true)
    expect(sharedSessionHandler.closable).toBe(true)
  })
})
