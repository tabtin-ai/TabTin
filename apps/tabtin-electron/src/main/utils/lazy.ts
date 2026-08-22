/**
 * 统一的延迟加载原语。
 *
 * 提供模块级别的 lazy-load 能力，避免在各处散落 `let loaded; if (!loaded) ...` 模式。
 * 延迟加载运行时表面（lazy runtime surface）设计。
 *
 * 使用示例：
 *   const getHeavyService = createLazyModule(() => import('./services/HeavyService'))
 *   // 首次调用时加载，后续直接返回缓存
 *   const mod = await getHeavyService()
 *   mod.doSomething()
 */

/**
 * 单例缓存的 lazy module loader。
 *
 * 首次调用时执行 loader()，缓存 Promise；后续调用直接返回缓存。
 * 如果 loader 失败，清除缓存以便重试。
 */
export function createLazyModule<T>(loader: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null
  return () => {
    if (!cached) {
      cached = loader().catch((err) => {
        cached = null
        throw err
      })
    }
    return cached
  }
}

/**
 * 同步版的 lazy singleton。
 *
 * 首次调用时执行 factory()，缓存结果；后续直接返回缓存。
 * factory 返回 undefined/null 也视为已创建（只执行一次）。
 */
export function createLazySingleton<T>(factory: () => T): () => T {
  let instance: T | undefined
  let created = false
  return () => {
    if (!created) {
      instance = factory()
      created = true
    }
    return instance!
  }
}

/**
 * 带 set 的 lazy accessor（capability-discovery-accessor 的通用版）。
 *
 * 适用于由外部初始化流程注入实例、消费侧只做 get 的场景。
 * get() 在实例未初始化时抛出错误，确保调用时序正确。
 */
export function createLazyAccessor<T>(name: string): {
  get: () => T
  set: (value: T | null) => void
} {
  let instance: T | null = null
  return {
    get: () => {
      if (!instance) throw new Error(`${name} 尚未初始化`)
      return instance
    },
    set: (value: T | null) => {
      instance = value
    },
  }
}
