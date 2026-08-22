/**
 * 文档标题的纯逻辑：哨值映射 + 「doc.title → 输入框」同步决策。
 *
 * 抽成独立无副作用模块，便于单测，且不拉起 TipTap 编辑器 / context。
 */

/**
 * 后端在 title 为空时回落到的字面值——与 apps/tabtin_django/apps/tabdoc/services/document_service.py
 * 的 `or "未命名文档"` 及 apps/tabtin_django/apps/tabdoc/models.py 的 `default="未命名文档"` 对齐。
 * 前端在显示时把这个哨值映射成空字符串，让 placeholder「请输入标题」能露出来；
 * commit 时如果用户清空标题，也回落到这个值，避免触发后端 `tabdoc.title_cannot_be_empty`，
 * 并保证前后端语义一致（空标题 = 未命名文档）。
 */
export const UNTITLED_DOCUMENT_FALLBACK = '未命名文档'

/** 与后端 Document.title CharField(max_length=255) 对齐 */
export const MAX_DOCUMENT_TITLE_LENGTH = 255

export function isUntitledTitle(title: string | null | undefined): boolean {
  return !title || title.trim() === UNTITLED_DOCUMENT_FALLBACK
}

export function displayTitleFromDoc(title: string | null | undefined): string {
  return isUntitledTitle(title) ? '' : (title ?? '')
}

export function normalizeTitleInputValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ')
}

/**
 * 「doc.title → 受控输入框」一次同步该如何处理：
 * - `reset`：切换 / 重新打开文档（doc.id 变化），标题以服务端（DB）值为准，
 *   无条件覆盖，并丢弃任何残留的本地未提交编辑（清 debounce / in-flight）。
 * - `ignore`：同一文档内 doc.title 变化，但本地存在未提交 / 在途的标题编辑，
 *   忽略外部回写——否则正文 autosave 整包回写、乱序 PATCH 回声、协作回声会把旧标题
 *   灌回正在编辑的输入框，造成标题在新旧值之间来回跳变。
 * - `adopt`：同一文档内 doc.title 变化且本地无待提交编辑，采纳外部值
 *   （含他人协作改名、自己刚提交成功的回写）。
 */
export type TitleSyncDecision = 'reset' | 'adopt' | 'ignore'

export function decideTitleSync(params: {
  prevDocId: string | null | undefined
  nextDocId: string | null | undefined
  /** debounce 计时中或 PATCH 在途 */
  hasPendingEdit: boolean
  /** 输入框已有本地改动但尚未 commit 完成（覆盖 debounce 清空 timer 与 pending 之间的空隙，） */
  hasLocalEdit?: boolean
}): TitleSyncDecision {
  const { prevDocId, nextDocId, hasPendingEdit, hasLocalEdit = false } = params
  if (nextDocId !== prevDocId) return 'reset'
  if (hasPendingEdit || hasLocalEdit) return 'ignore'
  return 'adopt'
}
