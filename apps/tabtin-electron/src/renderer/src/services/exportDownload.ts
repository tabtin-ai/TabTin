/**
 * CSV / 二进制导出下载的公共错误处理。
 * Electron 代理超时、429 限流等要给出可行动的文案，避免按钮长时间转圈后只剩泛化「失败」。
 */

import i18n from '@/i18n'

type ErrorBody = {
  detail?: string
  message?: string
}

function isTimeoutMessage(message: string): boolean {
  return /timeout|ETIMEDOUT|aborted|timed out/i.test(message)
}

export async function assertExportResponseOk(
  response: Response,
  fallbackMessage: string,
): Promise<void> {
  if (response.ok) return

  let message = fallbackMessage
  try {
    const text = await response.text()
    if (text) {
      try {
        const parsed = JSON.parse(text) as ErrorBody
        message = parsed.detail || parsed.message || message
      } catch {
        if (text.length > 0 && text.length < 240 && !text.includes('<')) {
          message = text
        }
      }
    }
  } catch {
    // 读 body 失败时保留 fallback
  }

  if (response.status === 429) {
    throw new Error(
      i18n.t('settings:usage.export.rateLimited', {
        defaultValue: '导出过于频繁，请稍后再试（每小时最多 5 次）',
      }),
    )
  }

  throw new Error(message)
}

export function mapExportDownloadError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    if (isTimeoutMessage(error.message) || isTimeoutMessage(String(error.cause ?? ''))) {
      return new Error(
        i18n.t('settings:usage.export.downloadTimeout', {
          defaultValue: '导出超时，请缩小日期范围后重试',
        }),
      )
    }
    return error
  }
  const message = String(error ?? '')
  if (isTimeoutMessage(message)) {
    return new Error(
      i18n.t('settings:usage.export.downloadTimeout', {
        defaultValue: '导出超时，请缩小日期范围后重试',
      }),
    )
  }
  return new Error(fallbackMessage)
}
