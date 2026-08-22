export interface MainProcessErrorLogger {
  debug: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export interface MainProcessErrorHooksOptions {
  log: MainProcessErrorLogger
  reportError: (
    error: Error,
    source: 'main_uncaught_exception' | 'main_unhandled_rejection',
  ) => void
}

export function installMainProcessErrorHooks(
  options: MainProcessErrorHooksOptions,
): void {
  process.on('uncaughtException', (error: Error) => {
    if (error.message && error.message.includes('Could not parse CSS stylesheet')) {
      if (process.env.DEBUG_CSS === 'true') {
        options.log.debug('JSDOM CSS 解析警告 (可忽略):', error.message.substring(0, 100))
      }
      return
    }

    if (error.message && (error.message.includes('EPIPE') || error.message.includes('ECONNRESET'))) {
      options.log.debug('管道连接已断开（正常情况）')
      return
    }

    options.log.error('未捕获的异常:', error)
    options.reportError(error, 'main_uncaught_exception')
  })

  process.on('unhandledRejection', (reason: unknown) => {
    if (
      reason &&
      typeof reason === 'object' &&
      'message' in reason &&
      typeof (reason as { message?: unknown }).message === 'string' &&
      (
        (reason as { message: string }).message.includes('EPIPE') ||
        (reason as { message: string }).message.includes('ECONNRESET')
      )
    ) {
      options.log.debug('Promise rejection: 连接已断开（正常情况）')
      return
    }

    options.log.error('未处理的 Promise Rejection:', reason)
    options.reportError(
      reason instanceof Error ? reason : new Error(String(reason)),
      'main_unhandled_rejection',
    )
  })
}
