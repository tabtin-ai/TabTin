/**
 * 目录自带 Skill 合成（ W3）：零 node 依赖，经
 * `@tabtin/agent-runtime/skills/workspace-skill-merge` 供 renderer / main 共用。
 *
 * 遮蔽：按 `slug`；目录内同 slug 浅层优先；与基座冲突时目录版胜出。
 */

import type { LocalSkill } from './skill-types.js';

/** 遮蔽判定的最小输入形态：canonical key + slug（renderer 侧无需构造完整 LocalSkill）。 */
export interface SkillSlugRef {
  canonicalKey: string;
  slug: string;
}

export interface WorkspaceShadowingResult {
  /** 目录版内部去重后的胜出者（slug → 目录版 canonical key，扫描序先到先得）。 */
  workspaceWinnerBySlug: Map<string, string>;
  /** 目录版内部因 slug 冲突被丢弃的 key（浅层优先）。 */
  duplicateWorkspaceKeys: string[];
  /** 基座条目被目录版遮蔽的关系（就近优先的可解释输出）。 */
  shadowed: Array<{ workspaceKey: string; hiddenKey: string }>;
}

/**
 * 遮蔽判定唯一出口：main 合成与查看器解释都从这里取结果。
 */
export function computeWorkspaceShadowing(
  baseSkills: readonly SkillSlugRef[],
  workspaceSkills: readonly SkillSlugRef[],
): WorkspaceShadowingResult {
  const workspaceWinnerBySlug = new Map<string, string>();
  const duplicateWorkspaceKeys: string[] = [];
  for (const skill of workspaceSkills) {
    if (!skill.slug) continue;
    if (workspaceWinnerBySlug.has(skill.slug)) {
      duplicateWorkspaceKeys.push(skill.canonicalKey);
      continue;
    }
    workspaceWinnerBySlug.set(skill.slug, skill.canonicalKey);
  }

  const shadowed: WorkspaceShadowingResult['shadowed'] = [];
  for (const skill of baseSkills) {
    const winner = skill.slug ? workspaceWinnerBySlug.get(skill.slug) : undefined;
    if (winner) {
      shadowed.push({ workspaceKey: winner, hiddenKey: skill.canonicalKey });
    }
  }

  return { workspaceWinnerBySlug, duplicateWorkspaceKeys, shadowed };
}

export interface WorkspaceSkillMergeResult {
  skills: LocalSkill[];
  /**
   * 遮蔽关系：同 slug 冲突时目录版胜出，被遮蔽的基座条目记录在此——
   * 「为什么生效」单句可解释（查看器 / 日志消费）。
   */
  shadowed: Array<{ workspaceKey: string; hiddenKey: string }>;
}

/**
 * 目录自带 skill 与基座列表（平台供给 / Agent 携带 / 插件）合成。
 *
 * 就近优先：同 slug 冲突时目录版胜出（「离工作现场最近的定义压倒远端供给」）。
 * 遮蔽/去重判定全部来自 {@link computeWorkspaceShadowing}——不要在别处重算。
 */
export function mergeWorkspaceSkillsForRuntime(
  baseSkills: LocalSkill[],
  workspaceSkills: LocalSkill[],
  onWarn?: (msg: string) => void,
): WorkspaceSkillMergeResult {
  if (workspaceSkills.length === 0) {
    return { skills: baseSkills, shadowed: [] };
  }

  const shadowing = computeWorkspaceShadowing(baseSkills, workspaceSkills);

  const duplicateKeys = new Set(shadowing.duplicateWorkspaceKeys);
  for (const dupKey of shadowing.duplicateWorkspaceKeys) {
    const dup = workspaceSkills.find((s) => s.canonicalKey === dupKey);
    const winnerKey = dup ? shadowing.workspaceWinnerBySlug.get(dup.slug) : undefined;
    onWarn?.(
      `目录自带 skill slug 冲突：${dupKey} 与 ${winnerKey ?? '<unknown>'} 同 slug，保留浅层版本`,
    );
  }

  const hiddenKeys = new Set(shadowing.shadowed.map((s) => s.hiddenKey));
  const kept = baseSkills.filter((skill) => !hiddenKeys.has(skill.canonicalKey));
  const workspaceKept = workspaceSkills.filter(
    (skill) => !duplicateKeys.has(skill.canonicalKey),
  );

  return {
    skills: [...kept, ...workspaceKept].sort((a, b) =>
      a.canonicalKey.localeCompare(b.canonicalKey),
    ),
    shadowed: shadowing.shadowed,
  };
}
