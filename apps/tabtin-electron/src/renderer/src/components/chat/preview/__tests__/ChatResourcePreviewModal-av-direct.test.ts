import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

async function readChatResourcePreviewModalSource() {
  const srcPath = path.resolve(__dirname, '../ChatResourcePreviewModal.tsx')
  return fs.readFile(srcPath, 'utf8')
}

describe('ChatResourcePreviewModal 音视频直链预览', () => {
  it('VideoBody / AudioBody 不经 useCachedChatMediaSrc 整文件缓存', async () => {
    const source = await readChatResourcePreviewModalSource()
    const videoBody = source.slice(
      source.indexOf('const VideoBody'),
      source.indexOf('const AudioBody'),
    )
    const audioBody = source.slice(
      source.indexOf('const AudioBody'),
      source.indexOf('/** Office 预览公共骨架'),
    )
    expect(videoBody).toContain('src={resource.url}')
    expect(videoBody).not.toContain('useCachedChatMediaSrc')
    expect(audioBody).toContain('src={resource.url}')
    expect(audioBody).not.toContain('useCachedChatMediaSrc')
  })

  it('ImageBody 仍走 useCachedChatMediaSrc（图片缓存不误伤）', async () => {
    const source = await readChatResourcePreviewModalSource()
    const imageBody = source.slice(
      source.indexOf('const ImageBody'),
      source.indexOf('const VideoBody'),
    )
    expect(imageBody).toContain('useCachedChatMediaSrc')
  })
})
