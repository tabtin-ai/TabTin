/**
 * createHttpSkillsFetcher — 基于 Django Skills HTTP API 的 SkillsFetcher 实现
 *
 * **历史背景（W2.3）**：本 fetcher 工厂最初定义在
 * `packages/agent-runtime/src/middleware/skills-fetcher-http.ts`，与
 * 7 件 middleware 工厂耦合在 `middleware/` 目录。W2.3 删 middleware 整
 * 目录时把它搬到 `skills/` 子模块成为 SSoT —— 这是 Skills 系统的工具
 * 函数（与 `skill-budget.ts` / `skill-listing-types.ts` 同级），不是
 * middleware。函数名 `createHttpSkillsFetcher` 不在副北极星 1 grep
 * 模式里（grep 只针对老 7 件工厂名），保留原名给 legacy / non-local host
 * 和兼容测试继续使用。
 *
 * Electron / Daemon 本地 runtime 宿主现在直接使用 `LocalSkillRegistry`，
 * 不再把 Django `/skills/index` 作为 prompt fallback。
 *
 * **下游消费方**：
 *   - legacy / non-local hosts that still need Django-owned Skills listing
 *   - agent-runtime compatibility tests for the HTTP fetcher contract
 *
 * Django 端对应 API（ 后签名）：
 *   GET /api/skills/index?organization_id={organizationId}&agent_id={agentId}
 *   返回：{ data: { skills: [{ skill_id, name, description, source, ... }] } }
 *
 * 内置缓存策略：
 *   - 同一 (organizationId, agentId) 缓存 60 秒（避免每轮 LLM iteration 都打网络）
 *   - 失败时返回 null（让消费方 silently skip 注入），不抛错
 *   - ：Skill HTTP 已从 space_id 硬切到 (organization_id, agent_id)。
 */

import type {
  SkillsFetcher,
  SkillsFetchContext,
  SkillListingResult,
  SkillMeta,
} from './skill-listing-types.js';
import { joinApiPath } from '../utils/api-url.js';

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  content: SkillListingResult | null;
  timestamp: number;
}

interface SkillIndexItem {
  skill_id?: string;
  skill_key?: string;
  name?: string;
  description?: string;
  source?: string;
  tags?: string[];
  trigger?: string;
  emoji?: string;
}

interface SkillsIndexResponse {
  data?: {
    skills?: SkillIndexItem[];
  };
  // i18n response wrapper 可能直接展开
  skills?: SkillIndexItem[];
}

async function fetchSkillListingForContext(args: {
  apiBaseUrl: string;
  getToken: () => Promise<string | null | undefined>;
  onLog?: (level: 'warn' | 'debug', message: string) => void;
  fetchImpl: typeof fetch;
  organizationId: string;
  agentId?: string;
}): Promise<{ content: SkillListingResult | null; isError: boolean }> {
  const { apiBaseUrl, getToken, onLog, fetchImpl, organizationId, agentId } = args;
  try {
    const token = await getToken();
    if (!token) {
      return { content: null, isError: true };
    }

    const params = new URLSearchParams();
    params.set('organization_id', organizationId);
    if (agentId) {
      params.set('agent_id', agentId);
    }
    const url = joinApiPath(apiBaseUrl, `/skills/index?${params.toString()}`);
    const resp = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (!resp.ok) {
      onLog?.(
        'warn',
        `[SkillsFetcher] HTTP ${resp.status} for organization=${organizationId} agent=${agentId ?? ''} (not cached)`,
      );
      return { content: null, isError: true };
    }

    const json = (await resp.json()) as SkillsIndexResponse;
    const skills = json?.data?.skills ?? json?.skills ?? [];
    return { content: buildSkillListingResult(skills), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onLog?.(
      'warn',
      `[SkillsFetcher] fetch failed for organization=${organizationId} agent=${agentId ?? ''}: ${msg} (not cached)`,
    );
    return { content: null, isError: true };
  }
}

export interface HttpSkillsFetcherOptions {
  /** Django API base URL（不含 trailing slash），如 `https://api.example.com/api`。 */
  apiBaseUrl: string;
  /** 异步获取 Bearer token（每次调用都重新拉以应对 token 刷新）。 */
  getToken: () => Promise<string | null | undefined>;
  /**
   * 可选 logger。错误以 warn 级别上报；空时静默。
   * 复用 packages/agent-runtime 既有 host log 风格，不引 createLogger。
   */
  onLog?: (level: 'warn' | 'debug', message: string) => void;
  /** 缓存 TTL，默认 60_000（60s）。0 表示不缓存。 */
  cacheTtlMs?: number;
  /** 自定义 fetch 实现（测试用）。默认 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
  /**
   * 宿主创建期固定的 organizationId / agentId。
   *
   * `SkillsFetchContext` 不再携带业务 id——组织与 Agent 归属是 per-runtime
   * 常量，由 host 装配期烘进闭包，runtime 在这些 id 变化时重建。
   *
   * `defaultSpaceId` 仅作历史兼容（旧宿主装配代码可能还在传），本 fetcher
   * 不再使用它做过滤或 URL 拼接；后续宿主应彻底移除该字段。
   */
  defaultOrganizationId?: string;
  defaultAgentId?: string;
  /** 已废弃：仅为不破坏老宿主装配调用点保留；本 fetcher 不再读取。 */
  defaultSpaceId?: string;
}

/**
 * 创建一个基于 Django Skills HTTP API 的 fetcher。
 *
 * 返回的 SkillsFetcher 在 organizationId 缺失时返回 null（不注入），与 Django
 * `/skills/index` 强要求 organization_id 的语义一致。
 */
export function createHttpSkillsFetcher(options: HttpSkillsFetcherOptions): SkillsFetcher {
  const { apiBaseUrl, getToken, onLog, defaultOrganizationId, defaultAgentId } = options;
  const cacheTtl = options.cacheTtlMs ?? CACHE_TTL_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const cache = new Map<string, CacheEntry>();

  return async (_context: SkillsFetchContext): Promise<SkillListingResult | null> => {
    // ：Skill HTTP 的租户键从 space_id 换到 (organization_id, agent_id)；
    // 二者由 host 装配期烘进闭包（runtime 在其变化时重建，closure capture 安全）。
    const organizationId = defaultOrganizationId;
    const agentId = defaultAgentId;
    if (!organizationId) return null;

    const cacheKey = `${organizationId}|${agentId ?? ''}`;
    const cached = cache.get(cacheKey);
    if (cached && cacheTtl > 0 && Date.now() - cached.timestamp < cacheTtl) {
      return cached.content;
    }

    const { content, isError } = await fetchSkillListingForContext({
      apiBaseUrl,
      getToken,
      onLog,
      fetchImpl,
      organizationId,
      agentId,
    });

    if (cacheTtl > 0 && !isError) {
      cache.set(cacheKey, { content, timestamp: Date.now() });
    }
    return content;
  };
}

/**
 * 把 Django skill index 响应转为 SkillListingResult。
 * 返回 null 表示空列表。
 */
function buildSkillListingResult(skills: SkillIndexItem[]): SkillListingResult | null {
  if (!Array.isArray(skills) || skills.length === 0) return null;

  const metas: SkillMeta[] = [];
  const lines: string[] = [];
  lines.push(
    `你有 ${skills.length} 个可用技能。用 \`skills_read\` 查看其完整内容。`,
  );
  lines.push('');

  for (const skill of skills) {
    const key = skill.skill_key ?? skill.skill_id;
    if (!key) continue;
    const desc = (skill.description ?? '').trim();
    const source = skill.source ?? 'unknown';
    const truncated = desc.length > 200 ? `${desc.slice(0, 197)}...` : desc;
    lines.push(`- \`${key}\` (${source})${truncated ? `: ${truncated}` : ''}`);

    metas.push({
      canonicalKey: key,
      name: skill.name ?? key,
      description: desc,
      source,
    });
  }

  if (metas.length === 0) return null;

  return {
    formattedContent: lines.join('\n'),
    skills: metas,
  };
}
