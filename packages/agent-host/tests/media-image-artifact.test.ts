import {
  buildMediaImageArtifactBlocks,
  buildMediaImageArtifactEvents,
  isMediaImageGenerateCommand,
} from '../src/delivery/media-image-artifact.js'

const FILE_ID = '550e8400-e29b-41d4-a716-446655440000'

function output(data: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, data: { success: true, status: 'succeeded', ...data } })
}

describe('isMediaImageGenerateCommand', () => {
  it('recognizes multiline shell setup before the media command', () => {
    const command = [
      "PROMPT='",
      '一只在雪山上的金毛',
      "'",
      'tabtin media image generate --prompt "$PROMPT" --format json',
    ].join('\n')

    expect(isMediaImageGenerateCommand(command)).toBe(true)
  })

  it('recognizes preprod and shell wrappers without matching quoted text', () => {
    expect(isMediaImageGenerateCommand(
      'sudo exec tabtin-preprod media image generate --prompt x',
    )).toBe(true)
    expect(isMediaImageGenerateCommand(
      "echo 'tabtin media image generate --prompt x'",
    )).toBe(false)
  })
})

describe('buildMediaImageArtifactBlocks', () => {
  it('projects permanently stored images with stable FileRecord identity', () => {
    const blocks = buildMediaImageArtifactBlocks(
      'tabtin media image generate --prompt "月照金山" --format json',
      output({
        storage_status: 'succeeded',
        stored_files: [{
          index: 0,
          file_id: FILE_ID,
          file_name: 'mountain.png',
          mime_type: 'image/png',
          file_size: 2048,
          access_url: 'https://oss.example/mountain.png',
          artifact_message_id: '11111111-1111-4111-8111-111111111111',
        }],
      }),
      'tool-use-1',
    )

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      messageId: '11111111-1111-4111-8111-111111111111',
      kind: 'image',
      summary: 'mountain.png',
      payload: {
        artifact_kind: 'oss_file',
        file_id: FILE_ID,
        file_type: 'image',
        filename: 'mountain.png',
        mime_type: 'image/png',
        file_size: 2048,
        access_url: 'https://oss.example/mountain.png',
        source_tool_use_id: 'tool-use-1',
      },
    })
    expect(blocks[0]?.payload.url).toContain(FILE_ID)
  })

  it('extracts a durable image from progress logs followed by pretty-printed JSON', () => {
    const cliOutput = [
      '图片生成成功，正在等待永久存储……',
      '永久存储已完成。',
      JSON.stringify({
        ok: true,
        data: {
          success: true,
          status: 'succeeded',
          storage_status: 'succeeded',
          stored_files: [{
            index: 0,
            file_id: FILE_ID,
            file_name: 'golden-retriever.png',
            mime_type: 'image/png',
            file_size: 4096,
            access_url: 'https://oss.example/golden-retriever.png',
          }],
        },
      }, null, 2),
    ].join('\n')

    const blocks = buildMediaImageArtifactBlocks(
      'tabtin media image generate --prompt "草地上的金毛" --format json',
      cliOutput,
      'run_terminal_command:0',
    )

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      kind: 'image',
      payload: {
        file_id: FILE_ID,
        source_tool_use_id: 'run_terminal_command:0',
      },
    })
  })

  it('emits only durable successes for a partial delivery', () => {
    const blocks = buildMediaImageArtifactBlocks(
      'tabtin media image generate --prompt x --format json',
      output({
        storage_status: 'partial',
        result_urls: ['https://provider.example/temporary-0.png', 'https://provider.example/temporary-1.png'],
        stored_files: [{
          index: 1,
          file_id: FILE_ID,
          file_name: 'saved.webp',
          mime_type: 'image/webp',
          file_size: 4096,
          access_url: 'https://oss.example/saved.webp',
        }],
      }),
      'tool-use-2',
    )

    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.payload.access_url).toBe('https://oss.example/saved.webp')
  })

  it('does not promote temporary previews or entries without file_id', () => {
    expect(buildMediaImageArtifactBlocks(
      'tabtin media image generate --prompt x --format json',
      output({
        delivery_status: 'temporary_preview',
        result_urls: ['https://provider.example/temporary.png'],
        stored_files: [],
      }),
      'tool-use-3',
    )).toEqual([])

    expect(buildMediaImageArtifactBlocks(
      'tabtin media image generate --prompt x --format json',
      output({
        storage_status: 'succeeded',
        stored_files: [{
          index: 0,
          file_name: 'missing-id.png',
          mime_type: 'image/png',
          file_size: 12,
          access_url: 'https://oss.example/missing-id.png',
        }],
      }),
      'tool-use-4',
    )).toEqual([])
  })

  it('ignores unrelated terminal commands', () => {
    expect(buildMediaImageArtifactBlocks(
      'tabtin oss upload /tmp/a.png',
      output({ stored_files: [] }),
      'tool-use-5',
    )).toEqual([])
  })

  it('unwraps background terminal stdout and emits a durable artifact mini-message', () => {
    const cliOutput = [
      '后台任务完成，正在整理永久产物……',
      JSON.stringify({
        ok: true,
        data: {
          success: true,
          status: 'succeeded',
          storage_status: 'succeeded',
          stored_files: [{
            index: 0,
            file_id: FILE_ID,
            file_name: 'background.png',
            mime_type: 'image/png',
            file_size: 8192,
            access_url: 'https://oss.example/background.png',
            artifact_message_id: '11111111-1111-4111-8111-111111111111',
          }],
        },
      }, null, 2),
    ].join('\n')
    const events = buildMediaImageArtifactEvents({
      threadId: '3f8a2c7e-9b1d-4e5f-a6c7-8d9e0f1a2b3c',
      command: 'tabtin media image generate --prompt x --format json',
      output: JSON.stringify({ _terminal_update: true, stdout: cliOutput }),
      sourceToolUseId: 'run_terminal_command:0',
      initialSeq: 4,
    })

    // Detached mini-message: message_start + block_start + block_delta +
    // block_stop + message_stop。delta 由统一 emitter 生成，不能按旧 4 件套断言。
    expect(events).toHaveLength(5)
    expect(new Set(events.map((event) => event.payload.message_id))).toEqual(
      new Set(['11111111-1111-4111-8111-111111111111']),
    )
    expect(events[0]?.payload).toMatchObject({
      message_kind: 'tool_artifact',
      _seq: 5,
    })
    expect(events[1]?.payload).toMatchObject({
      _seq: 6,
      block: {
        type: 'tabtin_rich_content',
        kind: 'image',
        payload: {
          file_id: FILE_ID,
          source_tool_use_id: 'run_terminal_command:0',
        },
      },
    })
  })
})
