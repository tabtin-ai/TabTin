/**
 * table/doc create → platform_resource 交付物解析单测。
 */

import { describe, expect, it } from 'vitest'
import {
  PLATFORM_RESOURCE_ARTIFACT_KIND,
  buildPlatformResourceArtifactBlockFromCreate,
  isPlatformResourceCreateCommand,
  parsePlatformResourceCreateResult,
} from '../src/delivery/platform-resource-artifact.js'

const TABLE_ID = 'a1b2c3d4-1111-2222-3333-444455556666'
const DOC_ID = 'd0c0d0c0-aaaa-bbbb-cccc-ddddeeeeffff'

describe('isPlatformResourceCreateCommand', () => {
  it('matches table/doc create with prefixes', () => {
    expect(isPlatformResourceCreateCommand('tabtin table create --name x', 'table')).toBe(true)
    expect(isPlatformResourceCreateCommand('cd /tmp && tabtin table create --name x', 'table')).toBe(true)
    expect(isPlatformResourceCreateCommand('tabtin doc create --title x', 'document')).toBe(true)
  })

  it('matches table create after a quoted multiline env assignment', () => {
    const command = `FIELDS='[
      {"name":"评论ID","field_type":"text"},
      {"name":"点赞数","field_type":"number"}
    ]'
    tabtin table create --name "抖音评论采集" --fields "$FIELDS" --format json`

    expect(isPlatformResourceCreateCommand(command, 'table')).toBe(true)
  })

  it('matches create commands across shell continuations and pipelines', () => {
    const continuedCommand = [
      'FIELDS="[]" \\',
      'tabtin table create --name x --fields "$FIELDS" --format json | jq .data.table',
    ].join('\n')
    expect(isPlatformResourceCreateCommand(continuedCommand, 'table')).toBe(true)
    expect(isPlatformResourceCreateCommand(
      'echo preparing\ntabtin doc create --title x --format json',
      'document',
    )).toBe(true)
  })

  it('rejects unrelated commands', () => {
    expect(isPlatformResourceCreateCommand('tabtin table list', 'table')).toBe(false)
    expect(isPlatformResourceCreateCommand('echo tabtin table create', 'table')).toBe(false)
    expect(isPlatformResourceCreateCommand('tabtin table create --name x', 'document')).toBe(false)
    expect(isPlatformResourceCreateCommand("echo 'tabtin table create --name x'", 'table')).toBe(false)
  })
})

describe('parsePlatformResourceCreateResult', () => {
  it('parses cli-server {data:{table:{id,name}}}', () => {
    const stdout = JSON.stringify({
      ok: true,
      data: { table: { id: TABLE_ID, name: '客户名单', space_id: 's1' } },
    })
    expect(parsePlatformResourceCreateResult('tabtin table create --name 客户名单', stdout)).toEqual({
      resourceType: 'table',
      resourceId: TABLE_ID,
      title: '客户名单',
      resourceSpaceId: 's1',
    })
  })

  it('parses Django flat {data:{id,name}}', () => {
    const stdout = JSON.stringify({ data: { id: TABLE_ID, name: '融资' } })
    expect(parsePlatformResourceCreateResult('tabtin table create --name 融资', stdout)).toEqual({
      resourceType: 'table',
      resourceId: TABLE_ID,
      title: '融资',
    })
  })

  it('parses Go CLI agent-text data line', () => {
    const stdout = [
      `data: {"table":{"id":"${TABLE_ID}","name":"客户名单"}}`,
      'ok: true',
      '',
    ].join('\n')
    expect(parsePlatformResourceCreateResult('tabtin table create --name 客户名单', stdout)).toEqual({
      resourceType: 'table',
      resourceId: TABLE_ID,
      title: '客户名单',
    })
  })

  it('parses 207 partial error.detail.table_id', () => {
    const stdout = JSON.stringify({
      error: {
        code: 'VALIDATION_ERROR',
        detail: {
          partial: true,
          table_id: TABLE_ID,
          table: { id: TABLE_ID, name: '融资' },
        },
      },
    })
    expect(parsePlatformResourceCreateResult('tabtin table create --name 融资 --fields []', stdout)).toEqual({
      resourceType: 'table',
      resourceId: TABLE_ID,
      title: '融资',
    })
  })

  it('parses doc create', () => {
    const stdout = JSON.stringify({
      ok: true,
      data: { document: { id: DOC_ID, title: '周报' } },
    })
    expect(parsePlatformResourceCreateResult('tabtin doc create --title 周报', stdout)).toEqual({
      resourceType: 'document',
      resourceId: DOC_ID,
      title: '周报',
    })
  })

  it('returns null when create failed without id', () => {
    const stdout = JSON.stringify({ ok: false, error: { message: 'denied' } })
    expect(parsePlatformResourceCreateResult('tabtin table create --name x', stdout)).toBeNull()
  })
})

describe('buildPlatformResourceArtifactBlockFromCreate', () => {
  it('builds resource_ref with platform_resource marker', () => {
    const stdout = JSON.stringify({
      ok: true,
      data: { table: { id: TABLE_ID, name: '客户名单', space_id: 'workspace-1' } },
    })
    const block = buildPlatformResourceArtifactBlockFromCreate(
      'tabtin table create --name 客户名单',
      stdout,
    )
    expect(block).toMatchObject({
      kind: 'resource_ref',
      summary: '客户名单',
      payload: {
        artifact_kind: PLATFORM_RESOURCE_ARTIFACT_KIND,
        resource_type: 'table',
        resource_id: TABLE_ID,
        resource_name: '客户名单',
        hint_carrier_app_id: 'tabdata',
        space_id: 'workspace-1',
      },
    })
    expect(block?.payload.url).toContain(`tabtin://resource/table/${TABLE_ID}`)
    expect(String(block?.payload.url)).toContain('hint=tabdata')
  })
})
