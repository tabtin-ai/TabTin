import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(
  readFileSync(new URL('../../../manifest.json', import.meta.url), 'utf-8'),
) as { tools: Array<{ name: string; description?: string }> };

describe('action-tools manifest contract', () => {
  it('does not emit duplicate tool names', () => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();

    for (const tool of manifest.tools) {
      if (seen.has(tool.name)) duplicates.add(tool.name);
      seen.add(tool.name);
    }

    expect([...duplicates]).toEqual([]);
  });

  it('does not expose retired TabCode semantic search', () => {
    expect(manifest.tools.some(tool => tool.name === 'semantic_search')).toBe(false);
    expect((manifest as any).toolCapabilityMap?.semantic_search).toBeUndefined();
  });

  it('keeps manifest tool descriptions long enough for ToolHub', () => {
    const tooShort = manifest.tools
      .filter(tool => (tool.description ?? '').length < 30)
      .map(tool => `${tool.name}:${(tool.description ?? '').length}`);

    expect(tooShort).toEqual([]);
  });

  // 工具系统宪法 §不变量 2（W5 实施 2026-05-04）：业务能力一律走 `tabtin <command>`
  // CLI，不走 FC。tabweb / tabslide 域必须通过 manifestExposed=false 从 manifest
  // 中过滤掉（tool execute 仍由 ActionExecutor adapter 注册，CLI server 路由派发）。
  it('does not expose tabweb business FCs to LLM (use `tabtin browser` CLI instead)', () => {
    const tabwebTools = manifest.tools.filter(t => (t as { appId?: string }).appId === 'tabweb');
    expect(tabwebTools.map(t => t.name)).toEqual([]);
  });

  it('does not expose tabslide_* FCs to LLM (use `tabtin slide` CLI instead)', () => {
    const slideTools = manifest.tools.filter(t => t.name.startsWith('tabslide_'));
    expect(slideTools.map(t => t.name)).toEqual([]);
  });

  it('manifest stays trim after W5 (≤ 12 FC tools — core IO + terminal + skills)', () => {
    // 上限故意比当前数（10）略高，留 Skills 拓展空间。超过 12 几乎肯定意味着
    // 又有人偷偷加了业务 FC——CI 这条会拦下来，提醒走宪法决策树。
    expect(manifest.tools.length).toBeLessThanOrEqual(12);
  });

  // W5 收尾（2026-05-04，白名单模式）：manifestExposed 默认值已反转为 false，
  // 任何新 opt-in 的 appId 必须在下面白名单里出现。这条断言让"业务 FC 回潮"在
  // CI 阶段就被拦下：新增 domain 想暴露给 LLM？先在白名单里登记，强制评审。
  it('only known IO/execution domains are exposed to LLM (manifestExposed allowlist)', () => {
    const ALLOWED_APP_IDS = new Set(['tabcode', 'core']);
    const exposedAppIds = new Set(
      manifest.tools.map(t => (t as { appId?: string }).appId).filter(Boolean) as string[],
    );
    const unknown = [...exposedAppIds].filter(id => !ALLOWED_APP_IDS.has(id));
    expect(unknown).toEqual([]);
  });
});
