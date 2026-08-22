/**
 * 跨类型 Dirty 资源聚合层
 *
 * 用途（W2.5 T9）：
 *   ⌘Q 退出 Electron / 关窗口 / 删除 Space 时，需要把所有"未保存改动"的资源
 *   集中起来交给用户在**一个**对话框里统一处理（"全部保存 / 全部放弃 / 取消退出"），
 *   而不是逐个 tab 走 beforeClose（那样会连续弹 N 个对话框）。
 *
 * 设计原则：
 *   - 本模块不直接耦合 tabdoc / tabslide / tabwhiteboard 等具体类型，
 *     由各类型 registry 在自己 mount 时通过 `registerDirtyProvider` 注册一个 provider
 *   - provider 提供两个能力：collect（按 spaceId 列出 dirty 资源）+ save（按 id 单独保存）
 *   - 聚合层暴露 `collectAllDirty(spaceId?)` 与 `saveDirtyResource(resource)` 两个统一入口
 *   - 聚合层永远是同步取列表（避免在 before-quit 时还要 await 多个慢调用）
 *
 * 现状：
 *   - 仅 tabdoc 接入；tabphone 类型不参与（运行状态非数据保存）
 *   - 未来 tabslide / tabwhiteboard / tabvideo 接入时只需新增一个 registry + 自注册
 */

/**
 * 通用 dirty 资源描述。`type` 字段用于上层 UI 显示分组图标 + 区分 saver 路径。
 */
export interface DirtyResource {
  /** 资源类型，与 ContextItem.type 对齐（'tabdoc' / 未来 'tabslide' 等） */
  type: string
  /** 资源唯一 id（在 type 内唯一）—— 用于 saveDirtyResource 路由 */
  id: string
  /** 资源所属 space，可能为 null（注册时未知） */
  spaceId: string | null
  /** 用户可读的标题；空字符串表示未命名（UI 应给出 fallback） */
  title: string
}

/**
 * 一类资源的聚合 provider。各类型 registry（tabdoc / 未来 tabslide）通过实现该接口
 * 接入聚合层。
 */
export interface DirtyResourceProvider {
  /** 资源类型，必须与 collect 返回项的 type 一致；唯一 id 用于注销 */
  type: string
  /**
   * 列出当前所有需要保存确认的资源。
   *
   * @param spaceId 可选过滤；undefined 表示返回全部（⌘Q 场景），
   *               传字符串则只返回该 space 下的（删除 Space 场景）
   */
  collect: (spaceId?: string) => DirtyResource[]
  /**
   * 保存指定资源。返回 true 表示成功，false 表示失败（用户应决定是否继续退出）。
   * 调用方负责异常处理；provider 内部应捕获异常并 resolve(false) 而非抛错。
   */
  save: (id: string) => Promise<boolean>
}

const providers = new Map<string, DirtyResourceProvider>()

/**
 * 注册一类资源的聚合 provider。
 *
 * @returns 反注册函数。同 type 重复注册时新值覆盖旧值（与 tabdocDirtyRegistry 一致），
 *          旧 unregister 不会误删新 entry。
 */
export function registerDirtyProvider(provider: DirtyResourceProvider): () => void {
  if (!provider.type) return () => {}
  providers.set(provider.type, provider)
  return () => {
    if (providers.get(provider.type) === provider) {
      providers.delete(provider.type)
    }
  }
}

/**
 * 聚合所有 provider 的 dirty 资源。
 *
 * @param spaceId 可选 —— undefined 返回全部（⌘Q 场景），传字符串只返回该 space 下的
 *
 * 任何 provider 抛错都会被捕获并 console.warn；为避免静默"消失"该类型的 dirty（产品视角
 * P1 修复），抛错时**插入一条 fallback resource**让上层弹对话框，迫使用户感知到异常
 * （title 走 i18n fallback；id 用 type 名+时间戳，不可保存只能放弃）。
 *
 * 返回顺序：按注册顺序的 provider 输出依次拼接。
 */
export function collectAllDirty(spaceId?: string): DirtyResource[] {
  const result: DirtyResource[] = []
  providers.forEach((provider) => {
    try {
      const items = provider.collect(spaceId)
      for (const item of items) {
        result.push(item)
      }
    } catch (err) {
      console.warn(`[dirtyRegistry] provider "${provider.type}" collect threw:`, err)
      // P1 修复：抛错时插入"未知"资源占位，让上层对话框弹出，避免静默放行；
      // saveDirtyResource 调用时该 type 仍在 providers 里，但 id 不存在 → save 返回 false →
      // 上层走"全部失败"路径，最终 cancel 退出/删除（数据安全优先）。
      result.push({
        type: provider.type,
        id: `__collect_failed__:${Date.now()}`,
        spaceId: spaceId ?? null,
        title: `[${provider.type}] 采样失败`,
      })
    }
  })
  return result
}

/**
 * 保存单个 dirty 资源。资源 type 必须有对应 provider 已注册。
 *
 * @returns true / false 表示保存成功 / 失败；type 未注册或异常时返回 false（不抛错）
 */
export async function saveDirtyResource(resource: Pick<DirtyResource, 'type' | 'id'>): Promise<boolean> {
  const provider = providers.get(resource.type)
  if (!provider) {
    console.warn(`[dirtyRegistry] no provider for type "${resource.type}"`)
    return false
  }
  try {
    return await provider.save(resource.id)
  } catch (err) {
    console.warn(`[dirtyRegistry] saveDirtyResource(${resource.type}/${resource.id}) threw:`, err)
    return false
  }
}

/**
 * 批量保存。串行 await（避免后端被同时打爆 N 个 PUT 请求）。
 * 返回每条结果，调用方决定如何汇总（如"3/5 失败 → 弹错误报告"）。
 *
 * 进度回调（可选）让 UI 能显示"正在保存 3 / 5..."。
 */
export interface BatchSaveResult {
  resource: DirtyResource
  ok: boolean
}

export async function saveAllDirty(
  resources: readonly DirtyResource[],
  onProgress?: (done: number, total: number, current: DirtyResource) => void,
): Promise<BatchSaveResult[]> {
  const results: BatchSaveResult[] = []
  let done = 0
  for (const resource of resources) {
    onProgress?.(done, resources.length, resource)
    const ok = await saveDirtyResource(resource)
    results.push({ resource, ok })
    done += 1
  }
  return results
}

/** 测试 / 调试用 —— 当前已注册 provider 数量 */
export function _getDirtyProviderCount(): number {
  return providers.size
}

/** 测试用 —— 清空所有 provider */
export function _resetDirtyRegistry(): void {
  providers.clear()
}
