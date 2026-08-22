/**
 * Rules Hook —— 每轮把工作目录根部 `AGENTS.md`（项目规约）注入 messages 最前。
 *
 * **归属（ Phase 1）**：本 hook 原名 `buildRulesInjectorHook`，住在
 * `@tabtin/agent-runtime` 的 `capability/injectors/rules-injector.ts`。因它依赖
 * `@tabtin/agent-prompt`，随「引擎零业务依赖」重构迁到宿主 `@tabtin/agent-host/hooks`。
 * 行为逐字节一致，仅换归属与工厂名（`buildRulesInjectorHook` → `buildRulesHook`）。
 *
 * **行为（结构照抄 memory / context hook）**：
 *   1. `await fetchProjectRules()`；try/catch 失败 → 静默跳过且**不撤销**上一轮注入
 *      （保留 last-good，避免规约在上下文里闪烁消失）
 *   2. 成功返回 null / 空 / 纯空白 → **撤掉旧块**（与 throw 区分：仅在确有旧块被摘除
 *      时才写回 filtered，保原引用语义）
 *   3. 按 charBudget 尾截 + 标记
 *   4. 渲染 `<project_rules>` 块 = buildProjectRulesSection(body)（agent-prompt SSoT）
 *   5. unshift 到 messages 最前——稳定的"宪法级"内容放最前，利于前缀 cache
 *   6. onInjected 回执 + 会话级一次性 SYSTEM_NOTICE
 *
 * **hook 本体不碰 fs**：读盘细节交给宿主注入的 `fetchProjectRules` 闭包。
 */

import { buildProjectRulesSection } from '@tabtin/agent-prompt'
import type { EngineHooks, IterationHookContext } from '@tabtin/agent-runtime/engine'
import { INTERNAL_MESSAGE_MARKERS } from '@tabtin/agent-runtime/engine'
import { RuntimeSystemNoticeEvent } from '@tabtin/agent-runtime'
import { removeTaggedBlock, upsertTaggedBlock } from './message-inject.js'

// ─── Public Types ────────────────────────────────────────────────────

/**
 * rules hook 工厂选项。收「闭包回调」——读盘细节交给宿主，hook 只做 fetch + 渲染 +
 * 注入（可单测、不直接依赖 node:fs、跨端安全）。
 */
export interface RulesHookOptions {
  /**
   * 拉取当前工作目录根部 `AGENTS.md` 的内容。由宿主实现（读盘 + mtime 缓存 + 截断）。
   * 返回 null = 无文件 / 空文件 / working_dir 未设 / 读失败 → 跳过注入。
   * throw / reject → 被本 hook try/catch 吞掉走"静默跳过"路径。
   */
  fetchProjectRules: () => Promise<string | null>
  /** 字符上限，超出尾截 + 截断标记。默认 32000。 */
  charBudget?: number
  /**
   * 注入成功回执（PRD §4.7 可观测）。宿主把它接到 debug 级日志。无文件 / 跳过时
   * **不**调。回执自身异常被吞，不阻塞 iteration。
   */
  onInjected?: (info: { chars: number; truncated: boolean }) => void
}

// ─── Internal Constants ──────────────────────────────────────────────

const DEFAULT_CHAR_BUDGET = 32000
const PROJECT_RULES_MARKER = INTERNAL_MESSAGE_MARKERS.PROJECT_RULES_INJECTION

// ─── Factory ─────────────────────────────────────────────────────────

/**
 * 构造 rules hook —— per-iteration 单块注入（AGENTS.md MVP）。把 `fetchProjectRules`
 * 返回的 `AGENTS.md` 内容渲染成 `<project_rules>` user message unshift 到 messages 最前。
 * 几处细腻语义**逐字保留**（见文件顶部 docstring）。
 */
export function buildRulesHook(options: RulesHookOptions): EngineHooks {
  const charBudget = options.charBudget ?? DEFAULT_CHAR_BUDGET
  const { fetchProjectRules, onInjected } = options

  // 本闭包 ≈ 一个 runtime 生命周期（≈ 一个 session）。记"是否已发过用户可见回执"——
  // 整个 session 只发一次"已加载项目规则"SYSTEM_NOTICE，避免每轮刷屏。
  let sessionNoticeSent = false

  return {
    async beforeIteration(hookCtx: IterationHookContext): Promise<void> {
      const state = hookCtx.state

      // 1. 拉 AGENTS.md 内容——**throw 静默跳过且不撤销**上一轮已注入的规约
      //    （瞬时 IO 抖动 → 保留 last-good，避免规约在上下文里闪烁消失）。
      let raw: string | null
      try {
        raw = await fetchProjectRules()
      } catch {
        return
      }

      const filtered = removeTaggedBlock(state.messages, PROJECT_RULES_MARKER)

      // 2. fetch 成功返回 null / 空 = 文件确实不在 / 为空（已与"抖动 throw"区分）——
      //    仅在确实摘掉了旧块才写回 filtered（逐字节等价于原实现的 `if (removedStale)`）。
      if (!raw || !raw.trim()) {
        if (filtered.length !== state.messages.length) state.messages = filtered
        return
      }

      // 3. charBudget 裁剪——超限尾截 + 标记。chars 上报"实际注入的规约字符数"。
      const { body, truncated, chars } = clipToCharBudget(raw, charBudget)

      // 4. 渲染——文本 SSoT 在 agent-prompt buildProjectRulesSection。
      const content = buildProjectRulesSection(body)
      if (!content) {
        if (filtered.length !== state.messages.length) state.messages = filtered
        return
      }

      // 5. 注入 messages 最前（"宪法级"内容放最前，利于前缀 cache）。装配末位保证
      //    本 hook 最后执行 → 稳定占 messages[0]。
      state.messages = upsertTaggedBlock(state.messages, {
        marker: PROJECT_RULES_MARKER,
        content: [{ type: 'text', text: content }],
        position: 'head',
      })

      // 6. 注入回执（PRD §4.7）——失败不阻塞 iteration。
      if (onInjected) {
        try {
          onInjected({ chars, truncated })
        } catch {
          // 回执失败静默——可观测埋点不该影响主路径。
        }
      }

      // 7. 用户可见回执：本 session 首次成功注入时 push 一条 SYSTEM_NOTICE，走
      //    state.__pendingNotices 队列，query.ts 在本轮 LLM 成功后 flush yield。
      if (!sessionNoticeSent) {
        sessionNoticeSent = true
        const notices = state.__pendingNotices ?? (state.__pendingNotices = [])
        notices.push(
          new RuntimeSystemNoticeEvent({
            content: `已加载项目规则 AGENTS.md（${chars} 字符${truncated ? '，已截断' : ''}）`,
            notice_type: 'project_rules_loaded',
            severity: 'info',
            chars,
            truncated,
          }).toStreamEvent(),
        )
      }
    },
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * charBudget 裁剪——只在尾部硬截 + 加截断标记。返回 body（含尾标记）+ truncated +
 * chars（实际注入的规约字符数，**不含**尾标记，截断时 = budget）。
 */
function clipToCharBudget(
  text: string,
  budget: number,
): { body: string; truncated: boolean; chars: number } {
  if (text.length <= budget) {
    return { body: text, truncated: false, chars: text.length }
  }
  return {
    body: `${text.slice(0, budget)}\n[project_rules truncated due to budget]`,
    truncated: true,
    chars: budget,
  }
}
