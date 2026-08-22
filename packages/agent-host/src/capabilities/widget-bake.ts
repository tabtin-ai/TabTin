/**
 * show_widget 烤图 + OSS 上传实现（ 批4）。
 *
 * 归属：agent-runtime 是中性运行时内核，只定义 `BakeAndUploadFn` 注入契约
 * （见 `@tabtin/agent-runtime/tools` 的 BakeWidgetInput / BakeAndUploadResult）。
 * 具体的 offscreen 渲染、UI theme 解析、OSS 上传都依赖 `@tabtin/action-tools`
 * 业务包，属于宿主职责，故实现落在共享宿主包。装配 ToolProvider 时把
 * `bakeAndUploadWidget` 作为 `createShowWidgetTool`/`createPresentationTools`
 * 的 `bakeAndUpload` deps 注入。
 *
 * 业务逻辑与迁移前 agent-runtime 的 bake-upload.ts 完全一致：串行"烤图 →
 * 写 tmp → uploadFileToOSS"，失败保留本地 PNG 并把路径透出（W1.3 / A3-H3）。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  resolveOffscreenRenderAPI,
  resolveUITheme,
  uploadFileToOSS,
} from '@tabtin/action-tools/headless'
import type {
  BakeAndUploadResult,
  BakeWidgetInput,
} from '@tabtin/agent-runtime/tools'

/**
 * 烤图 theme。Electron renderer 用 dark/light 时烤图跟着切；Daemon / headless
 * 环境 `resolveUITheme()` 返回 null，回落 `'light'` 保留 Wave 4 默认行为。
 */
type BakeTheme = 'light' | 'dark'

interface RenderedWidgetImage {
  buffer: Uint8Array
}

async function uploadRenderedWidgetImage(args: {
  widgetId: string
  renderResult: RenderedWidgetImage
  organizationId?: string
  logger: (msg: string) => void
}): Promise<BakeAndUploadResult> {
  const { widgetId, renderResult, organizationId, logger } = args
  logger(`uploading widget PNG (${renderResult.buffer.length} bytes) to OSS`)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-upload-'))
  const tmpPath = path.join(tmpDir, `${widgetId}.png`)
  let uploadSucceeded = false
  try {
    fs.writeFileSync(tmpPath, renderResult.buffer)
    // **dogfood baking_error 复盘**：必须传 contextId（widgetId 即可）。
    // 上传 API 需要上下文 id；缺失会被拒并一路被层层 catch 吞成
    // 无意义的 "OSS upload returned null URL"。
    // widgetId 天然是稳定业务 id，作为 context_id 既能通过后端校验
    // 又能让 FileRecord 反查到归属的 widget。
    const result = await uploadFileToOSS(tmpPath, {
      folder: 'widget/renders',
      module: 'widget',
      contextType: 'widget_render',
      contextId: widgetId,
      mimeType: 'image/png',
      organizationId,
    })
    if (result.url) {
      uploadSucceeded = true
      logger(`uploaded → ${result.url}`)
      return { imageUrl: result.url }
    }
    // 把精确错误信息（含 errorCode 分类）透传给 caller —— show-widget
    // index.ts 会按 errorCode 走差异化文案，避免 LLM 误判为"渲染失败"。
    // R3 M4：文案不直接拼 /tmp 绝对路径——本地路径走 BakeAndUploadResult.bakedImagePath
    // → result.output_path 字段，与 export-tool / mg-tool 契约一致。
    const detail = result.error ? `: ${result.error}` : ''
    const bakingError = `[${result.errorCode ?? 'unknown'}] OSS upload returned null URL${detail} — local PNG retained at output_path`
    logger(`uploading failed: ${bakingError}`)
    return { imageUrl: '', bakingError, bakedImagePath: tmpPath }
  } catch (uploadErr) {
    const message = uploadErr instanceof Error ? uploadErr.message : String(uploadErr)
    const bakingError = `[exception] ${message} — local PNG retained at output_path`
    logger(`upload exception: ${bakingError}`)
    return { imageUrl: '', bakingError, bakedImagePath: tmpPath }
  } finally {
    // W1.3 / A3-H3 修复：成功才清，失败保留——失败时 bakedImagePath
    // 透出给上层错误回执，让 LLM / 用户排查。
    if (uploadSucceeded) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        /* ignore — OS 会定期清 tmp */
      }
    }
  }
}

/**
 * 烤图 + OSS 上传链路（widget RFC §五 4.7）。串行"烤图 → uploadFileToOSS →
 * 返回 imageUrl"；烤图 / 上传任意一步失败 → imageUrl 留空（''）让移动端走
 * fallback。dev 环境通过 logger 输出 baking / uploading 阶段。
 */
export async function bakeAndUploadWidget(
  input: BakeWidgetInput,
): Promise<BakeAndUploadResult> {
  const { widgetId, renderCode, renderFormat, organizationId } = input
  const logger: (msg: string) => void = (msg) => {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
      console.debug(`[show-widget][${widgetId}] ${msg}`)
    }
  }
  try {
    // Widget Wave 7：resolve 当前 UI theme（Electron renderer 同步过来）；
    // Daemon / headless / 未注入 → 回落 'light' 保留 Wave 4 默认行为。
    const theme: BakeTheme = resolveUITheme() === 'dark' ? 'dark' : 'light'
    logger(`baking widget — calling OffscreenRenderAPI.renderToImage (theme=${theme})`)
    const offscreen = resolveOffscreenRenderAPI()
    if (!offscreen?.renderToImage) {
      const bakingError = 'OffscreenRenderAPI not registered'
      logger(`baking skipped: ${bakingError}`)
      return { imageUrl: '', bakingError }
    }
    const renderResult = await offscreen.renderToImage({
      code: renderCode,
      format: renderFormat,
      theme,
      // viewport 走默认（680×400，DPR=2），不开放 schema 避免 LLM 误传 huge viewport
    })
    if (!renderResult.success || !renderResult.buffer) {
      const bakingError = renderResult.error ?? 'render returned no buffer'
      logger(`baking failed: ${bakingError}`)
      return { imageUrl: '', bakingError }
    }
    return await uploadRenderedWidgetImage({
      widgetId,
      renderResult: { buffer: renderResult.buffer },
      organizationId,
      logger,
    })
  } catch (err) {
    const bakingError = err instanceof Error ? err.message : String(err)
    logger(`baking exception: ${bakingError}`)
    return { imageUrl: '', bakingError }
  }
}
