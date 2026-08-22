/**
 * context-injector — appMeta 渲染分支 + openTabs hint 渲染测试
 *
 * 2026-05-14 大重写：renderer 端预填 `app_key` / `display_name` / `is_home` 后，
 * context-injector 不再做 type case-switch 来推断 App 名字——直接用 tab 上的
 * Agent-facing 字段渲染。本文件锁定下列契约：
 *
 *   1. `focused: ...` 行：取代旧 `focused_app: <internal_key>` + `Active app: ...`
 *      两行重复。优先取 active tab 的 display_name；落在 chat panel 时退化为
 *      `focused: Chat Panel(...)`。
 *
 *   2. `open_tabs:` 段统一列出 active + background（取消独立 `active_tab:` /
 *      `background_tabs:` 两块结构）。active tab 行尾标 `(active)`。
 *
 *   3. 每个 tab 用 `formatTabLabel` 渲染：
 *        - is_home=true        → "{display_name} (首页)"
 *        - 有 title            → "{display_name}「{title}」"
 *        - 缺 title 但有 id    → "{display_name}「未命名」(id: <短截 8 位>)"
 *        - display_name 缺失   → 回退到 app_key 或 type
 *
 *   4. App-specific 详情走 `details:` 块。** 去业务化后**：详情段的
 *      按 appType 渲染（字段口径、产品名、tabtin CLI 配方）已迁到宿主注入的
 *      `AppMetaFormatter`——本文件只再验中性框架（不注入 formatter → 无详情段）；
 *      详情块的具体断言迁到宿主侧的 `app-meta-formatter.test.ts`。
 *
 *   5. space_id 行已下线（2026-05-14 runtime_identity 段拆分）；同一事实在
 *      system prompt 的 `<environment>` 段固化。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildContextHook,
  type AppContext,
} from '../src/hooks/index.js';
import type {
  Message,
  EngineState,
} from '@tabtin/agent-runtime/engine';

// ── Helpers ──────────────────────────────────────────────────────────

async function runHookAndGetText(ctx: AppContext): Promise<string> {
  const hook = buildContextHook({
    getAppContext: async () => ctx,
  });
  const messages: Message[] = [];
  const mockState = { messages } as unknown as EngineState;
  await hook.beforeIteration!({ state: mockState, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
  expect(mockState.messages.length).toBeGreaterThan(0);
  const ctxMsg = mockState.messages[0]!;
  // ：context-injector 注入 string content（与历史重建形态统一）。
  expect(typeof ctxMsg.content).toBe('string');
  return ctxMsg.content as string;
}

// 注：tabweb / tabdoc / tabwhiteboard / tabtracker 的 `details:` 段断言（含
// tabtin CLI 配方、产品名）随 AppMetaFormatter 迁到宿主，见宿主侧的
// `tests/app-meta-formatter.test.ts`。本文件不注入 formatter，故只覆盖
// 不含详情段的中性框架行为。

// ── focused: chat panel ──────────────────────────────────────────────

describe('context-injector — chat panel 焦点', () => {
  it('appType=chat 且无 active tab → "focused: Chat Panel(...)"', async () => {
    const text = await runHookAndGetText({
      appType: 'chat',
      spaceId: 'sp1',
    });
    expect(text).toContain('focused: Chat Panel');
    // 不应该再有 details / open_tabs 段
    expect(text).not.toContain('details:');
  });
});

describe('context-injector — current_model ', () => {
  it('注入本轮执行模型，供自述对齐选择器', async () => {
    const text = await runHookAndGetText({
      appType: 'chat',
      currentModelId: '42ae58c8-feea-4098-b80b-9a0aedc35007',
      currentModelDisplayName: 'Kimi K2.7 Code',
    });
    expect(text).toContain('current_model: Kimi K2.7 Code');
    expect(text).toContain('current_model_id: 42ae58c8-feea-4098-b80b-9a0aedc35007');
    expect(text).toContain('本轮实际执行');
  });
});

// ── focused + open_tabs 渲染 ─────────────────────────────────────────

describe('context-injector — open_tabs 段', () => {
  it('active tab 进入 focused 行 + open_tabs 顶部，背景 tabs 依次列出', async () => {
    const text = await runHookAndGetText({
      appType: 'tabcode',
      spaceId: 'sp1',
      openTabs: [
        {
          type: 'tabcode',
          id: 'p-foo',
          title: 'Project Foo',
          path: '/Users/me/code/foo',
          active: true,
          app_key: 'tabcode',
          display_name: '代码',
        },
        {
          type: 'tabweb',
          id: 'view-1',
          title: 'Google',
          url: 'https://google.com',
          app_key: 'tabweb',
          display_name: '浏览器',
        },
        {
          type: 'apphome',
          id: 'tabcode',
          title: 'TabCode',
          app_home: 'tabcode',
          app_key: 'tabcode',
          display_name: '代码',
          is_home: true,
        },
      ],
    });

    // 1. focused 行：active tab 的 display_name + title
    expect(text).toMatch(/focused: 代码「Project Foo」/);

    // 2. open_tabs 段头
    expect(text).toContain('open_tabs:');

    // 3. active 行带 (active) 标记，路径 hint 缩短到尾部 2 段
    expect(text).toMatch(/- 代码「Project Foo」 \[path=.*foo\] \(active\)/);

    // 4. background tab（tabweb）渲染显示名 + url hint
    expect(text).toMatch(/- 浏览器「Google」 \[url=https:\/\/google\.com\]/);

    // 5. apphome 渲染为 "(首页)"
    expect(text).toContain('- 代码 (首页)');
  });

  it('只有 active tab → open_tabs 段只输出 active 行', async () => {
    const text = await runHookAndGetText({
      appType: 'tabweb',
      spaceId: 'sp1',
      openTabs: [
        {
          type: 'tabweb',
          id: 'view-x',
          title: 'X',
          url: 'https://x.com',
          active: true,
          app_key: 'tabweb',
          display_name: '浏览器',
        },
      ],
    });
    expect(text).toContain('focused: 浏览器「X」');
    expect(text).toContain('open_tabs:');
    expect(text).toMatch(/- 浏览器「X」 \[url=https:\/\/x\.com\] \(active\)/);
  });

  it('background tabs 超过 5 个 → 后面用 "(+N more tabs)" 简写', async () => {
    const tabs = Array.from({ length: 8 }, (_, i) => ({
      type: 'tabweb',
      id: `view-${i}`,
      title: `Tab ${i}`,
      url: `https://t${i}.com`,
      active: i === 0,
      app_key: 'tabweb',
      display_name: '浏览器',
    }));
    const text = await runHookAndGetText({
      appType: 'tabweb',
      spaceId: 'sp1',
      openTabs: tabs,
    });
    // 7 个 background tabs，前 5 个详细渲染、剩下 2 个用 (+2 more tabs)
    expect(text).toContain('(+2 more tabs)');
  });

  it('tabfolder：path + kind hint 同时输出，display_name 替代 type', async () => {
    const text = await runHookAndGetText({
      appType: 'tabfolder',
      spaceId: 'sp1',
      openTabs: [
        {
          type: 'tabfolder',
          id: 'fold-ws',
          title: 'workspace',
          path: '/Users/me/workspace',
          kind: 'user',
          active: true,
          app_key: 'tabfolder',
          display_name: '本地目录',
        },
      ],
    });
    expect(text).toMatch(/- 本地目录「workspace」 \[.*kind=user.*\] \(active\)/);
    expect(text).toMatch(/- 本地目录.*path=.*workspace/);
  });

  it('display_name 缺失时 fallback 到 app_key / type', async () => {
    // 老链路 / 测试桩可能没填 display_name —— hook 不应崩，应用 fallback。
    const text = await runHookAndGetText({
      appType: 'tabweb',
      spaceId: 'sp1',
      openTabs: [
        {
          type: 'tabweb',
          id: 'view-1',
          title: 'X',
          active: true,
          // 故意不填 app_key / display_name
        },
      ],
    });
    // 退化为 type 名做 App 锚点
    expect(text).toMatch(/- tabweb「X」/);
  });

  it('资源 tab 缺 title 时显示 "未命名" + 短截 id', async () => {
    const text = await runHookAndGetText({
      appType: 'tabdata',
      spaceId: 'sp1',
      openTabs: [
        {
          type: 'tabdata',
          id: 'ff35df32-a684-4348-9662-3350abb0a42d',
          active: true,
          app_key: 'tabdata',
          display_name: '多维表',
          // title 缺失
        },
      ],
    });
    expect(text).toMatch(/- 多维表「未命名」\(id: ff35df32\)/);
  });

  it('apphome tab 渲染为 "(首页)" 后缀，不暴露 apphome 字面量给 LLM', async () => {
    const text = await runHookAndGetText({
      appType: 'apphome',
      spaceId: 'sp1',
      openTabs: [
        {
          type: 'apphome',
          id: 'tabdata',
          title: '多维表',
          app_home: 'tabdata',
          app_key: 'tabdata',
          display_name: '多维表',
          is_home: true,
          active: true,
        },
      ],
    });
    expect(text).toContain('focused: 多维表 (首页)');
    expect(text).toContain('- 多维表 (首页) (active)');
    // 不应再用 "apphome("X") [app_home=Y]" 的旧双层结构
    expect(text).not.toMatch(/apphome\("/);
  });

  it.each([
    ['tabmail', '邮箱'],
    ['tabphone', '安卓手机'],
    ['tabwhiteboard', '白板'],
  ] as const)('#5353：%s 不出现在 environment context', async (appKey, displayName) => {
    const text = await runHookAndGetText({
      appType: appKey,
      spaceId: 'sp1',
      openTabs: [
        {
          type: appKey,
          id: `${appKey}-1`,
          title: '残留标签',
          app_home: appKey,
          app_key: appKey,
          display_name: displayName,
          active: true,
        },
        {
          type: 'tabdoc',
          id: 'doc-keep',
          title: '周报',
          app_key: 'tabdoc',
          display_name: '文档',
          active: false,
        },
      ],
    });
    expect(text).not.toContain(displayName);
    expect(text).not.toContain(appKey);
    expect(text).toContain('文档「周报」');
  });

  it('is_home=true 时 title 不应再拼到 (首页) 之外形成双层 label（review negative）', async () => {
    // formatTabLabel 在 is_home 分支 early return，title 必须被丢掉——
    // 否则 LLM 会看到 "多维表 (首页)「TabCode」" 这种诡异双层结构。
    const text = await runHookAndGetText({
      appType: 'apphome',
      spaceId: 'sp1',
      openTabs: [
        {
          type: 'apphome',
          id: 'tabdata',
          title: 'TabCode', // 故意填一个错误的、跟 app_key 不匹配的 title
          app_key: 'tabdata',
          display_name: '多维表',
          is_home: true,
          active: true,
        },
      ],
    });
    expect(text).toContain('focused: 多维表 (首页)');
    expect(text).not.toContain('「TabCode」'); // title 必须被丢掉
    expect(text).not.toMatch(/多维表 \(首页\)「/); // 双层 label 检测
  });

  it('apphome 缺 display_name + is_home=true 时 fallback 到 type 名（review negative，锁定当前行为）', async () => {
    // review fallback 风险：app_key / display_name 都缺失时 fallback 链到 type
    // 名 'apphome'——这是当前实现的"可见漂移点"。如果未来兜底改成 '未知 App'，
    // 同步更新这条断言。锁住它避免无声回退到完整内部 key 暴露。
    const text = await runHookAndGetText({
      appType: 'apphome',
      spaceId: 'sp1',
      openTabs: [
        {
          type: 'apphome',
          id: 'unknown_app',
          is_home: true,
          active: true,
          // 故意不填 app_key / display_name（renderer schema 漂移场景）
        },
      ],
    });
    expect(text).toContain('apphome (首页)');
  });
});

// ── space_id 已下线 ──────────────────────────────────────────────────

describe('context-injector — space_id 行已下线', () => {
  it('不论传不传 spaceId，context block 都不再出现 space_id 行', async () => {
    const text = await runHookAndGetText({
      appType: 'tabweb',
      appMeta: { current_browser_url: 'https://x.com' },
      spaceId: 'sp-XYZ',
    });
    expect(text).not.toMatch(/\bspace_id:/);
  });
});

// ── current_datetime 分钟精度（cache 友好， 时间回归）─────────────

describe('context-injector — current_datetime 分钟精度', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function dtLineOf(text: string): string {
    const line = text.split('\n').find((l) => l.startsWith('current_datetime:'));
    expect(line).toBeDefined();
    return line!;
  }

  it('context 含 current_datetime（分钟精度，不含秒）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T10:13:32.456Z'));
    const text = await runHookAndGetText({ appType: 'chat' });
    expect(dtLineOf(text)).toBe('current_datetime: 2026-05-21 10:13 (UTC+0)');
    expect(dtLineOf(text)).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('按用户设备时区渲染 current_datetime（本地 + offset）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T23:42:10.000Z'));
    const text = await runHookAndGetText({ appType: 'chat', userTimeZone: 'Asia/Shanghai' });
    expect(dtLineOf(text)).toBe('current_datetime: 2026-05-22 07:42 (UTC+8)');
  });
});
