/**
 * McpCap 单测（，两区）。
 *
 * 覆盖：
 *   1. type / category 静态契约 + tools() 为空
 *   2. fetchMcp 缺省 → hooks() 返回 null
 *   3. 静态段 `<mcp_servers>`：server 全列 + 工具名（含多 server）
 *   4. 动态段 `<relevant_mcp>`：query 命中 → topK 带描述；静态段同时存在
 *   5. query 零重合 → 静态段仍列全部工具名，动态段 undefined
 *   6. 无挂载 server → 两段都 undefined
 *   7. fetchMcp 抛错 / 返回 null → 两段都 undefined（本轮不注入）
 *   8. 静态段预算：工具超限时 server 仍全列，工具名截断并附查询方法
 *   9. 动态段最多 8 条
 *
 * ：McpCap 已从 agent-runtime 迁到 @tabtin/agent-host，本单测随源迁来；
 * 对源的 import 指向 host 的 `src/capabilities/mcp.js`，契约类型走 @tabtin/agent-runtime 公共面。
 */

import { describe, expect, it } from 'vitest';
import { McpCap, type McpListing } from '../src/capabilities/mcp.js';
import {
  makeBeforeModelCtx,
  makeRunCtx,
  sectionContent,
} from './fixtures/fake-capabilities.js';
import type { EngineState } from '@tabtin/agent-runtime/engine';
import { SYSTEM_SECTION_NAMES } from '@tabtin/agent-runtime/engine';

function makeState(query?: string): EngineState {
  return {
    __spaceId: 'space-1',
    messages: query ? [{ role: 'user', content: query }] : [],
  } as EngineState;
}

async function runMcpBeforeRun(cap: McpCap, state: EngineState): Promise<void> {
  await cap.hooks()!.beforeRun!(makeRunCtx(state));
}

async function mcpStaticIndex(cap: McpCap, state: EngineState): Promise<string | undefined> {
  const hooks = cap.hooks()!;
  await hooks.beforeRun!(makeRunCtx(state));
  const ctx = makeBeforeModelCtx(state);
  await hooks.beforeModel!(ctx);
  return sectionContent(ctx.sections, SYSTEM_SECTION_NAMES.mcp_servers);
}

const GITHUB_LISTING: McpListing = {
  servers: [
    { serverName: 'github', sourceLabel: 'Cursor' },
    { serverName: 'playwright', sourceLabel: 'Claude Desktop' },
  ],
  tools: [
    { serverName: 'github', name: 'create_issue', description: 'Create a new issue in a repository' },
    { serverName: 'github', name: 'list_pull_requests', description: 'List pull requests' },
    { serverName: 'playwright', name: 'browser_navigate', description: 'Navigate the browser to a URL' },
  ],
};

describe('McpCap 静态契约', () => {
  it('type === "mcp" / category === "core"，tools() 为空', () => {
    const cap = new McpCap();
    expect(cap.type).toBe('mcp');
    expect(cap.category).toBe('core');
    expect(cap.tools()).toEqual([]);
  });

  it('fetchMcp 缺省时 hooks() 返回 null', () => {
    expect(new McpCap().hooks()).toBeNull();
  });
});

describe('McpCap 静态段 <mcp_servers>', () => {
  it('server 全列 + 工具名（query 无关也出）', async () => {
    const cap = new McpCap({ fetchMcp: async () => GITHUB_LISTING });
    const state = makeState('今天天气怎么样'); // 与工具零重合
    const idx = (await mcpStaticIndex(cap, state))!;

    expect(idx).toContain('<mcp_servers>');
    expect(idx).toContain('</mcp_servers>');
    // server 全列
    expect(idx).toContain('github（来自 Cursor）');
    expect(idx).toContain('playwright（来自 Claude Desktop）');
    // 工具名（静态段列名字，不带描述）
    expect(idx).toContain('create_issue')
    expect(idx).toContain('browser_navigate')

    // query 零重合 → 动态段不出
    expect(cap.getRelevantBlock()).toBeUndefined();
  });

  it('无挂载 server → 静态 + 动态都 undefined', async () => {
    const cap = new McpCap({ fetchMcp: async () => ({ servers: [], tools: [] }) });
    const state = makeState('随便问点啥');
    const hooks = cap.hooks()!;
    await hooks.beforeRun!(makeRunCtx(state));
    const ctx = makeBeforeModelCtx(state);
    await hooks.beforeModel!(ctx);
    expect(sectionContent(ctx.sections, SYSTEM_SECTION_NAMES.mcp_servers)).toBeUndefined();
    expect(cap.getRelevantBlock()).toBeUndefined();
  });

  it('预算超限：server 仍全列，工具名截断并附查询方法', async () => {
    const manyTools = Array.from({ length: 100 }, (_, i) => ({
      serverName: 'big',
      name: `very_long_tool_name_number_${i}`,
      description: 'x',
    }));
    const cap = new McpCap({
      // 给极小预算逼出截断
      fetchMcp: async () => ({ servers: [{ serverName: 'big' }], tools: manyTools }),
      contextWindowTokens: 1_000, // → 预算 max(2000, 40)=2000 chars，仍会截断 100 个长名
    });
    const state = makeState('无关');
    const idx = (await mcpStaticIndex(cap, state))!;
    expect(idx).toContain('- big:'); // server 出现
    expect(idx).toMatch(/\+\d+ 个，用 tabtin mcp list-tools --server-name big 看全/);
  });
});

describe('McpCap 动态段 <relevant_mcp>', () => {
  it('query 命中 → topK 带描述；静态段同时存在', async () => {
    const cap = new McpCap({ fetchMcp: async () => GITHUB_LISTING });
    const state = makeState('帮我在仓库里提个 issue');
    const hooks = cap.hooks()!;
    await hooks.beforeRun!(makeRunCtx(state));
    const ctx = makeBeforeModelCtx(state);
    await hooks.beforeModel!(ctx);

    // 静态段仍在
    expect(sectionContent(ctx.sections, SYSTEM_SECTION_NAMES.mcp_servers)).toContain('<mcp_servers>');
    // 动态段命中 create_issue，Markdown 表格式（与 skills 一致）
    const rel = cap.getRelevantBlock()!;
    expect(rel).toContain('<relevant_mcp>');
    expect(rel).toContain('| tool | server | description |');
    expect(rel).toContain('| create_issue | github | Create a new issue in a repository |');
  });

  it('前 5 条带描述，其余仅名字（与 skills 一致）', async () => {
    const tools = Array.from({ length: 8 }, (_, i) => ({
      serverName: 'srv',
      name: `search_tool_${i}`,
      description: `search repository detail ${i}`,
    }));
    const cap = new McpCap({ fetchMcp: async () => ({ servers: [{ serverName: 'srv' }], tools }) });
    const state = makeState('search repository');
    await runMcpBeforeRun(cap, state);

    // Markdown 表数据行（排除表头分隔行）
    const dataRows = (cap.getRelevantBlock() ?? '')
      .split('\n')
      .filter((l) => l.startsWith('| search_tool_'));
    // 恰好 5 行描述列非「—」，其余为占位符
    const withDesc = dataRows.filter((l) => !l.endsWith('| — |'));
    expect(withDesc.length).toBe(5);
    expect(dataRows.length).toBeGreaterThan(5);
  });

  it('相对阈值：仅泛词弱命中被过滤，只留强命中', async () => {
    const tools = [
      { serverName: 'gh', name: 'strong', description: 'unicorn common' },
      { serverName: 'gh', name: 'weak1', description: 'common' },
      { serverName: 'gh', name: 'weak2', description: 'common' },
      { serverName: 'gh', name: 'weak3', description: 'common' },
    ];
    const cap = new McpCap({ fetchMcp: async () => ({ servers: [{ serverName: 'gh' }], tools }) });
    const state = makeState('unicorn common');
    await runMcpBeforeRun(cap, state);
    const rel = cap.getRelevantBlock() ?? '';
    expect(rel).toContain('| strong |'); // 强命中（含稀有词 unicorn）保留
    expect(rel).not.toContain('weak1'); // 仅泛词 common 的弱命中被阈值过滤
  });

  it('最多 8 条', async () => {
    const manyTools = Array.from({ length: 20 }, (_, i) => ({
      serverName: 'srv',
      name: `search_tool_${i}`,
      description: 'search things in the repository',
    }));
    const cap = new McpCap({
      fetchMcp: async () => ({ servers: [{ serverName: 'srv' }], tools: manyTools }),
    });
    const state = makeState('search repository');
    await runMcpBeforeRun(cap, state);
    const dataRows = (cap.getRelevantBlock() ?? '')
      .split('\n')
      .filter((l) => l.startsWith('| search_tool_'));
    expect(dataRows.length).toBe(8);
  });
});

describe('McpCap 动态段描述去重', () => {
  it('描述已在上文出现的工具，当轮描述列替换为（见上文）', async () => {
    const listing: McpListing = {
      servers: [{ serverName: 'gh' }],
      tools: [{ serverName: 'gh', name: 'create_issue', description: 'Create a new issue in a repository' }],
    };
    const cap = new McpCap({ fetchMcp: async () => listing });
    const priorContext = {
      role: 'user',
      content:
        '<context type="environment">env</context>\n<relevant_mcp>\n| tool | server | description |\n| --- | --- | --- |\n| create_issue | gh | Create a new issue in a repository |\n</relevant_mcp>',
    };
    const state = {
      __spaceId: 'space-1',
      messages: [priorContext, { role: 'user', content: '再帮我提个 issue' }],
    } as unknown as EngineState;
    await runMcpBeforeRun(cap, state);
    const rel = cap.getRelevantBlock()!;
    expect(rel).toContain('| create_issue | gh | （见上文） |');
    expect(rel).not.toContain('Create a new issue in a repository');
  });
});

describe('McpCap 拉取失败', () => {
  it('fetchMcp 抛错 → 两段都 undefined', async () => {
    const cap = new McpCap({
      fetchMcp: async () => {
        throw new Error('listTools timeout');
      },
    });
    const state = makeState('提个 issue');
    await runMcpBeforeRun(cap, state);
    const ctx = makeBeforeModelCtx(state);
    await cap.hooks()!.beforeModel!(ctx);
    expect(sectionContent(ctx.sections, SYSTEM_SECTION_NAMES.mcp_servers)).toBeUndefined();
    expect(cap.getRelevantBlock()).toBeUndefined();
  });

  it('fetchMcp 返回 null → 两段都 undefined', async () => {
    const cap = new McpCap({ fetchMcp: async () => null });
    const state = makeState('提个 issue');
    await runMcpBeforeRun(cap, state);
    const ctx = makeBeforeModelCtx(state);
    await cap.hooks()!.beforeModel!(ctx);
    expect(sectionContent(ctx.sections, SYSTEM_SECTION_NAMES.mcp_servers)).toBeUndefined();
    expect(cap.getRelevantBlock()).toBeUndefined();
  });
});
