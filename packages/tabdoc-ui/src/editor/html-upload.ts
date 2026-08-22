/**
 * TabDoc HTML 嵌入块上传（宿主无关）。
 *
 * slash 菜单与拖拽两处复用同一套：识别 .html 文件 → 校验 → toast「上传中」→
 * 走注入的 TabDocHtmlUploadPort 上传 → 返回块 attrs（失败 toast 并返回 null）。
 *
 * 纯识别逻辑（isHtmlUploadFile / htmlTitleFromFileName）无副作用、可单测，
 * 供拖拽拦截、file input accept、宿主 validate 复用，避免各处各写一份正则而漂移。
 */
import { toast } from '@tabtin/smartsheet-ui'
import type { TabDocHtmlUploadPort } from '../ports'

type TranslateFn = (key: string, opts?: Record<string, unknown>) => string

/** file input / 拖拽可接受的 HTML 类型（扩展名 + mime）。 */
export const HTML_UPLOAD_ACCEPT = '.html,.htm,text/html'

const HTML_EXTENSION_RE = /\.html?$/i

/**
 * 判定一个文件是否可作为 HTML 嵌入块：mime 为 text/html，或文件名以 .html / .htm 结尾。
 * 只读 name / type，方便传 File 或最小对象进行单测。
 */
export function isHtmlUploadFile(file: { name: string; type: string }): boolean {
  if (file.type === 'text/html') return true
  return HTML_EXTENSION_RE.test(file.name)
}

/** 从文件名推导块标题：去掉路径前缀与 .html/.htm 扩展名；结果为空则回落原文件名。 */
export function htmlTitleFromFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).filter(Boolean).pop() ?? fileName
  return base.replace(HTML_EXTENSION_RE, '') || base
}

/** runHtmlUpload 成功时返回的块 attrs（不含 height，由调用方补默认值）。 */
export interface HtmlUploadOutcome {
  fileId: string
  src: string
  title: string
}

/**
 * 执行一次 HTML 上传流程（含 toast 反馈）。
 *
 * - 先跑宿主 validate（若提供）：不通过 → destructive toast，返回 null。
 * - 上传期间显示常驻「上传中」toast，结束后 dismiss。
 * - 成功且拿到 fileId → success toast，返回块 attrs。
 * - 失败 / 空 fileId → destructive toast，返回 null。
 *
 * 不负责插入节点：由调用方拿返回值决定插入位置（slash = 光标处，拖拽 = 落点处）。
 */
export async function runHtmlUpload(
  file: File,
  port: TabDocHtmlUploadPort,
  t: TranslateFn,
  options: { documentId?: string },
): Promise<HtmlUploadOutcome | null> {
  if (port.validate) {
    const result = port.validate(file)
    if (!result.valid) {
      const tooLarge = result.reason?.startsWith('fileTooLarge')
      toast({
        title: tooLarge
          ? t('htmlBlock.uploadTooLarge', {
              maxSize: result.maxSizeLabel,
              defaultValue: '文件过大，最大支持 {{maxSize}}',
            })
          : t('htmlBlock.uploadTypeNotSupported', {
              defaultValue: '仅支持上传 .html / .htm 文件',
            }),
        variant: 'destructive',
      })
      return null
    }
  }

  const uploadingToast = toast({
    title: t('htmlBlock.uploading', { defaultValue: '正在上传 HTML…' }),
    duration: Number.POSITIVE_INFINITY,
  })

  try {
    const { url, fileId } = await port.upload(file, { documentId: options.documentId })
    uploadingToast.dismiss()
    if (!fileId) {
      toast({
        title: t('htmlBlock.uploadFailed', { defaultValue: 'HTML 上传失败' }),
        variant: 'destructive',
      })
      return null
    }
    toast({ title: t('htmlBlock.uploadSuccess', { defaultValue: 'HTML 上传成功' }) })
    // : private artifacts keep src empty; fileId is the render SSOT.
    return { fileId, src: url || '', title: htmlTitleFromFileName(file.name) }
  } catch (err) {
    uploadingToast.dismiss()
    toast({
      title: t('htmlBlock.uploadFailed', { defaultValue: 'HTML 上传失败' }),
      description: err instanceof Error ? err.message : undefined,
      variant: 'destructive',
    })
    return null
  }
}
