/**
 * CliCap 单测（，两区）。
 *
 * 覆盖：
 *   1. type / category 静态契约 + tools() 为空 + 缺 fetch → hooks() null
 *   2. 静态段 `<cli_commands>`：只列一级命令（，不再列二级子命令名）
 *   3. 动态段 `<relevant_cli>`：query 命中 → 只返回一级命令，前 5 带完整描述
 *   4. query 零重合 → 静态段仍在，动态段 undefined
 *   5. 无命令 → 两段都 undefined
 *   6. fetchCli 抛错 / null → 两段都 undefined
 *   7. 静态段预算：一级命令超限时截断并附 `tabtin commands` 查询方法
 *   8. 动态段最多 8 条
 *
 * ：CliCap 已从 agent-runtime 迁到 @tabtin/agent-host，本单测随源迁来；
 * 对源的 import 指向 host 的 `src/capabilities/cli.js`，契约类型走 @tabtin/agent-runtime 公共面。
 */

import { describe, expect, it } from 'vitest';
import { CliCap, type CliListing } from '../src/capabilities/cli.js';
import {
  makeBeforeModelCtx,
  makeIterationCtx,
  makeRunCtx,
  sectionContent,
} from './fixtures/fake-capabilities.js';
import type { Message, EngineState } from '@tabtin/agent-runtime/engine';
import { SYSTEM_SECTION_NAMES } from '@tabtin/agent-runtime/engine';

function makeState(query?: string): EngineState {
  return { messages: query ? [{ role: 'user', content: query }] : [] } as EngineState;
}

async function runCliBeforeRun(cap: CliCap, state: EngineState): Promise<void> {
  await cap.hooks()!.beforeRun!(makeRunCtx(state));
}

async function cliStaticIndex(cap: CliCap, state: EngineState): Promise<string | undefined> {
  const hooks = cap.hooks()!;
  await hooks.beforeRun!(makeRunCtx(state));
  const ctx = makeBeforeModelCtx(state);
  await hooks.beforeModel!(ctx);
  return sectionContent(ctx.sections, SYSTEM_SECTION_NAMES.cli_commands);
}

const LISTING: CliListing = {
  commands: [
    {
      name: 'browser',
      description: 'Browser automation',
      long: 'Open pages, interact with elements, and collect web data.',
      isGroup: true,
    },
    { name: 'browser open', description: 'Open a URL in the browser', risk: 'read', flags: ['url', 'wait'] },
    { name: 'browser snapshot', description: 'Capture a DOM snapshot', risk: 'read' },
    { name: 'table', description: 'Manage tables and records', isGroup: true },
    { name: 'table query', description: 'Query rows from a table', risk: 'read', flags: ['table', 'filter'] },
    { name: 'doc', description: 'Manage documents', isGroup: true },
    { name: 'doc read', description: 'Read a document', risk: 'read' },
  ],
};

describe('CliCap 静态契约', () => {
  it('type === "cli" / category === "core"，tools() 为空', () => {
    const cap = new CliCap();
    expect(cap.type).toBe('cli');
    expect(cap.category).toBe('core');
    expect(cap.tools()).toEqual([]);
  });

  it('fetchCli 缺省时 hooks() 返回 null', () => {
    expect(new CliCap().hooks()).toBeNull();
  });
});

describe('CliCap 静态段 <cli_commands>', () => {
  it('只列一级命令（query 无关也出），不注入二级子命令名', async () => {
    const cap = new CliCap({ fetchCli: async () => LISTING });
    const state = makeState('今天天气怎么样'); // 与命令零重合
    const idx = (await cliStaticIndex(cap, state))!;

    expect(idx).toContain('<cli_commands>');
    expect(idx).toContain('禁止再接 `head` / `tail` 截断输出');
    expect(idx).toContain('完整大输出由 run_terminal_command 自动落盘');
    expect(idx).toContain('只列出 `tabtin <一级命令>`');
    expect(idx).toContain('- browser');
    expect(idx).toContain('- table');
    expect(idx).toContain('- doc');
    expect(idx).not.toContain('- browser: browser, open, snapshot');
    expect(idx).not.toContain('open, snapshot');
    expect(idx).not.toContain('table, query');
    expect(idx).not.toContain('doc, read');
    // 零重合 → 动态段不出
    expect(cap.getRelevantBlock()).toBeUndefined();
  });

  it('静态段只列 media 一级命令，不注入生图工作流细则', async () => {
    const cap = new CliCap({
      fetchCli: async () => ({
        commands: [{ name: 'media image generate', description: '生成图片', risk: 'write' }],
      }),
    });

    const idx = (await cliStaticIndex(cap, makeState('画一只红苹果')))!;

    expect(idx).toContain('- media');
    expect(idx).not.toContain('tabtin media image models --format json');
    expect(idx).not.toContain('present_to_user');
    expect(idx).not.toContain('禁止用 SVG');
    expect(idx).not.toContain('非空 HTTPS');
    expect(idx).not.toContain('视为失败');
    expect(idx).not.toContain('- media image generate');
  });

  it('无命令 → 两段都 undefined', async () => {
    const cap = new CliCap({ fetchCli: async () => ({ commands: [] }) });
    const state = makeState('随便');
    await runCliBeforeRun(cap, state);
    const ctx = makeBeforeModelCtx(state);
    await cap.hooks()!.beforeModel!(ctx);
    expect(sectionContent(ctx.sections, SYSTEM_SECTION_NAMES.cli_commands)).toBeUndefined();
    expect(cap.getRelevantBlock()).toBeUndefined();
  });

  it('预算超限：一级命令截断附查询方法', async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      name: `verylongtoplevelcommandname${i}`,
      description: 'x',
    }));
    const cap = new CliCap({
      fetchCli: async () => ({ commands: many }),
      contextWindowTokens: 1_000, // 预算 2000 chars，200 个长名必截断
    });
    const state = makeState('无关');
    const idx = (await cliStaticIndex(cap, state))!;
    expect(idx).toContain('- verylongtoplevelcommandname0');
    expect(idx).toMatch(/\+\d+ 个一级命令，用 tabtin commands --format json 看全/);
    expect(idx).not.toContain('verylongtoplevelcommandname199');
  });
});

describe('CliCap 动态段 <relevant_cli>', () => {
  it('media 被召回时，在对应 CLI 描述里注入生图工作流与成功判据', async () => {
    const cap = new CliCap({
      fetchCli: async () => ({
        commands: [
          { name: 'media', description: 'AI 媒体生成', isGroup: true },
          { name: 'media image generate', description: '生成图片', risk: 'write', flags: ['prompt', 'model', 'format'] },
          { name: 'media image models', description: '可用模型', risk: 'read', flags: ['format'] },
        ],
      }),
    });
    const state = makeState('生成图片');
    await runCliBeforeRun(cap, state);
    const rel = cap.getRelevantBlock()!;

    expect(rel).toContain('| tabtin media |');
    expect(rel).toContain('tabtin media image models --format json');
    expect(rel).toContain('tabtin media image generate --prompt');
    expect(rel).toContain('present_to_user');
    expect(rel).toContain('禁止用 SVG');
    expect(rel).toContain('非空 HTTPS');
    expect(rel).toContain('视为失败');
  });

  it('query 命中子命令语义 → 只召回一级命令并提示用 --help 深入', async () => {
    const cap = new CliCap({ fetchCli: async () => LISTING });
    const state = makeState('open a url in the browser');
    const hooks = cap.hooks()!;
    await hooks.beforeRun!(makeRunCtx(state));
    const ctx = makeBeforeModelCtx(state);
    await hooks.beforeModel!(ctx);

    expect(sectionContent(ctx.sections, SYSTEM_SECTION_NAMES.cli_commands)).toContain('<cli_commands>');
    const rel = cap.getRelevantBlock()!;
    expect(rel).toContain('<relevant_cli>');
    expect(rel).toContain('| command | risk | description |');
    expect(rel).toContain('只展示 `tabtin <一级命令>`');
    expect(rel).toContain('`tabtin <一级命令> --help`');
    expect(rel).toContain('| tabtin browser | read |');
    expect(rel).toContain('Open pages, interact with elements, and collect web data.');
    expect(rel).not.toContain('| tabtin browser open |');
  });

  it('一级命令用全部子命令元数据参与召回，但不把子命令写入结果', async () => {
    const listing: CliListing = {
      commands: [
        {
          name: 'browser',
          description: '浏览器自动化',
          isGroup: true,
        },
        {
          name: 'browser act',
          description: '点击页面元素并填写表单',
          flags: ['actions'],
        },
      ],
    };
    const cap = new CliCap({ fetchCli: async () => listing });
    const state = makeState('点击页面表单');
    await runCliBeforeRun(cap, state);
    const rel = cap.getRelevantBlock() ?? '';
    expect(rel).toContain('| tabtin browser |');
    expect(rel).not.toContain('| tabtin browser act |');
  });

  it('网页抓取意图召回 browser 一级命令', async () => {
    const listing: CliListing = {
      commands: [
        {
          name: 'browser',
          description: '浏览器自动化、网页交互、内容读取与数据抓取',
          isGroup: true,
        },
        { name: 'browser print', description: '导出网页内容' },
      ],
    };
    const cap = new CliCap({ fetchCli: async () => listing });
    await runCliBeforeRun(cap, makeState('抓取网页评论'));
    expect(cap.getRelevantBlock()).toContain('| tabtin browser |');
  });

  it('没有根条目的命令域仍合成为一级入口', async () => {
    const listing: CliListing = {
      commands: [
        {
          name: 'tabtin invoke chat export-md',
          description: '导出聊天记录为 Markdown',
        },
      ],
    };
    const cap = new CliCap({ fetchCli: async () => listing });
    await runCliBeforeRun(cap, makeState('导出聊天记录'));
    const relevant = cap.getRelevantBlock() ?? '';
    expect(relevant).toContain('| tabtin invoke |');
    expect(relevant).not.toContain('tabtin tabtin');
    expect(relevant).not.toContain('| tabtin invoke chat export-md |');
  });

  it('大型命令域仍保留子命令 flag 的召回语义', async () => {
    const listing: CliListing = {
      commands: [
        { name: 'browser', description: '浏览器自动化', isGroup: true },
        ...Array.from({ length: 100 }, (_, index) => ({
          name: `browser child${index}`,
          description: `很长的子命令描述 ${index} ${'内容'.repeat(30)}`,
        })),
        {
          name: 'browser print',
          description: '导出页面内容',
          flags: ['schema'],
        },
      ],
    };
    const cap = new CliCap({ fetchCli: async () => listing });
    await runCliBeforeRun(cap, makeState('按 schema 提取数据'));
    expect(cap.getRelevantBlock()).toContain('| tabtin browser |');
  });

  it('前 5 条带描述，其余仅名字', async () => {
    const cmds = Array.from({ length: 8 }, (_, i) => ({
      name: `search${i}`,
      description: `search repository detail ${i}`,
    }));
    const cap = new CliCap({ fetchCli: async () => ({ commands: cmds }) });
    const state = makeState('search repository');
    await runCliBeforeRun(cap, state);
    const dataRows = (cap.getRelevantBlock() ?? '')
      .split('\n')
      .filter((l) => l.startsWith('| tabtin search'));
    const withDesc = dataRows.filter((l) => !l.endsWith('| — |'));
    expect(withDesc.length).toBe(5);
    expect(dataRows.length).toBeGreaterThan(5);
  });

  it('相对阈值：仅泛词弱命中被过滤，只留强命中', async () => {
    const commands = [
      { name: 'strong', description: 'unicorn common' },
      { name: 'weak1', description: 'common' },
      { name: 'weak2', description: 'common' },
      { name: 'weak3', description: 'common' },
    ];
    const cap = new CliCap({ fetchCli: async () => ({ commands }) });
    const state = makeState('unicorn common');
    await runCliBeforeRun(cap, state);
    const rel = cap.getRelevantBlock() ?? '';
    expect(rel).toContain('| tabtin strong |');
    expect(rel).not.toContain('tabtin weak1');
  });

  it('最多 8 条', async () => {
    const cmds = Array.from({ length: 20 }, (_, i) => ({
      name: `search${i}`,
      description: 'search repository',
    }));
    const cap = new CliCap({ fetchCli: async () => ({ commands: cmds }) });
    const state = makeState('search repository');
    await runCliBeforeRun(cap, state);
    const dataRows = (cap.getRelevantBlock() ?? '')
      .split('\n')
      .filter((l) => l.startsWith('| tabtin search'));
    expect(dataRows.length).toBe(8);
  });
});

describe('CliCap fetchCli context', () => {
  // ：organizationId 不再由 Cap 传入 fetchCli——它是 per-runtime 常量，
  // 已由 host 装配期烘进 fetchCli 闭包。Cap 只透传 query（用户原话 + in_progress todo）。
  it('beforeRun 只把 query 传进 fetchCli context，不含 organizationId', async () => {
    const seen: Array<{ query?: string } & Record<string, unknown>> = [];
    const cap = new CliCap({
      fetchCli: async (ctx) => {
        seen.push(ctx);
        return LISTING;
      },
    });
    const state = {
      ...makeState('open browser'),
      __organizationId: 'org-gate-1',
    } as EngineState;
    await runCliBeforeRun(cap, state);
    expect(seen).toHaveLength(1);
    expect(seen[0].query).toContain('open browser');
    expect(seen[0].organizationId).toBeUndefined();
  });
});

describe('CliCap beforeIteration 随 in_progress todo 重算', () => {
  const userMsg: Message = { role: 'user', content: 'open a url in the browser' };
  function todo(
    todos: Array<{ id: string; content: string; status: string }>,
    merge = false,
  ): Message {
    return {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't', name: 'todo', input: { action: 'open', items: todos } }],
    };
  }

  it('todo 不变 → beforeIteration 不重复 fetch（_lastRecallQuery 门控）', async () => {
    let calls = 0;
    const cap = new CliCap({
      fetchCli: async () => {
        calls++;
        return LISTING;
      },
    });
    const state = { messages: [userMsg] } as EngineState;
    const hooks = cap.hooks()!;
    await hooks.beforeRun!(makeRunCtx(state));
    expect(calls).toBe(1);
    await hooks.beforeIteration!(makeIterationCtx(state));
    expect(calls).toBe(1); // query 未变 → 跳过
  });

  it('in_progress 推进 → 检索词变化 → beforeIteration 用新 query 重算', async () => {
    const seen: string[] = [];
    const cap = new CliCap({
      fetchCli: async (ctx) => {
        seen.push(ctx.query ?? '');
        return LISTING;
      },
    });
    const state = {
      messages: [
        userMsg,
        todo([{ id: '1', content: 'query rows from a table', status: 'in_progress' }]),
      ],
    } as EngineState;
    const hooks = cap.hooks()!;
    await hooks.beforeRun!(makeRunCtx(state));

    // 推进 todo：第一条完成、第二条 in_progress。
    state.messages = [
      userMsg,
      todo([{ id: '1', content: 'query rows from a table', status: 'in_progress' }]),
      todo(
        [
          { id: '1', content: 'query rows from a table', status: 'completed' },
          { id: '2', content: 'capture a dom snapshot', status: 'in_progress' },
        ],
        true,
      ),
    ];
    await hooks.beforeIteration!(makeIterationCtx(state));

    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('query rows from a table');
    expect(seen[1]).toContain('capture a dom snapshot');
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe('CliCap 拉取失败', () => {
  it('fetchCli 抛错 → 两段都 undefined', async () => {
    const cap = new CliCap({
      fetchCli: async () => {
        throw new Error('spawn failed');
      },
    });
    const state = makeState('open browser');
    await runCliBeforeRun(cap, state);
    const ctx = makeBeforeModelCtx(state);
    await cap.hooks()!.beforeModel!(ctx);
    expect(sectionContent(ctx.sections, SYSTEM_SECTION_NAMES.cli_commands)).toBeUndefined();
    expect(cap.getRelevantBlock()).toBeUndefined();
  });

  it('fetchCli 返回 null → 两段都 undefined', async () => {
    const cap = new CliCap({ fetchCli: async () => null });
    const state = makeState('open browser');
    await runCliBeforeRun(cap, state);
    const ctx = makeBeforeModelCtx(state);
    await cap.hooks()!.beforeModel!(ctx);
    expect(sectionContent(ctx.sections, SYSTEM_SECTION_NAMES.cli_commands)).toBeUndefined();
    expect(cap.getRelevantBlock()).toBeUndefined();
  });
});
