/**
 * show_widget 烤图 + OSS 上传的**注入契约**（ 批4）。
 *
 * 设计取向：agent-runtime 是中性运行时内核，不内置 offscreen 渲染实现，也不
 * 直连 OSS 上传业务包。烤图 + 上传的具体实现由宿主注入 `BakeAndUploadFn`
 * 回调；本文件只定义回调的输入 / 输出契约与结果结构。
 */

/** 烤图 + 上传结果。imageUrl 为空字符串表示烤图 / 上传失败，widget 仍会 emit（桌面端 iframe 不依赖烤图）。 */
export interface BakeAndUploadResult {
  imageUrl: string
  bakingError?: string
  /**
   * W1.3 / A3-H3：失败路径下保留的本地烤图文件路径。
   *
   * 仅在 OSS 上传失败 / 写盘后未上传成功时填充——给 LLM 在下一轮看到
   * `baking_error` 时一个"本地路径"线索，方便排查或后续重试。成功路径
   * 下必然为 undefined。路径在临时目录下，OS 可能定期清理，调用方不能
   * 假定它长期存在。
   */
  bakedImagePath?: string
}

/** 注入回调的输入：已 prepare 的 widget 渲染源 + per-runtime organizationId。 */
export interface BakeWidgetInput {
  widgetId: string
  renderCode: string
  renderFormat: 'svg' | 'html'
  /**
   * host 在装配期烘进的 per-runtime organizationId，透传给 OSS 上传避免
   * FileRecord 错写到默认 organization。
   */
  organizationId?: string
}

/**
 * 宿主注入的烤图 + OSS 上传回调。runtime 侧只调此回调拿 `BakeAndUploadResult`，
 * 不感知 offscreen 渲染 / theme 解析 / OSS 上传的具体实现。
 */
export type BakeAndUploadFn = (input: BakeWidgetInput) => Promise<BakeAndUploadResult>
