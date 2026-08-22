/**
 * 聊天视频附件识别与上传确认文案。
 *
 * 产品口径：视频不走 DocParse；有无 FFmpeg 都不阻断「上传成功」。
 * ：模型声明 `supports_video_input` 时走原生 `video_url` 直传；
 * 本模块文案仅用于**不支持视频输入**时的降级占位（CLI / 抽帧后续再接）。
 */

const VIDEO_EXT_RE = /\.(mp4|webm|mkv|avi|mov|m4v|ogv)$/i

export function isChatVideoAttachment(mime?: string, filename?: string): boolean {
  const m = (mime || '').toLowerCase().trim()
  if (m.startsWith('video/')) return true
  return VIDEO_EXT_RE.test((filename || '').toLowerCase())
}

function formatBytes(size?: number): string {
  if (size == null || size <= 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/** 注入 Agent 上下文的「视频已上传」确认（不依赖本机解析能力）。 */
export function formatChatVideoUploadedBody(
  filename: string,
  size?: number,
): string {
  const sizePart = formatBytes(size)
  const meta = sizePart ? `，大小 ${sizePart}` : ''
  return (
    `[视频: ${filename}]\n` +
    `已上传成功${meta}。当前仅确认附件已送达；如需理解画面或语音内容，请用户用文字补充说明。`
  )
}
