import type {
  CapabilityResult,
  ExecutionContext,
  SpecificationVersion,
} from '../types.js';
import { createProvenance } from '../infra/helpers.js';

export const specificationVersion: SpecificationVersion = 'v1';

export interface SearchSoundsInput {
  query: string;
  page?: number;
  pageSize?: number;
}

export interface SearchSoundsData {
  results: Array<{
    id: string;
    name: string;
    previewUrl: string;
    duration?: number;
    tags?: string[];
  }>;
  count: number;
}

/** @internal */
function assertDjangoSuccess(raw: unknown): void {
  if (raw && typeof raw === 'object' && 'success' in raw && (raw as { success?: boolean }).success === false) {
    const rec = raw as Record<string, unknown>;
    const msg = typeof rec.message === 'string' ? rec.message : '音效搜索请求失败';
    throw new Error(msg);
  }
}

/** @internal */
function unwrapDjangoData<T extends Record<string, unknown>>(raw: unknown): T {
  assertDjangoSuccess(raw);
  if (
    raw &&
    typeof raw === 'object' &&
    'success' in raw &&
    (raw as { success?: boolean }).success === true &&
    'data' in raw
  ) {
    const inner = (raw as { data: unknown }).data;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return inner as T;
    }
  }
  return raw as T;
}

/** @internal 将单条 Django 记录规范化为 SearchSoundsData.results 元素 */
function normalizeSoundItem(raw: unknown): SearchSoundsData['results'][number] | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = o.id ?? o.sound_id;
  const name = o.name ?? o.title;
  const previewRaw = o.preview_url ?? o.previewUrl ?? o.url;
  if (id === undefined || id === null || typeof name !== 'string' || typeof previewRaw !== 'string') {
    return null;
  }
  const item: SearchSoundsData['results'][number] = {
    id: String(id),
    name,
    previewUrl: previewRaw,
  };
  if (typeof o.duration === 'number' && Number.isFinite(o.duration)) {
    item.duration = o.duration;
  } else if (typeof o.duration_sec === 'number' && Number.isFinite(o.duration_sec)) {
    item.duration = o.duration_sec;
  }
  if (Array.isArray(o.tags)) {
    item.tags = o.tags.filter((t): t is string => typeof t === 'string');
  }
  return item;
}

/**
 * 音效搜索（云端）。
 *
 * Cloud capability — `GET /api/services/sound_effects/search?...`
 *
 * @remarks
 * **路径待后端对齐**：Django 路由与列表字段名（`results` / `count` 等）需与后端实现一致后更新此处解析逻辑。
 */
export async function searchSounds(
  input: SearchSoundsInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<SearchSoundsData>> {
  const startTime = Date.now();

  const params = new URLSearchParams();
  params.set('query', input.query);
  if (input.page !== undefined) params.set('page', String(input.page));
  if (input.pageSize !== undefined) params.set('page_size', String(input.pageSize));

  const path = `/api/services/sound_effects/search?${params.toString()}`;
  const response = await ctx.djangoRequest<Record<string, unknown>>('GET', path);

  const payload = unwrapDjangoData<Record<string, unknown>>(response.data);
  const rawList = payload.results ?? payload.items ?? payload.sounds;
  const list = Array.isArray(rawList) ? rawList : [];
  const results: SearchSoundsData['results'] = [];
  for (const row of list) {
    const n = normalizeSoundItem(row);
    if (n) results.push(n);
  }

  const countRaw = payload.count ?? payload.total ?? results.length;
  const count = typeof countRaw === 'number' && Number.isFinite(countRaw) ? countRaw : results.length;

  return {
    data: { results, count },
    provenance: createProvenance('audio.sounds.search', { ...input }, startTime, {
      prompt: input.query,
    }),
    providerMetadata: {
      freesound: { query: input.query, count },
    },
  };
}
