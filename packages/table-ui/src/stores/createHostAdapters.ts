/**
 * 为 table-core store 工厂创建标准化的宿主适配器（translate + logger）。
 *
 * 两端唯一的差异是 i18n.t 的类型断言风格，此函数统一处理。
 */
export interface HostI18n {
  t: (key: string, options?: Record<string, unknown>) => unknown
}

export interface HostTranslate {
  (key: string, fallback: string, options?: Record<string, unknown>): string
}

export interface HostLogger {
  log: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug?: (...args: unknown[]) => void
}

export function createHostAdapters(i18n: HostI18n): {
  translate: HostTranslate
  logger: HostLogger
} {
  return {
    translate: (key: string, fallback: string, options?: Record<string, unknown>) =>
      String(i18n.t(key, { defaultValue: fallback, ...(options ?? {}) })),
    logger: {
      log: (...args: unknown[]) => console.log(...args),
      warn: (...args: unknown[]) => console.warn(...args),
      error: (...args: unknown[]) => console.error(...args),
      debug: (...args: unknown[]) => console.debug(...args),
    },
  }
}
