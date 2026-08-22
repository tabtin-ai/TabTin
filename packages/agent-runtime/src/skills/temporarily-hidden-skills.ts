/**
 * 临时隐藏 Skill 的**中性匹配器**。
 *
 * runtime 不持有任何具体产品的隐藏名单——「隐藏哪个 app / key」是宿主的运营决策，
 * 由宿主构造 {@link HiddenSkillSets} 注入（见 `LocalSkillRegistry` 的 `hiddenSkills`
 * 选项）。runtime 默认空集（{@link EMPTY_HIDDEN_SKILL_SETS}），即不隐藏任何 skill。
 *
 * 匹配规则（对注入的集合成立时判定为隐藏）：
 * 1. canonicalKey / skill_key 命中 `keys`；
 * 2. appId / app_id 命中 `appIds`；
 * 3. canonicalKey 落在被隐藏 app 的命名空间下（`app:<hiddenApp>/`）。
 */

export interface HiddenSkillSets {
  /** 被隐藏的 app id 集合（如 `tabvideo`）。 */
  appIds: ReadonlySet<string>
  /** 被隐藏的 canonical / skill key 集合（如 `app:tabvideo/tabvideo-operator`）。 */
  keys: ReadonlySet<string>
}

/** runtime 默认：不隐藏任何 skill。宿主未注入时用它。 */
export const EMPTY_HIDDEN_SKILL_SETS: HiddenSkillSets = {
  appIds: new Set<string>(),
  keys: new Set<string>(),
}

export function isTemporarilyHiddenSkill(
  skill: {
    canonicalKey?: string
    skill_key?: string
    appId?: string
    app_id?: string | null
  },
  hidden: HiddenSkillSets,
): boolean {
  const key = skill.canonicalKey || skill.skill_key || ''
  if (key && hidden.keys.has(key)) return true

  const appId = skill.appId || skill.app_id || ''
  if (appId && hidden.appIds.has(appId)) return true

  for (const hiddenApp of hidden.appIds) {
    if (key.startsWith(`app:${hiddenApp}/`)) return true
  }
  return false
}
