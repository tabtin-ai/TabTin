/**
 * 云盘预览顶栏「发送到私信」入口
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/context-space/registry/handlers/renderers/TabFilesPaneRenderer.tsx'),
  'utf8',
)

describe('TabFilesPaneRenderer send-to-im contract', () => {
  it('shows header action and opens SendToIMDialog with cloud_file resource', () => {
    expect(source).toContain('SendToIMDialog')
    expect(source).toContain("kind: 'cloud_file'")
    expect(source).toContain('oss-file-send-to-im')
    expect(source).toContain("metaString(item.meta, 'resource_id')")
    expect(source).toContain('contextItemId')
  })
})
