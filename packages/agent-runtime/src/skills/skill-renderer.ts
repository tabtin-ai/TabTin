/**
 * `<skills>` 段渲染（Wave A · M1）
 *
 * 职责：把 registry 的 in-memory 索引渲染成字符串，供 SkillsCap
 * `hooks().beforeIteration` 写入 `state.__skillsHint`，由 query.ts
 * Phase 2 合并到 LLM system prompt（W2.3 取代旧 `createSkillsAndNotes`
 * middleware 路径，行为 100% 等价）。
 *
 * 注意 — **只返回"内容体"，不返回 XML tag**：
 *   middleware 里 `renderTaggedBlock('<skills>', '</skills>', content)` 会加标签
 *   （见 `packages/agent-runtime/src/middleware/skills-and-notes.ts:94-99`）。
 *   fetcher 返回 null 表示"本轮不注入"；返回空串会被 middleware 当成 "无内容" 跳过。
 *
 * 预算策略（PRD §5.4 + E1 §3.1 / §7.1）：
 * - 总预算 ~ context window 的 1%（默认 8000 字符 ≈ 2000 token）
 * - 单条 ≤ 250 字符硬截断
 * - 分组优先级 platform > app > workspace > device > user（priority 行提示）
 * - 超预算时**按 user → device → workspace → app → platform 逆序降级**（保内置、裁用户——用户"看得到"的
 *   更多是 platform/app，自己的 skill 即便没出现在 listing 也能在面板看到）
 * - 降级策略两档：① 长 description 截短到 ~80 字 ② 超额 skill 降为"仅名字"
 */

import type { LocalSkill, SkillsRenderContext } from './skill-types.js';
import { filterSkillsByEnablement } from './skill-enablement.js';
import type { SkillRecallPort } from './skill-recall-port.js';

/** 召回索引里 skill 候选集的 domain 名。 */
const RECALL_DOMAIN = 'skills';

export const DEFAULT_BUDGET_CHARS = 8_000;
/** full 模式下 description 截短到这个长度（单条上限） */
const MAX_DESC_CHARS = 200;
/** 短模式下 description 截短到这个长度，优先把 skill 塞下去 */
const SHORT_DESC_CHARS = 80;

/**
 * Canonical key 保持与 Django 兼容的格式：
 *   - platform: `platform:<domain>/<slug>` 或 `platform:<slug>`
 *   - app:      `app:<appId>/<slug>`
 *   - user:     `user:<slug>`
 *   - interop:  `device:<slug>`（：规范互操作目录归本机；历史 `user/interop:` 已弃用）
 *
 * Wave 6: 所有 skill 都在 Space sandbox 里，但 canonical key 格式不变——
 * source 信息从 .skill-meta.json 读取（metaSource 字段），spaceId 仅用于过滤。
 */
export function buildCanonicalKey(skill: Pick<
  LocalSkill,
  'source' | 'scope' | 'appId' | 'slug' | 'metaSource'
>): string {
  const effectiveSource = skill.metaSource ?? skill.source;
  if (effectiveSource === 'platform') {
    const domainPart = skill.appId ? `${skill.appId}/` : '';
    return `platform:${domainPart}${skill.slug}`;
  }
  if (effectiveSource === 'app') {
    const appPart = skill.appId ? `${skill.appId}/` : '';
    return `app:${appPart}${skill.slug}`;
  }
  if (effectiveSource === 'device' || skill.scope === 'interop') {
    return `device:${skill.slug}`;
  }
  return `user:${skill.slug}`;
}

/**
 * 单条 skill 渲染成一行 Markdown 表格：`| key | source | description |`。
 *   - `key`：canonicalKey，直接传给 `skills_read`；
 *   - `source`：platform / app / user（优先级信号）；
 *   - `description`：按降级模式给出——full 截到 MAX_DESC_CHARS、short 截到
 *     SHORT_DESC_CHARS、name-only 用 `—` 占位。
 */
type SkillEntryMode = 'full' | 'short' | 'name-only';

/** 表格单元格：折叠空白 + 转义 `|`，空值给占位符。 */
function cell(value: string): string {
  const s = value.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return s || '—';
}

function skillDisplaySource(skill: LocalSkill): string {
  if (skill.sourceType === 'workspace') return 'workspace';
  return skill.metaSource ?? skill.source ?? 'user';
}

function skillRow(skill: LocalSkill, mode: SkillEntryMode): string {
  const source = skillDisplaySource(skill);
  const key = skill.canonicalKey;
  if (mode === 'name-only') return `| ${cell(key)} | ${source} | — |`;
  const desc = (skill.description || '').replace(/\s+/g, ' ').trim();
  const cap = mode === 'short' ? SHORT_DESC_CHARS : MAX_DESC_CHARS;
  const clipped = desc.length > cap ? desc.slice(0, cap - 1) + '…' : desc;
  return `| ${cell(key)} | ${source} | ${cell(clipped)} |`;
}

/**
 * Wave 6 +  + : 按有效 source 分组展示。
 * metaSource 来自预装时写入的 .skill-meta.json；interop 根扫描为 device；
 * 目录自带 skill（sourceType=workspace）单独成组。
 */
function groupSkills(skills: LocalSkill[]): Map<string, LocalSkill[]> {
  const groups = new Map<string, LocalSkill[]>();
  groups.set('platform', []);
  groups.set('app', []);
  groups.set('device', []);
  groups.set('user', []);
  groups.set('workspace', []);

  for (const s of skills) {
    const bucket = skillDisplaySource(s);
    const list = groups.get(bucket);
    if (list) {
      list.push(s);
    } else {
      groups.get('user')!.push(s);
    }
  }

  for (const list of groups.values()) {
    list.sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey));
  }
  return groups;
}

/** 动态段：展示相关性最高的 N 个 skill。 */
const TOP_SHOWN_COUNT = 8;
/** 其中最相关的前 M 个带完整 description，其余仅名字（名称在静态索引已有）。 */
const TOP_DESC_COUNT = 5;
/**
 * 保底配额：带描述的前 TOP_DESC_COUNT 个里，至少保证这么多来自 app / platform
 * （TabTin 内置能力），避免被 device / user 的第三方 skill 挤到看不见——除非候选
 * 池里 app+platform 总数本就不足。
 */
const MIN_BUILTIN_IN_DESC = 3;

/** app / platform 来源即 TabTin 内置能力（区别于 device / user 的第三方 skill）。 */
function isBuiltinSourceSkill(skill: LocalSkill): boolean {
  const src = skill.metaSource ?? skill.source;
  return src === 'app' || src === 'platform';
}

/**
 * 在已按相关性降序排好的候选里做「内置来源保底」重排：保证带描述的前 TOP_DESC_COUNT
 * 个中至少有 MIN_BUILTIN_IN_DESC 个 app/platform（候选池不足则取全部）。做法是把窗口
 * 内相关性最低的非内置项，与窗口外相关性最高的内置项对调，改动最小、其余顺序不变。
 */
function enforceBuiltinQuota(sorted: LocalSkill[]): LocalSkill[] {
  const window = TOP_DESC_COUNT;
  const builtinTotal = sorted.reduce((n, s) => (isBuiltinSourceSkill(s) ? n + 1 : n), 0);
  const target = Math.min(MIN_BUILTIN_IN_DESC, builtinTotal, window);
  if (target === 0) return sorted;

  const arr = [...sorted];
  const countInWindow = () => {
    const end = Math.min(window, arr.length);
    let n = 0;
    for (let i = 0; i < end; i++) if (isBuiltinSourceSkill(arr[i])) n++;
    return n;
  };

  while (countInWindow() < target) {
    let demoteIdx = -1;
    for (let i = Math.min(window, arr.length) - 1; i >= 0; i--) {
      if (!isBuiltinSourceSkill(arr[i])) {
        demoteIdx = i;
        break;
      }
    }
    let promoteIdx = -1;
    for (let i = window; i < arr.length; i++) {
      if (isBuiltinSourceSkill(arr[i])) {
        promoteIdx = i;
        break;
      }
    }
    if (demoteIdx === -1 || promoteIdx === -1) break;
    [arr[demoteIdx], arr[promoteIdx]] = [arr[promoteIdx], arr[demoteIdx]];
  }
  return arr;
}

const RELEVANT_HEADER =
  'Most relevant skills for the current request (full names list is in the system prompt above):';
const NAMES_HEADER = [
  '以下列表是你所携带的技能。',
  '与当前任务相关的 skill 会在 `<relevant_skills>` 块中注入；当任务符合 skill 描述的场景时使用。',
].join('\n');
const FOCUSED_APP_BONUS_RATIO = 0.2;

const HEADER =
  'Priority: platform > app > workspace > device > user. 下面是可用 skill（Markdown 表）；列：key（传给 skills_read 的精确键）、source、description（可能被截断/省略为 —）。';
const TABLE_HEADER = '| key | source | description |\n| --- | --- | --- |';

/**
 * 动态段渲染：按与 query 的词法 + 语义双路融合相关性取 Top-N
 * （Markdown 表格）。前 TOP_DESC_COUNT 个带完整 description，其余仅名字（名称静态
 * 索引已有）。
 *
 * 由 SkillsCap.beforeRun 消费，经 context-injector 拼进当轮 `<context>` 块。返回
 * `null` 表示双路均无信号（query 与所有 skill 零重合且无语义命中）——不注入，模型
 * 仍有静态名称索引 + `skills_read` 兜底。recall 缺省时为纯词法路，行为与
 * 引入双路前一致。
 */
export interface RelevantTopKOptions {
  focusedApp?: string | null;
  /**
   * 召回端口（ /  Stage 6c），由 registry 持有并传入。
   * 缺省时用本地纯词法 BM25（与 search 在 scorer 缺席时对齐）。
   */
  recall?: SkillRecallPort;
}

function normalizeFocusedApp(app: string | null | undefined): string | null {
  const value = app?.trim().toLowerCase();
  return value || null;
}

function matchesFocusedApp(skill: LocalSkill, focusedApp: string | null): boolean {
  if (!focusedApp) return false;
  return (
    skill.appId?.toLowerCase() === focusedApp ||
    skill.canonicalKey.toLowerCase().startsWith(`app:${focusedApp}/`) ||
    skill.xTabtinApps?.some((app) => app.toLowerCase() === focusedApp) === true
  );
}

export async function renderRelevantTopK(
  skills: LocalSkill[],
  query: string,
  budget: number,
  options?: RelevantTopKOptions,
): Promise<string | null> {
  const q = query.trim();
  if (!q || skills.length === 0) return null;
  const focusedApp = normalizeFocusedApp(options?.focusedApp);

  const rankItems = skills.map((s) => ({
    id: s.canonicalKey,
    text: `${s.name} ${s.description} ${s.whenToUse ?? ''}`,
  }));
  if (!options?.recall) {
    throw new Error(
      'renderRelevantTopK: options.recall is required (host RecallIndex or createLexicalSkillRecall).',
    );
  }
  const recall = options.recall;
  // 候选集全量同步——宿主注入的 RecallIndex 会在文本变更时触发向量预热
  recall.replaceAll(RECALL_DOMAIN, rankItems);
  const results = await recall.query(RECALL_DOMAIN, q);
  const resultByKey = new Map(results.map((r) => [r.id, r]));
  const hasRelevant = results.some((r) => r.relevant);
  const maxScore = results.reduce((m, r) => Math.max(m, r.score), 0);
  const focusedMatches = focusedApp
    ? skills.filter((s) => matchesFocusedApp(s, focusedApp))
    : [];
  if (!hasRelevant && focusedMatches.length === 0) {
    return null; // 双路均无信号 / 无 focused App 信号，不注入动态段
  }
  // focused App 加分叠加在融合分之上：量纲跟随当轮最高分（相对），
  // 双路 / 词法单路两种分数量纲下都成立。纯 focused 分支给固定 1 保证非零。
  const focusedBonus = hasRelevant ? maxScore * FOCUSED_APP_BONUS_RATIO : 1;

  const sorted = (hasRelevant ? [...skills] : focusedMatches)
    .filter(
      (s) =>
        resultByKey.get(s.canonicalKey)?.relevant === true ||
        matchesFocusedApp(s, focusedApp),
    )
    .sort((a, b) => {
      const sb = resultByKey.get(b.canonicalKey)?.score ?? 0;
      const sa = resultByKey.get(a.canonicalKey)?.score ?? 0;
      const fb = matchesFocusedApp(b, focusedApp) ? focusedBonus : 0;
      const fa = matchesFocusedApp(a, focusedApp) ? focusedBonus : 0;
      const totalB = sb + fb;
      const totalA = sa + fa;
      if (totalB !== totalA) return totalB - totalA;
      if (sb !== sa) return sb - sa;
      return a.canonicalKey.localeCompare(b.canonicalKey);
    });

  // 来源保底：带描述的前 TOP_DESC_COUNT 个里至少 MIN_BUILTIN_IN_DESC 个来自
  // app/platform（候选不足则尽量），避免内置能力被第三方 skill 挤出可见窗口。
  const ranked = enforceBuiltinQuota(sorted).slice(0, TOP_SHOWN_COUNT);

  const rows: string[] = [];
  let used = RELEVANT_HEADER.length + TABLE_HEADER.length + 2;
  ranked.forEach((s, i) => {
    const row = skillRow(s, i < TOP_DESC_COUNT ? 'full' : 'name-only');
    if (used + row.length + 1 <= budget) {
      rows.push(row);
      used += row.length + 1;
    }
  });
  if (rows.length === 0) return null;
  return `${RELEVANT_HEADER}\n${TABLE_HEADER}\n${rows.join('\n')}`;
}

/**
 * 静态段渲染：**全部** skill 的名称索引（列表，仅 canonicalKey，按 platform → app →
 * workspace → device → user 优先级排列；source 由 key 前缀体现，无需表格）。query 无关、跨轮稳定，放进
 * system 静态段（boundary 之前）可被 prompt cache（BP2）覆盖。
 * 零启用 skill 时仍返回 header（用户措辞 / 不泄露 key 与路径等硬规则常驻）；无 key 行。
 */
export function renderSkillNames(
  skills: LocalSkill[],
  ctx: SkillsRenderContext,
): string | null {
  const filtered = filterSkillsByEnablement(
    skills,
    ctx.enabledMap,
  );
  // 原 skills_user_voice 全局注入；迁入 header 后即使封闭集为空也必须承接硬规则。
  if (filtered.length === 0) return NAMES_HEADER;

  const groups = groupSkills(filtered);
  const order: Array<'platform' | 'app' | 'workspace' | 'device' | 'user'> = [
    'platform',
    'app',
    'workspace',
    'device',
    'user',
  ];
  const lines = order.flatMap((g) =>
    (groups.get(g) ?? []).map((s) => `- ${s.canonicalKey}`),
  );
  return `${NAMES_HEADER}\n${lines.join('\n')}`;
}
const HINTS = [
  '',
  'Rules:',
  "- When the user's request matches a skill's description, you MUST use that skill.",
  '- Use `skills_read(key)` to see full instructions. Use the exact key shown above.',
  '- Use `skills_search(query)` to locate relevant skills by keyword.',
].join('\n');

type SkillSourceGroup = 'platform' | 'app' | 'workspace' | 'device' | 'user';

/** 按 platform → app → workspace → device → user 优先级展开表格行。 */
function buildRows(
  groups: Map<string, LocalSkill[]>,
  modes: Record<SkillSourceGroup, SkillEntryMode>,
): string[] {
  const order: SkillSourceGroup[] = ['platform', 'app', 'workspace', 'device', 'user'];
  return order.flatMap((g) => (groups.get(g) ?? []).map((s) => skillRow(s, modes[g])));
}

/** 把表格行渲染成「说明 + Markdown 表」的 body。 */
function renderBody(rows: string[]): string {
  return `${HEADER}\n${TABLE_HEADER}\n${rows.join('\n')}`;
}

/**
 * 渲染核心。返回：
 * - 非空字符串：middleware 会加 <skills> / </skills> 包起来（body 内含 Markdown 表）
 * - null：表示索引为空 / 全被过滤，本轮不注入（middleware 收到 null 清除 hint）
 *
 * 预算降级：4 档按 user → app → platform 逆序缩水（full → short → name-only），
 * 取第一个「body + hints」能塞进 budget 的档；都塞不下则返回最省的一档（不含 hints，
 * middleware 包 tag 后略超也在 LLM 容忍范围）。
 */
export function renderSkillsBlock(
  skills: LocalSkill[],
  ctx: SkillsRenderContext,
): string | null {
  const budget = ctx.budgetChars ?? DEFAULT_BUDGET_CHARS;

  // Agent 封闭携带集过滤：仅 enabled===true（见 skill-enablement.ts）
  const filtered = filterSkillsByEnablement(
    skills,
    ctx.enabledMap,
  );

  if (filtered.length === 0) return null;

  const groups = groupSkills(filtered);

  // 4 档降级路径（保内置、先收缩本机/用户/目录来源）
  const attempts: Array<Record<SkillSourceGroup, SkillEntryMode>> = [
    { platform: 'full', app: 'full', workspace: 'full', device: 'full', user: 'full' },
    { platform: 'full', app: 'full', workspace: 'short', device: 'short', user: 'short' },
    {
      platform: 'full',
      app: 'short',
      workspace: 'name-only',
      device: 'name-only',
      user: 'name-only',
    },
    {
      platform: 'short',
      app: 'name-only',
      workspace: 'name-only',
      device: 'name-only',
      user: 'name-only',
    },
  ];

  let lastBody = '';
  for (const modes of attempts) {
    lastBody = renderBody(buildRows(groups, modes));
    if (lastBody.length + HINTS.length + 1 <= budget) {
      return `${lastBody}\n${HINTS}`;
    }
  }
  // 都塞不下：返回最省一档 body（不含 hints）
  return lastBody;
}
