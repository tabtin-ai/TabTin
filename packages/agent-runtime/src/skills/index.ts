/**
 * Skill contracts & pure helpers for Agent runtime.
 *
 * Disk lifecycle (registry / watcher / install / module init) belongs in the
 * shared host package. This module keeps enablement, listing protocols,
 * rendering, parsing, and workspace merge — capabilities that do not own
 * local filesystem orchestration.
 */

export type {
  SkillRecallPort,
  SkillRecallItem,
  SkillRecallHit,
} from './skill-recall-port.js';
export { createLexicalSkillRecall } from './skill-recall-port.js';

export {
  computeWorkspaceShadowing,
  mergeWorkspaceSkillsForRuntime,
  type SkillSlugRef,
  type WorkspaceShadowingResult,
  type WorkspaceSkillMergeResult,
} from './workspace-skill-merge.js';

export {
  buildCanonicalKey,
  renderSkillsBlock,
  renderSkillNames,
  renderRelevantTopK,
  DEFAULT_BUDGET_CHARS,
} from './skill-renderer.js';

export {
  SkillEnablementMapCache,
  configsToEnablementMap,
  filterSkillsByEnablement,
  isDeviceSkillKey,
  isWorkspaceSkillKey,
  isSkillEnabledByMap,
  parseAgentSkillEnablementResponse,
} from './skill-enablement.js';

/**
 * 首发分身预装的官方 Pack。货架上仍可按 marketplace 安装，
 * 菜单标「内置起步包」；本机预装必须收录，不能等用户点安装。
 *
 * 改名单时同步 renderer `skillProductState.FIRST_PARTY_STARTER_PACK_IDS`
 * （渲染层不直接引本包，避免 vitest / 打包把宿主 skills 拉进 renderer）。
 */
export const FIRST_PARTY_STARTER_PACK_IDS: ReadonlySet<string> = new Set([
  'tabtin-workflow-skills-pack',
  'tabtin-engineering-discipline-pack',
  'ponytail',
]);

export function isFirstPartyStarterPackAppId(appId: string): boolean {
  return FIRST_PARTY_STARTER_PACK_IDS.has(appId);
}

/**
 * 从 app skill 的 canonical key（`app:<appId>/<slug>`）解析 appId + slug。
 *
 * 用途：宿主「回补协调」（reconcile）时，把后端 enablement 里已启用但本地缺失的
 * app skill key 解析成 materialize 需要的 appId / slug。非 app 前缀 / 无 `/` 段 /
 * 含 `..` 穿越 → 返回 null（调用方跳过）。
 */
export function parseAppSkillCanonicalKey(
  key: string,
): { appId: string; slug: string } | null {
  const prefix = 'app:';
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const appId = rest.slice(0, slash);
  const slug = rest.slice(slash + 1);
  if (!appId || !slug) return null;
  if (appId.includes('..') || slug.includes('..')) return null;
  return { appId, slug };
}

/** 后端 Skill 可见目录 / Agent 携带集条目里回补协调关心的最小字段。 */
export interface VisibleSkillEntry {
  skill_key?: string;
  skill_canonical_key?: string;
  source?: string;
  enabled?: boolean;
}

/**
 * 回补协调纯 diff：从后端 Skill 条目里挑出「应在本地、但本地缺失」的
 * app skill 坐标，供宿主逐个 materialize。兼容可见目录的 `skill_key` 与 Agent
 * 携带集的 `skill_canonical_key`，避免调用方把后端契约转换逻辑写死在宿主层。
 */
export function selectAppSkillsToReconcile(
  visible: readonly VisibleSkillEntry[],
  localKeys: ReadonlySet<string>,
): Array<{ key: string; appId: string; slug: string }> {
  const out: Array<{ key: string; appId: string; slug: string }> = [];
  const seen = new Set<string>();
  for (const entry of visible) {
    if (entry?.source !== 'app' || entry.enabled === false) continue;
    const key = typeof entry.skill_key === 'string'
      ? entry.skill_key
      : typeof entry.skill_canonical_key === 'string'
        ? entry.skill_canonical_key
        : '';
    if (!key || localKeys.has(key) || seen.has(key)) continue;
    const coords = parseAppSkillCanonicalKey(key);
    if (!coords) continue;
    seen.add(key);
    out.push({ key, ...coords });
  }
  return out;
}

export {
  loadEnabledPersonalPluginSkillSnapshot,
  mergeSkillListsForRuntime,
  searchRuntimeSkills,
  type LoadEnabledPersonalPluginSkillSnapshotOptions,
  type PersonalPluginSkillSnapshot,
} from './personal-plugin-skill-loader.js';

export { parseSkillDoc } from './skill-doc-parser.js';

export type {
  LocalSkill,
  SkillFrontmatter,
  SkillSource,
  UserScope,
  ScanRoot,
  ScanRootKind,
  SkillsRenderContext,
  SkillsChangedEvent,
  SkillsChangedListener,
  SkillParseFailure,
  ParsedSkillCandidate,
} from './skill-types.js';

export {
  createHttpSkillsFetcher,
  type HttpSkillsFetcherOptions,
} from './skills-fetcher-http.js';

export type {
  SkillsFetcher,
  SkillsFetchContext,
  SkillListingResult,
  SkillMeta,
  SkillsTwoZoneResult,
  SkillResourceEntry,
  SkillResourceReadResult,
} from './skill-listing-types.js';

export {
  truncateSkillsWithinBudget,
  getCharBudget,
  SKILL_BUDGET_CONTEXT_PERCENT,
  CHARS_PER_TOKEN,
  DEFAULT_CHAR_BUDGET,
  MAX_LISTING_DESC_CHARS,
} from './skill-budget.js';

export {
  isTemporarilyHiddenSkill,
  EMPTY_HIDDEN_SKILL_SETS,
  type HiddenSkillSets,
} from './temporarily-hidden-skills.js';
