import { beforeEach, describe, expect, it, vi } from 'vitest'
import { enrichOssFileOpenParams } from './enrichOssFileOpenParams'

const resolveOssFileDetail = vi.fn()

vi.mock('@/components/chat/preview/resolveOssFileAccessUrl', async () => {
  const actual = await vi.importActual<typeof import('@/components/chat/preview/resolveOssFileAccessUrl')>(
    '@/components/chat/preview/resolveOssFileAccessUrl',
  )
  return {
    ...actual,
    resolveOssFileDetail: (...args: unknown[]) => resolveOssFileDetail(...args),
  }
})

describe('enrichOssFileOpenParams', () => {
  beforeEach(() => {
    resolveOssFileDetail.mockReset()
  })

  it('把聊天附件 UUID 的 file tab 补成 oss_file + access_url', async () => {
    resolveOssFileDetail.mockResolvedValue({
      fileId: '084aa15a-d224-4764-9c2f-f45c92026f05',
      fileName: 'demo.mp4',
      url: 'http://127.0.0.1:6060/api/services/oss/local-object?object_key=chat%2Fattachments%2Fx.mp4',
      mimeType: 'video/mp4',
      fileType: 'video',
    })

    const out = await enrichOssFileOpenParams({
      type: 'file',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      title: '084aa15a-d224-4764-9c2f-f45c92026f05',
      meta: {},
    })

    expect(out.type).toBe('file')
    expect(out.title).toBe('demo.mp4')
    expect(out.meta).toMatchObject({
      artifact_kind: 'oss_file',
      file_type: 'video',
      filename: 'demo.mp4',
      mime_type: 'video/mp4',
      access_url: 'http://127.0.0.1:6060/api/services/oss/local-object?object_key=chat%2Fattachments%2Fx.mp4',
      source: 'oss_file_record',
    })
  })

  it('tabvideo + 实为聊天附件时改写成 file/oss_file，避免空视频项目', async () => {
    resolveOssFileDetail.mockResolvedValue({
      fileId: '084aa15a-d224-4764-9c2f-f45c92026f05',
      fileName: 'clip.mp4',
      url: 'http://example.test/clip.mp4',
      mimeType: 'video/mp4',
      fileType: 'video',
    })

    const out = await enrichOssFileOpenParams({
      type: 'tabvideo',
      id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      title: '未命名视频',
    })

    expect(out.type).toBe('file')
    expect(out.meta).toMatchObject({
      artifact_kind: 'oss_file',
      file_type: 'video',
      filename: 'clip.mp4',
    })
  })

  it('本地产物与非 UUID id 不查 OSS', async () => {
    const local = await enrichOssFileOpenParams({
      type: 'file',
      id: 'artifacts/demo.mp4',
      meta: { artifact_kind: 'local_file', file_type: 'video' },
    })
    expect(resolveOssFileDetail).not.toHaveBeenCalled()
    expect(local.meta).toMatchObject({ artifact_kind: 'local_file' })

    const pathLike = await enrichOssFileOpenParams({
      type: 'file',
      id: 'artifacts/demo.mp4',
      meta: {},
    })
    expect(resolveOssFileDetail).not.toHaveBeenCalled()
    expect(pathLike.id).toBe('artifacts/demo.mp4')
  })

  it('OSS 查不到时保持原 params（真 TabVideo 项目）', async () => {
    resolveOssFileDetail.mockRejectedValue(new Error('not found'))
    const input = {
      type: 'tabvideo' as const,
      id: '3d6f5371-abf4-49e4-915d-2e781b6cb915',
      title: '真项目',
    }
    const out = await enrichOssFileOpenParams(input)
    expect(out).toEqual(input)
  })
})
