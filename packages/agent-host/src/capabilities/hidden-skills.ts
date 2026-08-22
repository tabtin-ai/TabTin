/**
 * TabTin 临时隐藏 skill 名单。
 *
 * 「隐藏哪个 app / skill」是产品运营决策，从中性 agent-runtime 迁出，由宿主装配
 * 时经 `initSkillsModule({ hiddenSkills })` 注入 LocalSkillRegistry。
 */

import type { HiddenSkillSets } from '@tabtin/agent-runtime/skills'

export const TEMPORARILY_HIDDEN_SKILLS: HiddenSkillSets = {
  appIds: new Set([
    'tabsite',
    'tabwhiteboard',
    'tabvideo',
    'tabmail',
    'tabphone',
    'tabinbox',
  ]),
  keys: new Set(),
}
