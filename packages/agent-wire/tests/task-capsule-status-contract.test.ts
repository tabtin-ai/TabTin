/**
 * TaskCapsule 跨端状态投影契约测试（TS 端）
 *
 * 消费 `cross-lang-fixtures/task-capsule-status-v1.json`，断言：
 * 1. `@tabtin/contracts` SSOT（resolveTaskCapsuleStatus / Visual）与 fixture 一致
 * 2. FocusSnapshot schema 最小约束（大小 / 深度 / 无正文）成立
 *
 * iOS / Android 后续各自消费同一 fixture；本文件是 TS 锚点。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FOCUS_SNAPSHOT_LIMITS,
  FocusSnapshotSchema,
  resolveTaskCapsuleStatus,
  resolveTaskCapsuleVisual,
  TASK_CAPSULE_STATUS_KEYS,
  type TaskCapsuleStatusInput,
  type TaskCapsuleStatusKind,
  type TaskCapsuleVisualKind,
} from '@tabtin/contracts/agent';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface ContractCase {
  name: string;
  input: TaskCapsuleStatusInput;
  expected_status: TaskCapsuleStatusKind;
  expected_visual: TaskCapsuleVisualKind;
  notes?: string;
}

interface ContractFixture {
  _doc: string;
  spec_version: string;
  ssot_anchor: string;
  cases: ContractCase[];
}

const FIXTURE_PATH = join(
  __dirname,
  '..',
  'src',
  'cross-lang-fixtures',
  'task-capsule-status-v1.json',
);

const fixture: ContractFixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

describe('TaskCapsule status 跨语言契约（TS SSOT）', () => {
  it('fixture 自身格式正确', () => {
    expect(fixture.spec_version).toBe('v1');
    expect(fixture.ssot_anchor).toContain('task-capsule-status-v1.json');
    expect(fixture.cases.length).toBeGreaterThanOrEqual(8);
    expect(TASK_CAPSULE_STATUS_KEYS).toContain('paused');
  });

  it.each(fixture.cases)(
    'case "$name" · resolveTaskCapsuleStatus 与 fixture expected_status 一致',
    ({ input, expected_status }) => {
      expect(resolveTaskCapsuleStatus(input)).toBe(expected_status);
    },
  );

  it.each(fixture.cases)(
    'case "$name" · resolveTaskCapsuleVisual 与 fixture expected_visual 一致',
    ({ expected_status, expected_visual }) => {
      expect(resolveTaskCapsuleVisual(expected_status)).toBe(expected_visual);
    },
  );

  it('paused 优先于 busy，且不是 stopped / recovering', () => {
    expect(
      resolveTaskCapsuleStatus({
        busy: true,
        runPhase: 'tool_calls',
        paused: true,
      }),
    ).toBe('paused');
    expect(
      resolveTaskCapsuleStatus({
        busy: false,
        paused: true,
        suspended: true,
      }),
    ).toBe('paused');
  });

  it('视觉决策：仅 ready → mini；paused / complete → full', () => {
    expect(resolveTaskCapsuleVisual('ready')).toBe('mini');
    expect(resolveTaskCapsuleVisual('paused')).toBe('full');
    expect(resolveTaskCapsuleVisual('complete')).toBe('full');
  });
});

describe('FocusSnapshot schema 最小约束', () => {
  it('接受 camelCase 焦点快照（含 snake 兼容 tab 子字段）', () => {
    const parsed = FocusSnapshotSchema.parse({
      appType: 'tabdoc',
      appMeta: { title: '规格草案', resource_id: 'doc_1' },
      openTabs: [
        {
          type: 'tabdoc',
          id: 'doc_1',
          title: '规格草案',
          active: true,
          app_key: 'tabdoc',
          display_name: '文档',
        },
        {
          type: 'tabdata',
          id: 'tbl_2',
          title: '需求表',
          active: false,
          group_id: 'g1',
        },
      ],
      spaceId: 'space_1',
      userTimeZone: 'Asia/Shanghai',
      workspaceMode: 'desktop',
    });
    expect(parsed.appType).toBe('tabdoc');
    expect(parsed.openTabs).toHaveLength(2);
  });

  it('拒绝超过 openTabs 上限', () => {
    const tabs = Array.from(
      { length: FOCUS_SNAPSHOT_LIMITS.MAX_OPEN_TABS + 1 },
      (_, i) => ({ type: 'tabdoc', id: `doc_${i}` }),
    );
    expect(FocusSnapshotSchema.safeParse({ openTabs: tabs }).success).toBe(false);
  });

  it('拒绝 appMeta 正文键与过深嵌套', () => {
    expect(
      FocusSnapshotSchema.safeParse({
        appType: 'tabdoc',
        appMeta: { content: '全文正文不应进入自动上下文' },
      }).success,
    ).toBe(false);

    expect(
      FocusSnapshotSchema.safeParse({
        appType: 'tabdoc',
        appMeta: { a: { b: { c: { d: 'too-deep' } } } },
      }).success,
    ).toBe(false);
  });
});
