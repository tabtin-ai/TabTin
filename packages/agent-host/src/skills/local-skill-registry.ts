/**
 * LocalSkillRegistry（Wave A · M1）
 *
 * 职责（PRD §5.2 M1）：
 * 1. 持有 in-memory skill 索引（Map）
 * 2. 启动期全扫描，`ready` promise 等待首次完成
 * 3. 增量更新：watcher 触发单根重扫，diff 后 emit 变更
 * 4. 查询 API：getByKey / search / render / listAll / getRootForPath
 * 5. 订阅 API：subscribeChanges（renderer / agent-runtime 消费）
 *
 * 设计要点：
 * - **realpath 去重**（PRD §5.2 M1 要点 ③）：跨多根同一物理文件只保留第一次扫到的
 * - **半成品降级**：parser 返回 null 不影响其他 skill；warn 日志由宿主注入的 logger
 *   收集——未来面板可以基于 warn 事件做 red 标（L21 遗留）
 * - **纯数据层**：本类不碰 chokidar，也不做 IPC；M2 watcher 调本类的 applyRootUpdate
 *   注入变更，本类 emit 事件
 * - **不耦合 Electron API**：测试里用 vitest node 环境可直接 new
 */

import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  computeScanRoots,
  defaultScannerEnv,
  scanAll,
  scanRoot,
  type ScannerEnv,
} from './skill-scanner.js';
import {
  buildCanonicalKey,
  renderSkillNames,
  renderRelevantTopK,
  DEFAULT_BUDGET_CHARS,
  filterSkillsByEnablement,
  mergeSkillListsForRuntime,
  mergeWorkspaceSkillsForRuntime,
  isTemporarilyHiddenSkill,
  EMPTY_HIDDEN_SKILL_SETS,
  type SkillRecallPort,
  type SkillsTwoZoneResult,
  type LocalSkill,
  type ParsedSkillCandidate,
  type ScanRoot,
  type SkillParseFailure,
  type SkillsChangedEvent,
  type SkillsChangedListener,
  type SkillsRenderContext,
  type SkillResourceEntry,
  type SkillResourceReadResult,
  type HiddenSkillSets,
} from '@tabtin/agent-runtime/skills';

/**
 * Tier-3 附属资源目录（相对 skill 根，即 SKILL.md 所在目录）。
 *
 * 只暴露分层文档目录（`references/` / `examples/`）——这些是 SKILL.md 正文里
 * 「详见 references/xxx」指向的按需读取内容。刻意不含 `scripts/`（代码，另有
 * 执行链路）、`.skill-meta.json` 等元文件。
 */
const SKILL_RESOURCE_DIRS = ['references', 'examples'] as const;

/** 摘要最长字符数（清单展示用，超出截断加省略号）。 */
const RESOURCE_SUMMARY_MAX = 120;

/** 从 Markdown / 文本正文提取一句话摘要：跳过 frontmatter，取首个标题或首行。 */
function extractResourceSummary(content: string): string | undefined {
  const lines = content.split('\n');
  let inFrontmatter = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (i === 0 && line === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line === '---') inFrontmatter = false;
      continue;
    }
    if (!line) continue;
    let text = line;
    if (line.startsWith('#')) text = line.replace(/^#+\s*/, '');
    else if (line.startsWith('>')) text = line.replace(/^>\s*/, '');
    text = text.trim();
    if (!text) continue;
    return text.length > RESOURCE_SUMMARY_MAX
      ? `${text.slice(0, RESOURCE_SUMMARY_MAX - 1)}…`
      : text;
  }
  return undefined;
}

export interface RegistryLogger {
  warn(msg: string): void;
  info(msg: string): void;
}

const defaultLogger: RegistryLogger = {
  warn: (msg) => console.warn(`[skills] ${msg}`),
  info: (msg) => console.info(`[skills] ${msg}`),
};

const DEFAULT_SHARED_BUILTIN_READY_ATTEMPTS = 3;
const DEFAULT_SHARED_BUILTIN_READY_DELAY_MS = 120;

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RegistryOptions {
  env?: ScannerEnv;
  logger?: RegistryLogger;
  /**
   * Skill 召回端口（ /  Stage 6c）。宿主注入
   * `@tabtin/search` 的 `RecallIndex`；单测可传 `createLexicalSkillRecall()`。
   * 缺省不再静默建 BM25——避免生产双 scorer。
   */
  skillRecall?: SkillRecallPort;
  /**
   * 临时隐藏 skill 名单（产品运营决策，由宿主注入；）。list / search /
   * render 统一按此集合过滤。缺省时不隐藏任何 skill。
   */
  hiddenSkills?: HiddenSkillSets;
}

function registryKeyForSkill(skill: LocalSkill): string {
  if (skill.scope === 'space' && skill.spaceId) {
    return `space:${skill.spaceId}:${skill.canonicalKey}`;
  }
  if (skill.scope === 'interop') {
    return `interop:${skill.canonicalKey}`;
  }
  // shared（内置共享store）与无作用域一样用裸 canonicalKey——单份、全局唯一，
  // 不按 spaceId 命名空间化，实现「一份共享、去重复用」。
  return skill.canonicalKey;
}

function skillMatchesLookup(
  skill: LocalSkill,
  canonicalKey: string,
  options?: { spaceId?: string; organizationId?: string },
): boolean {
  if (skill.canonicalKey !== canonicalKey) return false;
  if (!options?.spaceId && !options?.organizationId) return true;
  if (skill.scope === 'interop' || skill.scope === 'shared') return true;
  //  个人根：无 spaceId 时跨上下文可见
  if (skill.scope === 'user' && !skill.spaceId) return true;
  //  组织根（新布局）：无 spaceId，按 organizationId 过滤
  if (skill.scope === 'organization' && !skill.spaceId) {
    return (
      !options.organizationId || skill.organizationId === options.organizationId
    );
  }
  // legacy space 根（带 spaceId）：按 spaceId 过滤
  if (options.spaceId && skill.spaceId === options.spaceId) return true;
  return false;
}

function skillBelongsToRoot(skill: LocalSkill, root: ScanRoot): boolean {
  const rootPrefix = root.path.endsWith('/') || root.path.endsWith('\\')
    ? root.path
    : root.path + '/';
  const rootPrefixWin = root.path.endsWith('\\') ? root.path : root.path + '\\';
  return skill.docPath.startsWith(rootPrefix) || skill.docPath.startsWith(rootPrefixWin);
}

function skillContentChanged(existing: LocalSkill, next: LocalSkill): boolean {
  return existing.content !== next.content
    || existing.description !== next.description
    || existing.name !== next.name
    || existing.realpath !== next.realpath;
}

/**
 * 把一个 candidate 转为 LocalSkill（赋 canonicalKey + indexedAt）。
 */
function toLocalSkill(
  candidate: ParsedSkillCandidate,
  now: number,
): LocalSkill {
  const fm = candidate.frontmatter;
  const canonicalKey = buildCanonicalKey({
    source: candidate.source,
    scope: candidate.scope,
    appId: candidate.appId,
    slug: fm.slug,
    metaSource: candidate.metaSource,
  });
  return {
    canonicalKey,
    source: candidate.source,
    scope: candidate.scope,
    appId: candidate.appId,
    spaceId: candidate.spaceId,
    organizationId: candidate.organizationId,
    slug: fm.slug,
    name: fm.name,
    displayName: fm.displayName,
    description: fm.description,
    whenToUse: fm.when_to_use,
    version: fm.version,
    docPath: candidate.docPath,
    realpath: candidate.realpath,
    content: candidate.content,
    xTabtinApps: fm['x-tabtin-apps'],
    xTabtinAgents: fm['x-tabtin-agents'],
    tags: fm.tags,
    category: fm.category,
    requires: fm.requires,
    install: fm.install,
    osFilter: fm.os_filter,
    always: fm.always,
    emoji: fm.emoji,
    homepage: fm.homepage,
    agents: fm.agents,
    // Wave 1.5 P0-1 补丁：frontmatter.primary_env（归一化后）→ 结构化字段
    primaryEnv: fm.primary_env,
    rootKind: candidate.rootKind,
    metaSource: candidate.metaSource,
    indexedAt: now,
  };
}

export class LocalSkillRegistry {
  /** 主索引：registryKey → LocalSkill。Space skill 的 registryKey 带 spaceId，避免同 slug 冲突。 */
  private readonly byKey = new Map<string, LocalSkill>();
  /** realpath → registryKey 反查（跨根去重 + watcher 回灌用） */
  private readonly byRealpath = new Map<string, string>();

  private readonly env: ScannerEnv;
  private readonly logger: RegistryLogger;
  /** 宿主注入的临时隐藏 skill 名单（缺省空集，不隐藏任何 skill）。 */
  private readonly hiddenSkills: HiddenSkillSets;
  /** 召回端口（ /  Stage 6c）：候选集 + 相关性检索。 */
  private readonly recall: SkillRecallPort;
  private readonly listeners = new Set<SkillsChangedListener>();

  /**
   * 解析失败记录（Review P0-5 → 订阅通道，供面板 M9 消费打 red 标）。
   * key 用 docPath 去重：同一文件重复 warn 只留最新一条。
   */
  private readonly parseFailures = new Map<string, SkillParseFailure>();
  private readonly failureListeners = new Set<(f: SkillParseFailure[]) => void>();

  /**
   * Wave B 可能把 refreshSlug 串行化（按 root 加互斥）。本 Wave 层面通过
   * watcher.flushNow 里按 root 去重调度已消除主要 race；Registry 内部
   * 也保持"同步 Map 操作 + 顺序 await"的模式，避免跨 slug 的竞态。
   */
  private readonly refreshQueues = new Map<string, Promise<void>>();

  /** 当前扫描根列表（启动期一次计算；M2 watcher 和增量更新都基于这个） */
  private roots: ScanRoot[] = [];

  private readyPromise: Promise<void> | null = null;
  private firstScanDone = false;

  /**
   * 是否启用了内置共享store（去重复用）。启用时，Space 目录里历史遗留的
   * per-space 内置副本（scope=space 且 canonicalKey 为 platform:/app:）在内存里
   * 一律忽略——共享store的那一份是唯一真相。这样去重在**启动即生效**，不依赖
   * 磁盘迁移（`removeBuiltinCopiesFromSpace`）是否已对每个 Space 跑过。
   */
  private readonly hasSharedBuiltins: boolean;

  constructor(options: RegistryOptions = {}) {
    this.env = options.env ?? defaultScannerEnv();
    this.logger = options.logger ?? defaultLogger;
    this.hiddenSkills = options.hiddenSkills ?? EMPTY_HIDDEN_SKILL_SETS;
    if (!options.skillRecall) {
      throw new Error(
        'LocalSkillRegistry: skillRecall is required. ' +
          'Hosts inject RecallIndex; tests use createLexicalSkillRecall().',
      );
    }
    this.recall = options.skillRecall;
    this.hasSharedBuiltins = !!this.env.sharedBuiltinRoot;
  }

  /**
   * 启动期全扫。返回 promise；调用方 `await registry.ready()` 拿到第一次完成信号。
   *
   * 多次调用返回同一个 promise（幂等）——Wave B `ElectronAgentHost` 在首轮
   * `beforeIteration` 之前 await 它（PRD §5.2 M1 要点 ④）。
   */
  ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.initialScan();
    }
    return this.readyPromise;
  }

  private async initialScan(): Promise<void> {
    this.roots = await computeScanRoots(this.env);
    const candidates = await scanAll(this.roots, (msg) =>
      this.handleWarn(msg),
    );
    const now = Date.now();

    for (const c of candidates) {
      this.tryIngest(c, now);
    }

    this.firstScanDone = true;
    this.logger.info(
      `index ready: ${this.byKey.size} skills from ${this.roots.length} roots`,
    );
    this.emit({
      canonicalKeys: Array.from(this.byKey.values()).map((skill) => skill.canonicalKey),
      reason: 'scan-complete',
    });
  }

  private countSharedBuiltinSkills(): number {
    let count = 0;
    for (const skill of this.byKey.values()) {
      if (skill.scope !== 'shared') continue;
      if (
        skill.canonicalKey.startsWith('platform:')
        || skill.canonicalKey.startsWith('app:')
      ) {
        count++;
      }
    }
    return count;
  }

  /**
   * 启动期共享内置 catalog 完整性门闩。
   *
   * 真实故障形态：shared store 磁盘上已有完整内置包，但首次 `scanAll` 偶尔只把
   * 早期 4 个目录入库；随后 watcher 对同 root 做一次全量 refresh 又能恢复 30 个。
   * 因此 `ready()` 之后、host 对外放行 `skill:list` 之前，需要用本方法确认共享
   * catalog 数量至少达到本轮收集到的内置 source 数。若不足，同步重扫 shared root
   * 几次；仍不足则抛错，让调用方保持「不可用」而不是发布半截 catalog。
   */
  async ensureSharedBuiltinCatalogReady(options: {
    expectedCount: number;
    rootPath?: string;
    attempts?: number;
    delayMs?: number;
  }): Promise<number> {
    const expectedCount = Math.max(0, Math.floor(options.expectedCount));
    if (!this.hasSharedBuiltins || expectedCount === 0) {
      return this.countSharedBuiltinSkills();
    }

    const root = this.roots.find((candidate) =>
      candidate.kind === 'builtin/shared'
      && (!options.rootPath || candidate.path === options.rootPath),
    );
    if (!root) {
      throw new Error('shared builtin scan root is not registered');
    }

    const attempts = Math.max(
      1,
      Math.floor(options.attempts ?? DEFAULT_SHARED_BUILTIN_READY_ATTEMPTS),
    );
    const delayMs = options.delayMs ?? DEFAULT_SHARED_BUILTIN_READY_DELAY_MS;
    let count = this.countSharedBuiltinSkills();

    for (let attempt = 1; count < expectedCount && attempt <= attempts; attempt++) {
      this.logger.warn(
        `shared builtin catalog incomplete (${count}/${expectedCount}); `
        + `refreshing shared root (${attempt}/${attempts})`,
      );
      await this.refreshSlug(root, root.path);
      count = this.countSharedBuiltinSkills();
      if (count >= expectedCount) break;
      if (attempt < attempts) await delay(delayMs);
    }

    if (count < expectedCount) {
      throw new Error(
        `shared builtin catalog incomplete after refresh (${count}/${expectedCount})`,
      );
    }
    return count;
  }

  /**
   * Scanner/parser 通过 `onWarn` 回灌警告。
   *
   * 策略：
   * - 日志层面照常 `logger.warn`（方便运维/控制台观察）
   * - 如果警告涉及某个文件路径解析失败，还把它存进 `parseFailures` 通道
   *   并发通知订阅者——面板后续可以基于这个列表打 red 标
   */
  private handleWarn(msg: string): void {
    this.logger.warn(msg);
    // 尝试提取 "<docPath>: <原因>" 前缀作为失败标识。
    // parser / scanner 的 warn 约定都是 `${docPath}: 原因`（见 skill-doc-parser.ts），
    // 其中 `docPath` 必然以 `SKILL.md` 结尾，但**路径分隔符跨平台**：
    //   - POSIX：`/Users/me/.../<space-sandbox>/skills/foo/SKILL.md`
    //   - Windows：`C:\Users\me\...\<space-sandbox>\skills\foo\SKILL.md`
    //     （或 `C:/Users/...`——Node 在 Win 上两种风格都会出现）
    //
    // 先宽松捕获 "以 SKILL.md 结尾的段 + : + 原因"，再校验前缀是绝对路径
    // （POSIX `/` 或 Windows `X:\` / `X:/`）——只有绝对路径才进 parseFailures，
    // 避免把 `目录无权限，已跳过：${root.path}（...）` 这类非 docPath warn 误收。
    const m = /^(.*?SKILL\.md):\s*(.+)$/.exec(msg);
    if (!m) return;
    const [, docPath, reason] = m;
    const isPosixAbs = docPath.startsWith('/');
    const isWinAbs = /^[A-Za-z]:[\\/]/.test(docPath);
    if (!isPosixAbs && !isWinAbs) return;
    // 跨平台 dirName 解析：按 `/` 或 `\` 都切一下，取倒数第二段（SKILL.md 父目录名）。
    const segments = docPath.split(/[\\/]/).filter(Boolean);
    const dirName = segments.length >= 2 ? segments[segments.length - 2] : '';
    const failure: SkillParseFailure = {
      docPath,
      dirName,
      reason,
      at: Date.now(),
    };
    this.parseFailures.set(docPath, failure);
    this.emitFailures();
  }

  private emitFailures(): void {
    const snap = Array.from(this.parseFailures.values());
    for (const l of this.failureListeners) {
      try {
        l(snap);
      } catch (err) {
        this.logger.warn(`parse failure listener 抛错：${(err as Error).message}`);
      }
    }
  }

  /**
   * 订阅解析失败列表（面板 red 标用）。listener 收到完整快照列表，不是 diff。
   */
  subscribeParseFailures(
    listener: (failures: SkillParseFailure[]) => void,
  ): () => void {
    this.failureListeners.add(listener);
    // 初次订阅立即回传当前快照，避免订阅时序竞态
    try {
      listener(Array.from(this.parseFailures.values()));
    } catch (err) {
      this.logger.warn(`parse failure listener 初次回调抛错：${(err as Error).message}`);
    }
    return () => this.failureListeners.delete(listener);
  }

  /** 查询当前累积的解析失败快照 */
  listParseFailures(): SkillParseFailure[] {
    return Array.from(this.parseFailures.values());
  }

  /**
   * 尝试入库；跨根同物理文件只保留第一个（PRD §5.2 M1 realpath 去重）。
   *
   * 返回 true 表示入库；false 表示因 realpath 冲突被丢弃（但不算失败）。
   */
  private tryIngest(candidate: ParsedSkillCandidate, now: number): boolean {
    const skill = toLocalSkill(candidate, now);

    // 去重复用：启用共享store后，忽略 Space 目录里历史遗留的 per-space 内置副本
    // （legacy scope=space，或  扫描把 legacy 根标成 organization 但仍带 spaceId）
    // ——共享store已全局提供该 skill。
    if (
      this.hasSharedBuiltins
      && (skill.scope === 'space' || (skill.scope === 'organization' && !!skill.spaceId))
      && (skill.canonicalKey.startsWith('platform:') || skill.canonicalKey.startsWith('app:'))
    ) {
      return false;
    }

    const registryKey = registryKeyForSkill(skill);

    const existing = this.byRealpath.get(skill.realpath);
    if (existing && existing !== registryKey) {
      // 同一物理文件已从另一源扫进来，跳过
      this.logger.warn(
        `realpath 去重：${skill.canonicalKey} 指向 ${skill.realpath}，已被 ${existing} 占用`,
      );
      return false;
    }

    // registryKey 冲突（同一 Space/来源下两个不同物理文件产生同样 key）——保留先入库的并 warn（L17/L21）
    if (this.byKey.has(registryKey) && !existing) {
      this.logger.warn(
        `canonical key 冲突：${skill.canonicalKey} 重复，保留先扫到的`,
      );
      return false;
    }

    this.byKey.set(registryKey, skill);
    this.byRealpath.set(skill.realpath, registryKey);
    return true;
  }

  /**
   * 查询单个 skill 的完整内容（skills_read 消费方）。
   */
  getByKey(canonicalKey: string, options?: { spaceId?: string }): LocalSkill | undefined {
    const exact = this.byKey.get(canonicalKey);
    if (exact && skillMatchesLookup(exact, canonicalKey, options)) return exact;
    for (const skill of this.byKey.values()) {
      if (skillMatchesLookup(skill, canonicalKey, options)) return skill;
    }
    return undefined;
  }

  /**
   * 列出某个 skill 的 Tier-3 附属资源（references/ + examples/ 下的文件）。
   *
   * 消费方：`skills_read` / `skill_invoke` 工具（经宿主注入回调）把清单附到返回，
   * 让 Agent 知道有哪些分层文档、可用 `skills_read` 传 `path` 读取。找不到 skill
   * 或目录不存在时返回空数组（不报错——「没有 references」是合法常态）。
   */
  async listResources(
    canonicalKey: string,
    options?: { spaceId?: string },
  ): Promise<SkillResourceEntry[]> {
    const skill = this.getByKey(canonicalKey, options);
    return skill ? this.listResourcesForSkill(skill) : [];
  }

  /** 按 Run 快照中的 Skill 记录读取资源清单，不再回查可变 Registry。 */
  async listResourcesForSkill(skill: LocalSkill): Promise<SkillResourceEntry[]> {
    if (!skill.docPath) return [];
    const skillDir = dirname(skill.docPath);
    const out: SkillResourceEntry[] = [];
    for (const sub of SKILL_RESOURCE_DIRS) {
      await this.collectResourceFiles(join(skillDir, sub), skillDir, out);
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  private async collectResourceFiles(
    dir: string,
    skillDir: string,
    out: SkillResourceEntry[],
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在 → 该 skill 没有这类资源，跳过
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        await this.collectResourceFiles(full, skillDir, out);
        continue;
      }
      if (!ent.isFile()) continue;
      const rel = relative(skillDir, full).split(sep).join('/');
      let summary: string | undefined;
      if (/\.(md|markdown|txt)$/i.test(ent.name)) {
        try {
          summary = extractResourceSummary(await readFile(full, 'utf-8'));
        } catch {
          summary = undefined;
        }
      }
      out.push(summary ? { path: rel, summary } : { path: rel });
    }
  }

  /**
   * 读取某个 skill 的单个附属资源文件（references/ 或 examples/ 内）。
   *
   * 路径边界：`relPath` 解析后必须落在该 skill 目录内（防 `..` 穿越到别的 skill /
   * platform-data 其它子树）；拒绝 SKILL.md（用无 path 的 `skills_read` 读）与隐藏
   * 文件。失败返回带中文原因的 `{ ok:false }`，工具层转成 tool result 错误。
   */
  async readResource(
    canonicalKey: string,
    relPath: string,
    options?: { spaceId?: string },
  ): Promise<SkillResourceReadResult> {
    const skill = this.getByKey(canonicalKey, options);
    if (!skill) {
      return {
        ok: false,
        error: `未找到技能 \`${canonicalKey}\`，无法读取附属文件。`,
        hint: '先用 skills_search 确认 key，或用 skills_read（不传 path）读 SKILL.md。',
      };
    }
    return this.readResourceForSkill(skill, relPath);
  }

  /** 按 Run 快照中的 Skill 记录读取附属正文，不再回查可变 Registry。 */
  async readResourceForSkill(
    skill: LocalSkill,
    relPath: string,
  ): Promise<SkillResourceReadResult> {
    if (!skill.docPath) {
      return {
        ok: false,
        error: `技能 \`${skill.canonicalKey}\` 没有可读取的本地正文。`,
        hint: '请确认该技能已完整安装并重新开始一次 Agent Run。',
      };
    }
    const skillDir = dirname(skill.docPath);
    const cleaned = String(relPath ?? '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/^\/+/, '')
      .trim();
    if (!cleaned) {
      return {
        ok: false,
        error: '缺少 path 参数。',
        hint: '传入相对 skill 目录的路径，如 references/cli-reference.md。',
      };
    }
    const target = resolve(skillDir, cleaned);
    const rel = relative(skillDir, target);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      return {
        ok: false,
        error: `路径越界：${cleaned} 不在该 skill 目录内。`,
        hint: '只能读取该 skill 目录下的 references / examples 文件。',
      };
    }
    const base = basename(target);
    if (base === 'SKILL.md') {
      return {
        ok: false,
        error: 'SKILL.md 请用 skills_read（不传 path）读取。',
      };
    }
    if (base.startsWith('.')) {
      return { ok: false, error: '不允许读取隐藏文件。' };
    }
    try {
      const content = await readFile(target, 'utf-8');
      return { ok: true, path: rel.split(sep).join('/'), content };
    } catch {
      return {
        ok: false,
        error: `附属文件不存在或无法读取：${cleaned}`,
        hint: '先用 skills_read（不传 path）查看可用的 references / examples 清单。',
      };
    }
  }

  /**
   * 列出所有 skill（面板消费方）。返回浅拷贝 —— 调用方不要直接 mutate。
   */
  listAll(): LocalSkill[] {
    return Array.from(this.byKey.values()).filter(
      (s) => !isTemporarilyHiddenSkill(s, this.hiddenSkills),
    );
  }

  /**
   * 列出当前上下文可见的 skill：
   * - legacy space 根：匹配 `spaceId`
   * -  个人 / 组织根：`scope=user` 全局可见；`scope=organization` 按 organizationId 过滤
   * - interop / shared：始终可见
   */
  listForSpace(
    spaceId: string,
    options?: { organizationId?: string },
  ): LocalSkill[] {
    return Array.from(this.byKey.values()).filter((s) => {
      if (isTemporarilyHiddenSkill(s, this.hiddenSkills)) return false;
      if (s.scope === 'interop' || s.scope === 'shared') return true;
      //  个人根（无 spaceId）：跨 Space 可见
      if (s.scope === 'user' && !s.spaceId) return true;
      //  组织根（新布局，无 spaceId）：按 organizationId 过滤
      if (s.scope === 'organization' && !s.spaceId) {
        return (
          !options?.organizationId || s.organizationId === options.organizationId
        );
      }
      // legacy：带 spaceId 的根仍按 Space 隔离
      return s.spaceId === spaceId;
    });
  }

  /**
   * 本地 fulltext substring 搜索。
   *
   * Wave 6: 可选 spaceId 参数限制搜索范围（只返回该 Space + interop 的 skill）。
   */
  search(
    query: string,
    options?: { limit?: number; spaceId?: string; organizationId?: string },
  ): LocalSkill[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const limit = options?.limit ?? 20;
    const filterSpaceId = options?.spaceId;
    const filterOrganizationId = options?.organizationId;

    const hits: LocalSkill[] = [];
    for (const skill of this.byKey.values()) {
      if (isTemporarilyHiddenSkill(skill, this.hiddenSkills)) continue;
      if (filterSpaceId || filterOrganizationId) {
        const visible =
          skill.scope === 'interop'
          || skill.scope === 'shared'
          || (skill.scope === 'user' && !skill.spaceId)
          || (skill.scope === 'organization'
            && !skill.spaceId
            && (!filterOrganizationId || skill.organizationId === filterOrganizationId))
          || (!!filterSpaceId && skill.spaceId === filterSpaceId);
        if (!visible) continue;
      }
      const haystack = [
        skill.canonicalKey,
        skill.slug,
        skill.name,
        skill.displayName ?? '',
        skill.description,
        skill.whenToUse ?? '',
      ]
        .join('\n')
        .toLowerCase();
      if (haystack.includes(q)) {
        hits.push(skill);
        if (hits.length >= limit * 2) break;
      }
    }
    hits.sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey));
    return hits.slice(0, limit);
  }

  /**
   * 渲染两区 skill 内容供 fetchSkills 使用（不含 XML tag）：
   * - staticIndex：全部 skill 名称索引（稳定 → system 静态段可缓存）
   * - dynamicTopK：与 ctx.query 最相关的 Top-N 带描述（每轮变 → system 动态段）
   *
   * Wave 6: 如果 ctx.spaceId 有值，只渲染该 Space 的 skill（含 interop）。
   */
  async render(ctx: SkillsRenderContext): Promise<SkillsTwoZoneResult> {
    const baseSkills = ctx.spaceId
      ? this.listForSpace(ctx.spaceId)
      : this.listAll();
    const merged = mergeSkillListsForRuntime(baseSkills, ctx.personalPluginSkills ?? []);
    // 封闭携带集：仅 enabled===true 在进静态名录与动态 TopK 前统一过滤。
    // 先合并工作区目录 Skill，再统一走 enablement：
    // workspace 与其它来源一致，只对 enabledMap 中显式携带的 Agent 可用。
    const withWorkspace = mergeWorkspaceSkillsForRuntime(
      merged,
      ctx.workspaceSkills ?? [],
      (msg) => this.logger.warn(msg),
    ).skills;
    const enabledSkills = filterSkillsByEnablement(
      withWorkspace,
      ctx.enabledMap,
    );
    return this.renderAvailableSkills(enabledSkills, ctx);
  }

  /**
   * 渲染 Host Store 已冻结并判定可用的 Run Skill 列表。
   * 调用方负责 availability 合并，本方法只负责排序与两区文本生成。
   */
  async renderAvailableSkills(
    availableSkills: readonly LocalSkill[],
    ctx: Pick<
      SkillsRenderContext,
      'query' | 'focusedApp' | 'budgetChars' | 'filterSkills' | 'enabledMap'
    >,
  ): Promise<SkillsTwoZoneResult> {
    const skills = ctx.filterSkills
      ? availableSkills.filter(ctx.filterSkills)
      : [...availableSkills];
    const query = ctx.query?.trim();
    return {
      staticIndex: renderSkillNames(skills, ctx),
      dynamicTopK: query
        ? await renderRelevantTopK(skills, query, ctx.budgetChars ?? DEFAULT_BUDGET_CHARS, {
            focusedApp: ctx.focusedApp,
            recall: this.recall,
          })
        : null,
    };
  }

  /**
   * 订阅变更事件（面板 invalidate / agent-runtime 可选重渲染）。
   *
   * 返回 unsubscribe 函数。Wave A 完成时这个 API 尚未被 renderer 消费——渲染器 IPC
   * 转发（M9）是后续 Wave 的事。本 Wave 的职责只是"事件真的发出来了"。
   */
  subscribeChanges(listener: SkillsChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SkillsChangedEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        this.logger.warn(
          `skills listener 抛错：${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * 获取当前扫描根列表（M2 watcher 用来监听）。
   */
  getScanRoots(): readonly ScanRoot[] {
    return this.roots;
  }

  /**
   * Wave 6: 动态添加一个新的扫描根（新 Space 预装完成后调用）。
   * 扫描该根并将结果入库，然后通知 watcher。
   */
  async addScanRoot(root: ScanRoot): Promise<void> {
    const existing = this.roots.find((r) => r.path === root.path);
    if (existing) return;

    this.roots.push(root);

    const candidates = await scanRoot(root, (msg) => this.handleWarn(msg));
    const now = Date.now();
    const addedKeys: string[] = [];
    for (const c of candidates) {
      const skill = toLocalSkill(c, now);
      if (this.tryIngest(c, now)) {
        addedKeys.push(skill.canonicalKey);
      }
    }
    if (addedKeys.length > 0) {
      this.emit({ canonicalKeys: addedKeys, reason: 'add' });
    }
  }

  /**
   * watcher 回灌：某个根目录下发生变化。
   *
   * 实现细节（Review P0 修正）：
   * - **按 root 串行化**：同一 root 的多次 refresh 调用排队执行，避免 Map 竞态
   *   （`flushNow` 内也按 root 去重，这里再加一道保险）
   * - **正确清理 byRealpath**：skill 的 realpath 若发生变化（例如被软链替换），
   *   必须先 delete 旧 realpath 项，否则 realpath → canonicalKey 反查会错乱
   * - **按 diff 发 add / change / remove 三种事件**，让面板能区分场景
   *
   * 参数 `slugDir` 目前不使用（每次都重扫整 root）——保留签名供未来细粒度优化。
   */
  refreshSlug(root: ScanRoot, slugDir: string): Promise<void> {
    const prev = this.refreshQueues.get(root.path) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => this.doRefreshRoot(root));
    this.refreshQueues.set(root.path, next);
    void slugDir;
    return next;
  }

  private async doRefreshRoot(root: ScanRoot): Promise<void> {
    const candidates = await scanRoot(root, (msg) => this.handleWarn(msg));
    const now = Date.now();

    const addedKeys: string[] = [];
    const changedKeys: string[] = [];
    const removedKeys: string[] = [];

    // 原索引里属于这个 root 的 key
    const keysForRoot = this.collectKeysForRoot(root);

    const seenKeys = new Set<string>();
    for (const c of candidates) {
      const skill = toLocalSkill(c, now);
      const registryKey = registryKeyForSkill(skill);
      seenKeys.add(registryKey);

      const change = this.applyRefreshCandidate(registryKey, skill);
      if (change === 'add') addedKeys.push(skill.canonicalKey);
      if (change === 'change') changedKeys.push(skill.canonicalKey);
    }

    // root 下消失的 key（被 unlink 或 frontmatter 坏了变成解析失败）
    removedKeys.push(...this.removeMissingRootKeys(keysForRoot, seenKeys));

    this.emitRefreshEvents(addedKeys, changedKeys, removedKeys);
  }

  private collectKeysForRoot(root: ScanRoot): Set<string> {
    const keysForRoot = new Set<string>();
    for (const [key, skill] of this.byKey.entries()) {
      if (skillBelongsToRoot(skill, root)) keysForRoot.add(key);
    }
    return keysForRoot;
  }

  private applyRefreshCandidate(
    registryKey: string,
    skill: LocalSkill,
  ): 'add' | 'change' | null {
    const existing = this.byKey.get(registryKey);
    if (!existing) {
      return this.addRefreshCandidate(registryKey, skill);
    }
    if (!skillContentChanged(existing, skill)) return null;
    // realpath 变了必须清旧项，避免反查表泄漏
    if (existing.realpath !== skill.realpath) {
      this.byRealpath.delete(existing.realpath);
    }
    this.byKey.set(registryKey, skill);
    this.byRealpath.set(skill.realpath, registryKey);
    return 'change';
  }

  private addRefreshCandidate(registryKey: string, skill: LocalSkill): 'add' | null {
    // 新增 —— 但要排查 realpath 冲突（另一 source 同物理文件已入库）
    const realpathOwner = this.byRealpath.get(skill.realpath);
    if (realpathOwner && realpathOwner !== registryKey) {
      this.logger.warn(
        `realpath 冲突跳过：${skill.canonicalKey} 的 realpath ${skill.realpath} 已被 ${realpathOwner} 占用`,
      );
      return null;
    }
    this.byKey.set(registryKey, skill);
    this.byRealpath.set(skill.realpath, registryKey);
    return 'add';
  }

  private removeMissingRootKeys(keysForRoot: Set<string>, seenKeys: Set<string>): string[] {
    const removedKeys: string[] = [];
    for (const key of keysForRoot) {
      if (seenKeys.has(key)) continue;
      const prevSkill = this.byKey.get(key);
      this.byKey.delete(key);
      if (prevSkill) this.byRealpath.delete(prevSkill.realpath);
      removedKeys.push(key);
    }
    return removedKeys;
  }

  private emitRefreshEvents(
    addedKeys: string[],
    changedKeys: string[],
    removedKeys: string[],
  ): void {
    if (addedKeys.length) {
      this.emit({ canonicalKeys: addedKeys, reason: 'add' });
    }
    if (changedKeys.length) {
      this.emit({ canonicalKeys: changedKeys, reason: 'change' });
    }
    if (removedKeys.length) {
      this.emit({ canonicalKeys: removedKeys, reason: 'remove' });
    }
  }

  /**
   * 诊断用：是否已完成首次扫描。测试/健康检查读取。
   */
  get isReady(): boolean {
    return this.firstScanDone;
  }
}
