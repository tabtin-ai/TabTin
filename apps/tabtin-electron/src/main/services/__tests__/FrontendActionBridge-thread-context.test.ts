import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const currentDir = path.dirname(fileURLToPath(import.meta.url))

describe('FrontendActionBridge thread context contract', () => {
  it('uses the injected HITL context and never reads thread identity from params', () => {
    const source = fs.readFileSync(
      path.resolve(currentDir, '../FrontendActionBridge.ts'),
      'utf8',
    )

    expect(source).toContain('const threadId = getHumanInteractionContext()?.threadId')
    expect(source).not.toMatch(/\(params as any\)\?\._thread_id/)
    expect(source).not.toMatch(/\(params as any\)\?\.thread_id/)
  })
})
