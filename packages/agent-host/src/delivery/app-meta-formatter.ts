/**
 * App 详情行渲染器—— context-injector `details:` 段的业务实现。
 *
 * **定位**：core 的 context-injector（agent-runtime `capability/injectors/context-injector.ts`）
 * 只保留中性框架（focused / open_tabs 拼接、anchor 注入、字节稳定）；「按 appType 渲染
 * 具体资源详情行」这套业务（TabTin 产品名、各 App 的字段口径、tabtin CLI 配方）从 core
 * 迁到这个宿主实现，经 `buildContextInjectorHook` 的 `formatAppMeta` option 注入
 * （Electron / Daemon 在装配 context-injector 时传入 `createAppMetaFormatter()`）。
 *
 * **行为与迁移前逐字一致**：白名单 App 类型集合、字段 fallback 优先级、`details:` 段的
 * 每一行文本都与原 core 实现字节相同——保 prompt-cache 前缀稳定。
 */
import type { AppMetaFormatter } from '../hooks/index.js'

type AppMetaLineBuilder = (meta: Record<string, unknown>) => string[]

const APP_META_LINE_BUILDERS: Record<string, AppMetaLineBuilder> = {
  tabdata: buildTabDataMetaLines,
  tabdoc: buildTabDocMetaLines,
  tabslide: buildTabSlideMetaLines,
  tabweb: buildTabWebMetaLines,
  tabcode: buildTabCodeMetaLines,
  tabfolder: buildTabFolderMetaLines,
  tabwhiteboard: buildTabWhiteboardMetaLines,
  tabtracker: buildTabTrackerMetaLines,
  tabfiles: buildTabFilesMetaLines,
}

/**
 * 构造宿主侧 App 详情行渲染器。对不认识的 App 类型 / 无可渲染字段返回空数组——
 * context-injector 此时不输出详情段（与原 `shouldEmitDetails` 白名单语义等价：
 * 白名单 = `APP_META_LINE_BUILDERS` 的 key 集合）。
 */
export function createAppMetaFormatter(): AppMetaFormatter {
  return (appType: string, meta: Record<string, unknown>): string[] =>
    APP_META_LINE_BUILDERS[appType]?.(meta) ?? []
}

function buildTabDataMetaLines(meta: Record<string, unknown>): string[] {
  const lines: string[] = []
  const tableName = meta.current_table_name ?? meta.table_name
  const tableId = meta.current_table_id ?? meta.table_id
  if (tableName || tableId) {
    lines.push(`details:`)
    lines.push(`  current_table: "${tableName ?? 'Untitled'}"${tableId ? ` (id: ${tableId})` : ''}`)
  }
  const viewId = meta.current_view_id ?? meta.view_id
  if (viewId) lines.push(`  current_view_id: ${viewId}`)
  return lines
}

function buildTabDocMetaLines(meta: Record<string, unknown>): string[] {
  const lines: string[] = []
  const docTitle = meta.current_doc_title ?? meta.doc_title ?? meta.title
  const docId = meta.current_doc_id ?? meta.doc_id
  if (docTitle || docId) {
    lines.push(`details:`)
    lines.push(`  current_document: "${docTitle ?? 'Untitled'}"${docId ? ` (id: ${docId})` : ''}`)
    if (docId) {
      lines.push(`  read_current_document: tabtin doc read ${docId} --format json`)
      lines.push(`  read_large_document: tabtin doc list-blocks ${docId} --format json; tabtin doc chunks ${docId} --format json`)
    }
    lines.push(`  create_cloud_document: write_file path=.agent-drafts/<slug>.md → tabtin doc create --title "<title>" --markdown @.agent-drafts/<slug>.md --format json`)
    lines.push(`  update_document_metadata: tabtin doc update <document-id> --icon <emoji> --cover-image <url> --parent-id <parent-id> --tags <tag>`)
    lines.push(`  long_doc_rule: Agent 新建长文临时草稿必须写 .agent-drafts/<slug>.md；参数失败只改短命令并复用同一草稿，禁止把全文内联进 shell`)
  }
  return lines
}

function buildTabSlideMetaLines(meta: Record<string, unknown>): string[] {
  const lines: string[] = []
  const slideTitle = meta.current_slide_title ?? meta.slide_title ?? meta.title
  const slideId = meta.current_slide_id ?? meta.slide_id
  if (slideTitle || slideId) {
    lines.push(`details:`)
    lines.push(`  current_presentation: "${slideTitle ?? 'Untitled'}"${slideId ? ` (id: ${slideId})` : ''}`)
  }
  return lines
}

function buildTabWebMetaLines(meta: Record<string, unknown>): string[] {
  const lines: string[] = []
  // 前端 syncContext 实际注入的字段是 current_browser_url / current_browser_title
  // （manifest 声明 + handler.appMeta.resolve）。保留 current_url / page_title 作为
  // 历史 fallback，避免老链路退化。
  const url = meta.current_browser_url ?? meta.current_url ?? meta.url
  const pageTitle = meta.current_browser_title ?? meta.current_page_title ?? meta.page_title ?? meta.title
  if (url || pageTitle) lines.push(`details:`)
  if (url) lines.push(`  url: ${url}`)
  if (pageTitle) lines.push(`  page_title: ${pageTitle}`)
  return lines
}

function buildTabCodeMetaLines(meta: Record<string, unknown>): string[] {
  const lines: string[] = []
  const projectPath = meta.current_code_project_path ?? meta.project_path
  const currentFile = meta.current_code_file ?? meta.file
  const gitBranch = meta.current_git_branch ?? meta.git_branch
  const changedFiles = meta.current_git_changed_files
  if (projectPath || currentFile || gitBranch || changedFiles) lines.push(`details:`)
  if (projectPath) lines.push(`  project_path: ${projectPath}`)
  if (gitBranch) lines.push(`  git_branch: ${gitBranch}`)
  if (currentFile) lines.push(`  current_file: ${currentFile}`)
  if (changedFiles) lines.push(`  git_changed_files: ${changedFiles}`)
  return lines
}

function buildTabFolderMetaLines(meta: Record<string, unknown>): string[] {
  const lines: string[] = []
  const folderPath = meta.current_folder_path ?? meta.sandbox_path
  const currentFile = meta.current_file_path
  if (folderPath || currentFile) lines.push(`details:`)
  if (folderPath) lines.push(`  folder_path: ${folderPath}`)
  if (currentFile) lines.push(`  current_file: ${currentFile}`)
  return lines
}

function buildTabWhiteboardMetaLines(meta: Record<string, unknown>): string[] {
  const lines: string[] = []
  const canvasTitle = meta.current_canvas_title
  const canvasId = meta.current_canvas_id
  const pageId = meta.current_page_id
  if (canvasTitle || canvasId || pageId) lines.push(`details:`)
  if (canvasTitle || canvasId) {
    lines.push(`  current_whiteboard: "${canvasTitle ?? 'Untitled'}"${canvasId ? ` (id: ${canvasId})` : ''}`)
  }
  if (pageId) lines.push(`  current_page_id: ${pageId}`)
  return lines
}

function buildTabTrackerMetaLines(meta: Record<string, unknown>): string[] {
  const lines: string[] = []
  // 波次 4 Stage 2.7 一刀切：原 case 'tabagenda' 已下线，现在 tabtracker 模块
  // 提供 ``current_tracker_id`` / ``current_tracker_title`` 上下文字段
  // （详见 ``packages/apps/tabtracker/app.json`` agentIntegration.contextFields）。
  const trackerTitle = meta.current_tracker_title ?? meta.title
  const trackerId = meta.current_tracker_id
  if (trackerTitle || trackerId) {
    lines.push(`details:`)
    lines.push(`  current_tracker: "${trackerTitle ?? 'Untitled'}"${trackerId ? ` (id: ${trackerId})` : ''}`)
  }
  return lines
}

function buildTabFilesMetaLines(meta: Record<string, unknown>): string[] {
  const lines: string[] = []
  // 详见 ``packages/apps/tabfiles/app.json`` agentIntegration.contextFields。
  const fileName = meta.current_file_name ?? meta.title
  const fileId = meta.current_file_id
  if (fileName || fileId) {
    lines.push(`details:`)
    lines.push(`  current_file: "${fileName ?? 'Untitled'}"${fileId ? ` (id: ${fileId})` : ''}`)
  }
  return lines
}
