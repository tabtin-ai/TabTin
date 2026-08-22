import { describe, expect, it } from 'vitest'

import type { ContextItem } from '../../types'
import { apphomeHandler } from '../apphome'

function makeAppHome(appId: string): ContextItem {
  return {
    type: 'apphome',
    id: appId === 'orchestration' ? 'orchestration-space-1' : appId,
    tabKey: `apphome:${appId}`,
    title: appId,
    meta: { appId, targetSpaceId: appId === 'orchestration' ? 'space-1' : undefined },
  }
}

describe('apphome workspace directory keepAlive', () => {
  it('keeps only the workspace directory home mounted with visibility suspension', () => {
    expect(typeof apphomeHandler.keepAlive).toBe('function')
    const resolveKeepAlive = apphomeHandler.keepAlive as (item: ContextItem) => boolean

    expect(resolveKeepAlive(makeAppHome('orchestration'))).toBe(true)
    expect(resolveKeepAlive(makeAppHome('tabfolder'))).toBe(false)
    expect(resolveKeepAlive(makeAppHome('skill'))).toBe(false)
    expect(apphomeHandler.keepAliveSuspendMode).toBe('visibility')
  })
})
