/**
 * Skill 清单 token 预算截断 —— SSoT 单源。
 *
 * **历史背景（W2.2.3）**：本模块最初为 `middleware/skills-budget.ts`，与
 * `createSkillsAndNotes` 工厂耦合。W2.2.3 解耦——基础设施迁到 `skills/`
 * 目录成为单源；`middleware/skills-budget.ts` 仅 re-export 保持向后兼容
 * （W2.3 删 middleware 整目录时一并清空）。
 *
 * **算法**： `formatCommandsWithinBudget`（SkillTool/prompt.ts:70-171）
 * 的三层截断策略——
 *
 * 预算公式：`contextWindowTokens × SKILL_BUDGET_CONTEXT_PERCENT × CHARS_PER_TOKEN`
 * - 1% context window，200k → 8000 字符
 * - 单条 cap 250 字符
 * - platform/bundled skill 不参与截断
 *
 * 三层截断：
 * 1. full descriptions —— 不超 budget 直接用
 * 2. 均分剩余 —— 非 platform 按条目数均分，每条 ≥ MIN_DESC_LENGTH
 * 3. 极端 —— 非 platform 只留名字
 *
 * **下游消费方**：
 *   - `capability/core/skills.ts::SkillsCap.hooks().beforeIteration` —— 每轮
 *     调用 truncateSkillsWithinBudget 把 listing 压缩到 system prompt 预算内
 *   - `middleware/skills-and-notes.ts::createSkillsAndNotes` —— 旧 middleware
 *     路径仍消费（W2.3 删除时一起退场）
 *   - `middleware/skills-budget.ts` —— 历史外部消费者通过 barrel re-export
 *     看到本模块导出的符号
 */

import type { SkillMeta, SkillListingResult } from './skill-listing-types.js';

export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01;
export const CHARS_PER_TOKEN = 4;
export const DEFAULT_CHAR_BUDGET = 8_000;
export const MAX_LISTING_DESC_CHARS = 250;
const MIN_DESC_LENGTH = 20;

export function getCharBudget(contextWindowTokens?: number): number {
  if (contextWindowTokens && contextWindowTokens > 0) {
    return Math.floor(contextWindowTokens * CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT);
  }
  return DEFAULT_CHAR_BUDGET;
}

/**
 * 对 skill 列表做 token 预算截断，返回截断后的 SkillListingResult。
 *
 * platform skill 不参与截断（always full description）。
 *
 * 注意：这是「结构化 fetcher」路径（fetcher 返回 SkillMeta[]）的均分截断器。
 * 当前 Electron / Daemon 两个 host 的 live 路径都走 LocalSkillRegistry.render()
 * → skill-renderer.ts（分组渲染，相关性排序也在那），不经过本函数。相关性选择的
 * SSoT 在 skill-renderer.ts。
 */
export function truncateSkillsWithinBudget(
  skills: SkillMeta[],
  contextWindowTokens?: number,
  formattedContentPassthrough?: string,
): SkillListingResult {
  if (skills.length === 0) {
    return { formattedContent: formattedContentPassthrough ?? '', skills: [] };
  }

  const budget = getCharBudget(contextWindowTokens);

  const platformSkills = skills.filter(s => s.isPlatform);
  const userSkills = skills.filter(s => !s.isPlatform);

  const platformChars = platformSkills.reduce(
    (acc, s) => acc + entryChars(s, MAX_LISTING_DESC_CHARS),
    0,
  );

  const headerLine = `你有 ${skills.length} 个可用技能。用 \`skills_read\` 查看其完整内容。\n`;
  const remainingBudget = Math.max(0, budget - platformChars - headerLine.length);

  // Layer 1: try full descriptions for all user skills
  const fullUserChars = userSkills.reduce(
    (acc, s) => acc + entryChars(s, MAX_LISTING_DESC_CHARS),
    0,
  );

  let truncatedUserSkills: Array<{ skill: SkillMeta; displayDesc: string }>;

  if (fullUserChars <= remainingBudget) {
    truncatedUserSkills = userSkills.map(s => ({
      skill: s,
      displayDesc: capDescription(s, MAX_LISTING_DESC_CHARS),
    }));
  } else if (userSkills.length > 0) {
    // Layer 2: distribute remaining budget evenly, accounting for
    // per-entry overhead (key + source + formatting)
    const overheads = userSkills.map(s => entryOverhead(s));
    const totalOverhead = overheads.reduce((a, b) => a + b, 0);
    const descBudget = Math.max(0, remainingBudget - totalOverhead);
    const perSkillDescBudget = Math.floor(descBudget / userSkills.length);

    if (perSkillDescBudget >= MIN_DESC_LENGTH) {
      truncatedUserSkills = userSkills.map(s => ({
        skill: s,
        displayDesc: capDescription(s, perSkillDescBudget),
      }));
    } else {
      // Layer 3: extreme — only names for user skills
      truncatedUserSkills = userSkills.map(s => ({
        skill: s,
        displayDesc: '',
      }));
    }
  } else {
    truncatedUserSkills = [];
  }

  const allEntries = [
    ...platformSkills.map(s => ({
      skill: s,
      displayDesc: capDescription(s, MAX_LISTING_DESC_CHARS),
    })),
    ...truncatedUserSkills,
  ];

  const lines: string[] = [headerLine.trimEnd(), ''];

  for (const { skill, displayDesc } of allEntries) {
    const srcTag = skill.source ? ` (${skill.source})` : '';
    if (displayDesc) {
      lines.push(`- \`${skill.canonicalKey}\`${srcTag}: ${displayDesc}`);
    } else {
      lines.push(`- \`${skill.canonicalKey}\`${srcTag}`);
    }
  }

  return {
    formattedContent: lines.join('\n'),
    skills: allEntries.map(e => e.skill),
  };
}

function entryChars(skill: SkillMeta, descCap: number): number {
  return entryOverhead(skill) + capDescription(skill, descCap).length;
}

/** Fixed character overhead per entry (key + source + separators + newline). */
function entryOverhead(skill: SkillMeta): number {
  const keyPart = `- \`${skill.canonicalKey}\``;
  const srcPart = skill.source ? ` (${skill.source})` : '';
  return keyPart.length + srcPart.length + 2 + 1; // ": " + "\n"
}

function capDescription(skill: SkillMeta, maxChars: number): string {
  let desc = skill.description ?? '';
  if (skill.whenToUse) {
    desc = desc ? `${desc} — ${skill.whenToUse}` : skill.whenToUse;
  }
  if (desc.length > maxChars) {
    return `${desc.slice(0, maxChars - 3)}...`;
  }
  return desc;
}
