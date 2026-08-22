/**
 * LSP Diagnostic Hook —— 每轮把 pending LSP 诊断注入 messages 尾部。
 *
 * **归属（ Phase 1）**：本 hook 原名 `buildLspDiagnosticInjectorHook`，
 * 住在 `@tabtin/agent-runtime` 的 `capability/injectors/lsp-diagnostic-injector.ts`。
 * 因它依赖 `@tabtin/lsp-runtime` + `@tabtin/agent-prompt`，随「引擎零业务依赖」重构
 * 迁到宿主 `@tabtin/agent-host/hooks`。行为逐字节一致，仅换归属与工厂名
 * （`buildLspDiagnosticInjectorHook` → `buildLspDiagnosticHook`）。
 *
 * 设计要点：
 *   - **守门员**：当前 mode 工具白名单不含 shell 工具则不推（"能修才推"）
 *   - **mainThread only**：sub-agent 不接此 hook
 *   - **双层 wrap**：`<system-reminder>\n<new-diagnostics>\n...\n</new-diagnostics>\n</system-reminder>`
 *   - **取出后立即清 pending**：clearAllLSPDiagnostics()（delivered LRU 保留作跨 turn dedup）
 */

import {
  checkForLSPDiagnostics,
  clearAllLSPDiagnostics,
  type DiagnosticFile,
  type Diagnostic,
} from '@tabtin/lsp-runtime'
import { buildUserContextWrapper } from '@tabtin/agent-prompt'
import type { EngineHooks, IterationHookContext } from '@tabtin/agent-runtime/engine'
import { INTERNAL_MESSAGE_MARKERS } from '@tabtin/agent-runtime/engine'
import { removeTaggedBlock, upsertTaggedBlock } from './message-inject.js'

// ─── Public Types ────────────────────────────────────────────────────

export interface LspDiagnosticHookOptions {
  /**
   * 守门员：返回当前 LLM 调用工具白名单中"能用来跑命令验证诊断"的工具是否存在。
   * TabTin 侧检查 `run_terminal_command`（agent / group / study mode 有；
   * ask / plan mode 没有）。返回 false 时不注入。
   */
  hasShellTool: () => boolean

  /**
   * 是否在 sub-agent fork-query 路径下。Sub-agent 不应该接诊断 attachment。
   * 调用方通过此参数控制；缺省 false（即默认按 main thread 处理）。
   */
  isMainThread?: boolean
}

// ─── Internal Constants ──────────────────────────────────────────────

const LSP_MARKER = INTERNAL_MESSAGE_MARKERS.LSP_DIAGNOSTICS_INJECTION

/** Max total chars for diagnostic summary block. */
const MAX_DIAGNOSTICS_SUMMARY_CHARS = 4000

// ─── Severity Symbols ────────────────────────────────────────────────

const SEVERITY_SYMBOLS: Record<Diagnostic['severity'], string> = {
  Error: '✗',
  Warning: '⚠',
  Info: 'ℹ',
  Hint: '★',
}

// ─── Format helpers ──────────────────────────────────────────────────

/**
 * Format a single DiagnosticFile group.
 * 格式：`filename:\n  ${symbol} [行 l+1:c+1] message [code] (source)`
 */
function formatDiagnosticsSummary(files: DiagnosticFile[]): string {
  const truncationMarker = '…[已截断]'
  const result = files
    .map((file) => {
      const filename = file.uri.split('/').pop() || file.uri
      const diagnostics = file.diagnostics
        .map((d) => {
          const symbol = SEVERITY_SYMBOLS[d.severity] || '•'
          const codePart = d.code ? ` [${d.code}]` : ''
          const sourcePart = d.source ? ` (${d.source})` : ''
          return `  ${symbol} [行 ${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message}${codePart}${sourcePart}`
        })
        .join('\n')
      return `${filename}:\n${diagnostics}`
    })
    .join('\n\n')

  if (result.length > MAX_DIAGNOSTICS_SUMMARY_CHARS) {
    return (
      result.slice(0, MAX_DIAGNOSTICS_SUMMARY_CHARS - truncationMarker.length) +
      truncationMarker
    )
  }
  return result
}

/** Wrap content in `<system-reminder>...</system-reminder>` 作为内层结构。 */
function wrapInSystemReminder(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`
}

// ─── Factory ─────────────────────────────────────────────────────────

/**
 * 构造 lsp-diagnostic hook —— per-iteration 单块注入。把 pending LSP 诊断 format +
 * wrap 后 append 到 messages 尾（紧贴下一个 LLM call）。
 *  - (C11) 非 mainThread / (C10) 无 shell 工具（含 hasShellTool 抛错）→ 直接结束，不改 messages；
 *  - registry 异常 / 无新诊断 / 无有效文件 → 写回 filtered（清掉旧诊断块）；
 *  - 取出后立即 `clearAllLSPDiagnostics()`；插位 = append 到尾部。
 */
export function buildLspDiagnosticHook(options: LspDiagnosticHookOptions): EngineHooks {
  const { hasShellTool } = options
  const isMainThread = options.isMainThread ?? true

  return {
    async beforeIteration(ctx: IterationHookContext): Promise<void> {
      const state = ctx.state

      // (C11) sub-agent fork-query 路径不注入诊断
      if (!isMainThread) return
      // (C10) 守门员：当前 mode 没 shell 工具就不推（"能修才推"）
      try {
        if (!hasShellTool()) return
      } catch {
        // hasShellTool 抛错时保守不推
        return
      }

      const filtered = removeTaggedBlock(state.messages, LSP_MARKER)

      let diagnosticSets: ReturnType<typeof checkForLSPDiagnostics>
      try {
        diagnosticSets = checkForLSPDiagnostics()
      } catch {
        // registry 异常不阻塞 LLM 调用
        state.messages = filtered
        return
      }

      // 没新诊断：只清旧 marker message，不注入新的
      if (diagnosticSets.length === 0) {
        state.messages = filtered
        return
      }

      // 合并所有 server 的 file（防御性处理）
      const allFiles: DiagnosticFile[] = diagnosticSets.flatMap((s) => s.files)
      const validFiles = allFiles.filter((f) => f.diagnostics && f.diagnostics.length > 0)
      if (validFiles.length === 0) {
        state.messages = filtered
        return
      }

      // (重要) 取出后立即清 pending（delivered LRU 仍保留作跨 turn dedup）
      try {
        clearAllLSPDiagnostics()
      } catch {
        // clear 失败不影响本轮注入
      }

      const summary = formatDiagnosticsSummary(validFiles)
      // 阶段 6 议题 2：外层套统一 `<context type="lsp-diagnostic">` 壳；
      // inner `<system-reminder><new-diagnostics>...</new-diagnostics></system-reminder>` 保留。
      const inner = wrapInSystemReminder(
        `<new-diagnostics>检测到以下新的诊断问题：\n\n${summary}</new-diagnostics>`,
      )
      const content = buildUserContextWrapper('lsp-diagnostic', inner)

      // 注入到 messages 末尾（紧贴下一个 LLM call 之前）
      state.messages = upsertTaggedBlock(state.messages, {
        marker: LSP_MARKER,
        content: [{ type: 'text', text: content }],
        position: (f) => f.length,
      })
    },
  }
}
