/**
 * Builder 完整快照测试 —— 阶段 1.4 实装
 *
 * 任何对 buildSystemPrompt / 各 section / mode prompt md / generated content
 * 的修改，都会触发 snapshot diff。reviewer 在 PR 直接看 diff 评估影响。
 *
 * snapshot 覆盖：
 *   - 5 个 mode（agent / plan / ask / study / group）的完整 prompt 输出
 *   - 11 个 base prompt 函数段独立输出（principle / environment / shell_runtime /
 *     platform_data / apps / user_portrait / custom_rules /
 *     cli_capabilities / tools_reference / execution_boundary）
 *   - 4 个从 .md 生成的常量段（SECTION_EXECUTION / ASK_USER_TOOLS / SAFETY /
 *     SKILLS_USAGE / PLANNING）
 *   - 5 个特殊 config combo
 *
 * 更新 snapshot：`pnpm --filter @tabtin/agent-prompt test -- -u`
 *
 */

import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../builder.js';
import {
  buildPrincipleSection,
  buildEnvironmentSection,
  buildShellRuntimeSection,
  buildPlatformDataSection,
  buildAppsSection,
  buildUserPortraitSection,
  buildCustomRulesSection,
  buildMemoryRecallSection,
  buildCliCapabilitiesSection,
  buildToolsReferenceSection,
  type MemoryRecallEntry,
} from '../sections.js';
import { buildExecutionBoundaryPrompt } from '../execution-boundary.js';
import {
  SECTION_EXECUTION,
  SECTION_ASK_USER_TOOLS,
  SECTION_SAFETY,
  SECTION_SKILLS_USAGE,
  SECTION_PLANNING,
} from '../generated-content.js';
import type { EnabledAppInfo, RuntimeIdentity } from '../types.js';

// ─── 固定测试 fixtures（snapshot 稳定）───────────────────────────────

const FIXED_RUNTIME_IDENTITY: RuntimeIdentity = {
  spaceId: 'space-snapshot-test',
  organizationId: 'organization-snapshot-test',
  threadId: 'session-snapshot-test',
  spaceName: '我的工作空间',
  organizationName: '示例团队',
  workspaceRoot: '/Users/snapshot/workspace',
  archiveDir: '/Users/snapshot/data/archive',
  toolLogsDir: '/Users/snapshot/data/tool-logs',
};

const FIXED_TOOLS = [
  { name: 'run_terminal_command', description: '执行 shell 命令' },
  { name: 'read_file', description: '读文件' },
  { name: 'edit_file', description: '编辑文件' },
  { name: 'ask_user', description: '向用户提多选问题' },
  { name: 'web_search', description: '搜索网络' },
  { name: 'todo_write', description: '维护 todo 列表' },
  { name: 'skills_search', description: '搜索本地 skill' },
  { name: 'skills_read', description: '读取本地 skill' },
];

const FIXED_APPS: readonly EnabledAppInfo[] = [
  {
    key: 'tabdata',
    cliKey: 'table',
    displayName: '多维表',
    capability: '结构化数据表格',
    aliases: ['表格'],
  },
  {
    key: 'tabdoc',
    cliKey: 'doc',
    displayName: '文档',
    capability: '富文本协作文档',
  },
];

// ─── 5 个 mode 的完整 prompt snapshot ────────────────────────────────

describe('buildSystemPrompt 完整快照 - 5 个 agent mode', () => {
  for (const mode of ['agent', 'plan', 'ask', 'study', 'group'] as const) {
    it(`mode=${mode}：完整 prompt`, () => {
      const prompt = buildSystemPrompt({
        agentMode: mode,
        tools: FIXED_TOOLS,
        runtimeIdentity: FIXED_RUNTIME_IDENTITY,
        enabledApps: FIXED_APPS,
      });
      expect(prompt).toMatchSnapshot();
    });
  }
});

// ─── base prompt 函数段独立 snapshot ──────────────────────────────────

describe('base prompt 函数段独立快照', () => {
  it('buildPrincipleSection - 默认原则（角色设定已下线）', () => {
    expect(buildPrincipleSection()).toMatchSnapshot();
  });

  it('buildEnvironmentSection - 含 spaceName/organizationName', () => {
    expect(buildEnvironmentSection(FIXED_RUNTIME_IDENTITY)).toMatchSnapshot();
  });

  it('buildEnvironmentSection - 缺 spaceName/organizationName（Daemon 路径）', () => {
    const minimalIdentity: RuntimeIdentity = {
      spaceId: 'space-uuid-only',
      organizationId: 'organization-uuid-only',
      threadId: 'session-uuid-only',
      workspaceRoot: '/daemon/workspace',
      archiveDir: '/daemon/archive',
      toolLogsDir: '/daemon/tool-logs',
    };
    expect(buildEnvironmentSection(minimalIdentity)).toMatchSnapshot();
  });

  it('buildShellRuntimeSection', () => {
    expect(buildShellRuntimeSection(FIXED_RUNTIME_IDENTITY)).toMatchSnapshot();
  });

  it('buildShellRuntimeSection - shellInfo=zsh（macOS 主路径）', () => {
    expect(
      buildShellRuntimeSection(FIXED_RUNTIME_IDENTITY, { shell: '/bin/zsh', kind: 'zsh' }),
    ).toMatchSnapshot();
  });

  it('buildShellRuntimeSection - shellInfo=powershell（Windows）', () => {
    expect(
      buildShellRuntimeSection(FIXED_RUNTIME_IDENTITY, {
        shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        kind: 'powershell',
      }),
    ).toMatchSnapshot();
  });

  it('buildShellRuntimeSection - shellInfo=cmd（Windows 兜底）', () => {
    expect(
      buildShellRuntimeSection(FIXED_RUNTIME_IDENTITY, {
        shell: 'C:\\Windows\\System32\\cmd.exe',
        kind: 'cmd',
      }),
    ).toMatchSnapshot();
  });

  it('buildPlatformDataSection', () => {
    expect(buildPlatformDataSection(FIXED_RUNTIME_IDENTITY)).toMatchSnapshot();
  });

  it('buildAppsSection - 2 个启用 App', () => {
    expect(buildAppsSection(FIXED_APPS)).toMatchSnapshot();
  });

  it('buildAppsSection - 空数组 → 跳过', () => {
    expect(buildAppsSection([])).toBe('');
  });

  it('buildUserPortraitSection - 含画像', () => {
    expect(
      buildUserPortraitSection(
        '## 工作背景\n资深工程师，主修 TypeScript / Rust。\n\n## 个人背景\n喜欢简洁工具链，反感过度设计。',
      ),
    ).toMatchSnapshot();
  });

  it('buildUserPortraitSection - 空画像 → 跳过', () => {
    expect(buildUserPortraitSection('')).toBe('');
    expect(buildUserPortraitSection(undefined)).toBe('');
  });

  it('buildCustomRulesSection - 含规则', () => {
    expect(
      buildCustomRulesSection('始终用 TypeScript 写代码。\n所有 commit 用中文。'),
    ).toMatchSnapshot();
  });

  it('buildCustomRulesSection - 空规则 → 跳过', () => {
    expect(buildCustomRulesSection('')).toBe('');
  });

  it('buildMemoryRecallSection - 含 3 条 memo', () => {
    const memos: MemoryRecallEntry[] = [
      {
        id: 'memo-1',
        content: '用户偏好用 Tab 缩进，不用空格。',
        memo_type: 'about_you',
        created_at: '2026-05-10',
      },
      {
        id: 'memo-2',
        content: '上次任务用 pnpm build:web 编译 web 端，输出在 dist/web/。',
        memo_type: 'insight',
        created_at: '2026-05-15',
      },
      {
        id: 'memo-3',
        content: 'TabTinAgent monorepo 用 turborepo + pnpm workspace，根 package.json 里有 turbo.json。',
        memo_type: 'insight',
        created_at: '2026-05-18',
      },
    ];
    expect(buildMemoryRecallSection(memos)).toMatchSnapshot();
  });

  it('buildMemoryRecallSection - 空数组 → 跳过', () => {
    expect(buildMemoryRecallSection([])).toBe('');
  });

  it('buildCliCapabilitiesSection - 含参考', () => {
    expect(
      buildCliCapabilitiesSection(
        '- `tabtin table list`：列出当前工作空间所有表\n- `tabtin doc read --id xxx`：读文档',
      ),
    ).toMatchSnapshot();
  });

  it('buildCliCapabilitiesSection - null → 跳过', () => {
    expect(buildCliCapabilitiesSection(null)).toBe('');
  });

  it('buildToolsReferenceSection - 8 个 fixture 工具', () => {
    expect(buildToolsReferenceSection(FIXED_TOOLS)).toMatchSnapshot();
  });

  it('buildExecutionBoundaryPrompt - yolo + workspace paths', () => {
    expect(
      buildExecutionBoundaryPrompt({
        yoloMode: true,
        workspacePaths: ['/home/user/project'],
      }),
    ).toMatchSnapshot();
  });

  it('buildExecutionBoundaryPrompt - default + memo entries', () => {
    expect(
      buildExecutionBoundaryPrompt({
        yoloMode: false,
        memoEntries: [
          { key: 'allow_npm_install', description: '允许运行 npm install', allowed: true },
          { key: 'deny_db_drop', description: '禁止 DROP DATABASE', allowed: false },
        ],
      }),
    ).toMatchSnapshot();
  });
});

// ─── 从 .md 生成的常量段独立 snapshot ────────────────────────────────

describe('generated-content 常量段独立快照（防止 .md 改动失控）', () => {
  it('SECTION_EXECUTION', () => {
    expect(SECTION_EXECUTION).toMatchSnapshot();
  });

  it('SECTION_ASK_USER_TOOLS', () => {
    expect(SECTION_ASK_USER_TOOLS).toMatchSnapshot();
  });

  it('SECTION_SAFETY', () => {
    expect(SECTION_SAFETY).toMatchSnapshot();
  });

  it('SECTION_SKILLS_USAGE', () => {
    expect(SECTION_SKILLS_USAGE).toMatchSnapshot();
  });

  it('SECTION_PLANNING', () => {
    expect(SECTION_PLANNING).toMatchSnapshot();
  });
});

// ─── 特殊 config combo snapshot ──────────────────────────────────────

describe('buildSystemPrompt 特殊 config combo', () => {
  it('最小 config（无 persona / customRules / runtimeIdentity / apps）', () => {
    expect(buildSystemPrompt({ tools: FIXED_TOOLS })).toMatchSnapshot();
  });

  it('agent mode + 全 config（含 user_portrait + memory + cliReference）', () => {
    expect(
      buildSystemPrompt({
        customRules: '所有输出用中文。',
        agentMode: 'agent',
        tools: FIXED_TOOLS,
        runtimeIdentity: FIXED_RUNTIME_IDENTITY,
        enabledApps: FIXED_APPS,
        userPortrait: '## 工作背景\n后端工程师，专注分布式系统。',
        memoryCapability: true,
        cliReference: '- `tabtin table query`：执行 SQL',
      }),
    ).toMatchSnapshot();
  });

  it('plan mode + 最小 config', () => {
    expect(
      buildSystemPrompt({
        agentMode: 'plan',
        tools: FIXED_TOOLS,
      }),
    ).toMatchSnapshot();
  });

  it('agent mode + executionBoundary', () => {
    expect(
      buildSystemPrompt({
        agentMode: 'agent',
        tools: FIXED_TOOLS,
        runtimeIdentity: FIXED_RUNTIME_IDENTITY,
        executionBoundary: {
          yoloMode: false,
          workspacePaths: ['/home/user/proj'],
        },
      }),
    ).toMatchSnapshot();
  });

  it('Daemon 路径模拟（缺 cliReference / enabledApps / spaceName）', () => {
    // 模拟 Daemon 不传这些字段的形态
    expect(
      buildSystemPrompt({
        agentMode: 'agent',
        tools: FIXED_TOOLS,
        runtimeIdentity: {
          spaceId: 'space-uuid-only',
          organizationId: 'organization-uuid-only',
          threadId: 'session-uuid-only',
          workspaceRoot: '/daemon/workspace',
          archiveDir: '/daemon/archive',
          toolLogsDir: '/daemon/tool-logs',
        },
        // 故意不传 enabledApps / cliReference / spaceName / organizationName
      }),
    ).toMatchSnapshot();
  });
});
