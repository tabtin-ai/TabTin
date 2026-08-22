import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AttributionStore } from '../src/state/attribution/attribution-store.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('message sender attribution ', () => {
  it('由 Host 持久化并可在冷启动后按消息恢复发言人', () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sender-attribution-'))
    tempDirs.push(sessionDir)
    const writer = new AttributionStore()

    writer.rememberMessageSenderAttribution('message-1', 'grantee-user-1', sessionDir)

    const reader = new AttributionStore()
    reader.hydrateMessageSenderAttributions(sessionDir)
    expect(reader.resolveMessageSenderAttribution('message-1')).toBe('grantee-user-1')
  })

  it('相同归属重复绑定时不重复追加旁车记录', () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sender-attribution-'))
    tempDirs.push(sessionDir)
    const store = new AttributionStore()

    store.rememberMessageSenderAttribution('message-1', 'grantee-user-1', sessionDir)
    store.rememberMessageSenderAttribution('message-1', 'grantee-user-1', sessionDir)

    const lines = fs.readFileSync(
      path.join(sessionDir, 'message-sender-attribution.jsonl'),
      'utf-8',
    ).trim().split('\n')
    expect(lines).toHaveLength(1)
  })
})
