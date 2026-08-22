/**
 * 识别「新建 Skill 空模板」正文，避免启用时装 Registry 模板包盖掉已物化的导入内容。
 *
 * 与 Django `generate_skill_skeleton` / Electron `generateSkillSkeleton` 对齐：
 * 模板固定含「什么时候用这个 Skill」+ 占位步骤 `1. ...`。
 */

const SKELETON_MARKERS = [
  '## 什么时候用这个 Skill',
  '1. ...',
  '## 注意事项',
] as const

/** 本地已有非空 SKILL.md（含骨架模板）时返回 true——#7118 启用可跳过 Registry。 */
export function localSkillMdExists(content: string | null | undefined): boolean {
  return Boolean(content && content.trim())
}

/** 本地已有非空、且不像空模板的 SKILL.md 时返回 true。 */
export function looksLikeRealSkillContent(content: string | null | undefined): boolean {
  if (!localSkillMdExists(content)) return false
  const body = content!.trim()
  // 模板三件套齐了 → 视为骨架，不算「真正文」
  if (SKELETON_MARKERS.every((m) => body.includes(m))) return false
  return true
}
