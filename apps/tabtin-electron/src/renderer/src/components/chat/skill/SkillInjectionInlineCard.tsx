/**
 * SkillInjectionInlineCard — `skill_invoke` 注入消息的 inline 折叠卡片。
 *
 * **使用场景（W14 修时序错位）**：
 *
 * `skill_invoke` 工具触发后，runtime 把 SKILL.md 整文以 `role:'user'` 注入
 * 对话历史，前端 `streamMessageHandler`
 * 把它 push 到 `messagesBySessionId` 末尾。**但**：
 *
 *   1. 顶层渲染（`MessageBubble`）会让卡片显示在所有 assistant 之后——
 *      用户感觉错位（"Agent 干完所有活了，怎么最后才加载 skill"）；
 *   2. 真实语义是"Agent 在某个 tool_call 里调了 skill_invoke 工具，加载
 *      了对应的 SKILL.md"——卡片应该出现在**那个 tool_call 步骤的位置**。
 *
 * 所以：
 *   - `MessageBubble` 看到 `metadata.source === 'skill_invoke'` 直接返回 null，
 *     不在顶层渲染（旧 SkillInjectionMessage 路径退役）；
 *   - `MessageSteps` 渲染 tool_call 步骤时，按 `metadata.tool_call_id` 查找
 *     匹配的 skill user message，然后用本组件 inline 插入到该步骤之后。
 *
 * **本组件职责**：仅一个折叠卡片——`<details>` + summary（图标 / "Skill 指令
 * 注入" / Skill 名 / 字符数）+ 展开区。**不带**外层布局（旧实现的
 * `flex flex-col items-start py-2` 是顶层"消息气泡"位置约束，inline 渲染
 * 不需要——由父级 step row 决定缩进）。
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { Zap } from 'lucide-react'

interface SkillInjectionInlineCardProps {
  /** SKILL.md 整文内容（已注入到 LLM history 的 user message content）。 */
  content: string
  /**
   * 可选：上层若已知 Skill key 或 label，传进来当 summary。不传则按 content
   * 首行/首个 heading 作为 summary（兼容历史会话回放时只有 content 的场景）。
   */
  summaryHint?: string
}

/** 从 SKILL.md 文本中抽出最适合做折叠 summary 的一行（首个非空非 frontmatter 行）。 */
function deriveSummary(content: string): string {
  const lines = content.split('\n')
  let inFrontmatter = false
  for (const line of lines) {
    if (line === '---') {
      inFrontmatter = !inFrontmatter
      continue
    }
    if (inFrontmatter) continue
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#')) {
      return trimmed.length > 80 ? trimmed.slice(0, 80) + '…' : trimmed
    }
    if (trimmed.startsWith('#')) {
      const heading = trimmed.replace(/^#+\s*/, '')
      return heading.length > 80 ? heading.slice(0, 80) + '…' : heading
    }
  }
  return lines[0]?.slice(0, 80) || ''
}

export const SkillInjectionInlineCard: React.FC<SkillInjectionInlineCardProps> = React.memo(
  ({ content, summaryHint }) => {
    const { t } = useTranslation('chat')
    const trimmed = (content || '').trim()
    if (!trimmed) return null

    const summary = summaryHint && summaryHint.trim().length > 0
      ? (summaryHint.length > 80 ? summaryHint.slice(0, 80) + '…' : summaryHint)
      : deriveSummary(trimmed)

    return (
      <details
        className="rounded-lg border border-border/40 bg-muted/30 text-body my-1"
        data-testid="skill-injection-inline-card"
      >
        <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-foreground/80 hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
          <Zap className="h-3.5 w-3.5 text-type-webhook/80 shrink-0" />
          <span className="text-caption font-medium text-foreground/60 shrink-0">
            {t('skillInjectionMessage.label', { defaultValue: 'Skill 指令注入' })}
          </span>
          <span className="text-caption text-foreground/40 shrink-0">·</span>
          <span className="truncate text-caption text-foreground/60">{summary}</span>
          <span className="ml-auto shrink-0 text-caption text-foreground/40">
            {t('skillInjectionMessage.charCount', { defaultValue: '{{count}} 字符', count: trimmed.length })}
          </span>
        </summary>
        <div className="border-t border-border/30 px-3 py-2 text-foreground/80">
          <div className="whitespace-pre-wrap break-words text-caption leading-[1.7]">
            {trimmed}
          </div>
        </div>
      </details>
    )
  },
)

SkillInjectionInlineCard.displayName = 'SkillInjectionInlineCard'

export default SkillInjectionInlineCard
