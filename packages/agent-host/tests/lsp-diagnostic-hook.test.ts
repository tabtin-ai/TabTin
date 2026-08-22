/**
 * LSP Diagnostic Injector Hook 单测 —— 覆盖 C9 / C10 / C11。
 *
 * C9：注入格式正确（双层 wrap + isMeta marker + format symbol + Line l+1:c+1）
 * C10：守门员（hasShellTool false 不注入）
 * C11：sub-agent（isMainThread false 不注入）
 *
 * + 通用：
 *   - 没诊断时清旧 marker 但不注入
 *   - 上一轮 marker message 自动 filter（防止堆积）
 *   - 4000 字符 cap
 *   - 取出后 pending 被清空
 *   - registry 异常不阻塞 LLM
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerPendingLSPDiagnostic,
  resetAllLSPDiagnosticState,
  getPendingLSPDiagnosticCount,
  type Diagnostic,
} from '@tabtin/lsp-runtime';
import { buildLspDiagnosticHook } from '../src/hooks/index.js';
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  type Message,
  type EngineState,
} from '@tabtin/agent-runtime/engine';

const LSP_MARKER = INTERNAL_MESSAGE_MARKERS.LSP_DIAGNOSTICS_INJECTION;

function makeState(messages: Message[] = []): EngineState {
  return {
    messages,
    iteration: 0,
    pendingThinking: [],
    pendingToolUses: [],
  } as unknown as EngineState;
}

function makeDiagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    message: 'something broke',
    severity: 'Error',
    range: {
      start: { line: 9, character: 4 }, // 0-based → 渲染为 Line 10:5
      end: { line: 9, character: 10 },
    },
    source: 'typescript',
    code: 'TS2322',
    ...overrides,
  };
}

describe('buildLspDiagnosticHook', () => {
  beforeEach(() => {
    resetAllLSPDiagnosticState();
  });

  it('C9: 注入格式 — 双层 wrap + symbol + Line l+1:c+1 + code + source', async () => {
    registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [
        {
          uri: 'file:///path/to/foo.ts',
          diagnostics: [makeDiagnostic()],
        },
      ],
    });

    const hook = buildLspDiagnosticHook({ hasShellTool: () => true });
    const state = makeState();
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    expect(state.messages).toHaveLength(1);
    const injected = state.messages[0]!;
    expect(injected.role).toBe('system');
    expect(hasInternalMarker(injected, LSP_MARKER)).toBe(true);

    const text = (injected.content as Array<{ text: string }>)[0]!.text;
    // 阶段 6 议题 2：外层套统一 `<context type="lsp-diagnostic">` SSoT wrapper
    expect(text).toMatch(/^<context type="lsp-diagnostic">/);
    expect(text).toMatch(/<\/context>$/);
    // 内层 system-reminder + new-diagnostics 双层 wrap 保留
    expect(text).toContain('<system-reminder>');
    expect(text).toContain('</system-reminder>');
    expect(text).toContain('<new-diagnostics>');
    expect(text).toContain('</new-diagnostics>');
    // 引导文案
    expect(text).toContain('检测到以下新的诊断问题');
    // 基础名 only
    expect(text).toContain('foo.ts:');
    expect(text).not.toContain('/path/to/foo.ts:');
    // 格式：symbol + [行 l+1:c+1] message [code] (source)
    expect(text).toContain('✗ [行 10:5] something broke [TS2322] (typescript)');
  });

  it('C9: 多文件按文件分组', async () => {
    registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [
        {
          uri: 'file:///a.ts',
          diagnostics: [makeDiagnostic({ message: 'err in a' })],
        },
        {
          uri: 'file:///b.ts',
          diagnostics: [makeDiagnostic({ message: 'err in b' })],
        },
      ],
    });

    const hook = buildLspDiagnosticHook({ hasShellTool: () => true });
    const state = makeState();
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    const text = (state.messages[0]!.content as Array<{ text: string }>)[0]!
      .text;
    expect(text).toContain('a.ts:');
    expect(text).toContain('b.ts:');
    expect(text).toContain('err in a');
    expect(text).toContain('err in b');
  });

  it('C10 守门员: hasShellTool 返回 false → 不注入', async () => {
    registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [
        { uri: 'file:///foo.ts', diagnostics: [makeDiagnostic()] },
      ],
    });

    const hook = buildLspDiagnosticHook({ hasShellTool: () => false });
    const state = makeState();
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    expect(state.messages).toHaveLength(0);
    // pending 不应该被消费（守门员拦截 → diagnostic 留着等下次有 shell 工具时再发）
    expect(getPendingLSPDiagnosticCount()).toBe(1);
  });

  it('C10 守门员: hasShellTool 抛错 → 保守不注入', async () => {
    registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [
        { uri: 'file:///foo.ts', diagnostics: [makeDiagnostic()] },
      ],
    });

    const hook = buildLspDiagnosticHook({
      hasShellTool: () => {
        throw new Error('white list resolve error');
      },
    });
    const state = makeState();
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    expect(state.messages).toHaveLength(0);
  });

  it('C11 sub-agent: isMainThread = false → 不注入', async () => {
    registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [
        { uri: 'file:///foo.ts', diagnostics: [makeDiagnostic()] },
      ],
    });

    const hook = buildLspDiagnosticHook({
      hasShellTool: () => true,
      isMainThread: false,
    });
    const state = makeState();
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    expect(state.messages).toHaveLength(0);
    // sub-agent 不消费 pending（让 main thread 处理）
    expect(getPendingLSPDiagnosticCount()).toBe(1);
  });

  it('C11 sub-agent: isMainThread 缺省 → true（main thread 默认行为）', async () => {
    registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [
        { uri: 'file:///foo.ts', diagnostics: [makeDiagnostic()] },
      ],
    });

    const hook = buildLspDiagnosticHook({ hasShellTool: () => true });
    const state = makeState();
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    expect(state.messages).toHaveLength(1);
  });

  it('没诊断: 清旧 marker 但不注入新的', async () => {
    // 模拟上一轮注入的 LSP marker message
    const oldDiagnosticMessage: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'old diagnostic' }],
      [LSP_MARKER]: true,
    } as unknown as Message;

    const hook = buildLspDiagnosticHook({ hasShellTool: () => true });
    const state = makeState([oldDiagnosticMessage]);
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    // 上一轮 LSP marker message 被清掉，没新诊断注入
    expect(state.messages).toHaveLength(0);
  });

  it('上一轮 marker message 自动 filter（防止堆积）', async () => {
    const oldMessage: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'turn 1 diagnostic' }],
      [LSP_MARKER]: true,
    } as unknown as Message;
    const userMessage: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'normal user msg' }],
    };

    registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [
        {
          uri: 'file:///foo.ts',
          diagnostics: [makeDiagnostic({ message: 'turn 2 diagnostic' })],
        },
      ],
    });

    const hook = buildLspDiagnosticHook({ hasShellTool: () => true });
    const state = makeState([oldMessage, userMessage]);
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    // 旧 LSP marker 被清，普通 user msg 保留，新 LSP marker 注入到末尾
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toBe(userMessage); // 普通 msg 保留
    const newInjected = state.messages[1]!;
    expect(hasInternalMarker(newInjected, LSP_MARKER)).toBe(true);
    expect(
      (newInjected.content as Array<{ text: string }>)[0]!.text,
    ).toContain('turn 2 diagnostic');
  });

  it('4000 字符 cap：超长 truncated', async () => {
    // 构造 11 个文件，每个 10 条诊断，每条 message ~50 chars → 5500+ chars
    // 注：MAX_DIAGNOSTICS_PER_FILE=10 / MAX_TOTAL_DIAGNOSTICS=30 已经在
    // registry 内限流；这里需要绕过 registry 直接构造 dedupe 后的形态
    const longFiles = Array.from({ length: 11 }, (_, i) => ({
      uri: `file:///very-long-path-foo-${i}.ts`,
      diagnostics: Array.from({ length: 10 }, (_, j) =>
        makeDiagnostic({
          message: `this is a long diagnostic message number ${j} in file ${i} that takes up some space`,
        }),
      ),
    }));

    registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: longFiles,
    });

    const hook = buildLspDiagnosticHook({ hasShellTool: () => true });
    const state = makeState();
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    // registry 会限流到 30 条 total，再 cap 4000 chars。这里验证至少 cap 生效
    const text = (state.messages[0]!.content as Array<{ text: string }>)[0]!
      .text;
    // text 包括 wrap 头尾，summary 部分本身 cap 4000；总 text 长度应该 <
    // 4000 + wrap 头尾约 100 chars
    expect(text.length).toBeLessThan(4500);
  });

  it('取出后 registry pending 被清空', async () => {
    registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [
        { uri: 'file:///foo.ts', diagnostics: [makeDiagnostic()] },
      ],
    });
    expect(getPendingLSPDiagnosticCount()).toBe(1);

    const hook = buildLspDiagnosticHook({ hasShellTool: () => true });
    const state = makeState();
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    expect(getPendingLSPDiagnosticCount()).toBe(0);
  });

  it('严重度符号: Error=✗, Warning=⚠, Info=ℹ, Hint=★', async () => {
    registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [
        {
          uri: 'file:///foo.ts',
          diagnostics: [
            makeDiagnostic({ message: 'err', severity: 'Error' }),
            makeDiagnostic({ message: 'warn', severity: 'Warning' }),
            makeDiagnostic({ message: 'info', severity: 'Info' }),
            makeDiagnostic({ message: 'hint', severity: 'Hint' }),
          ],
        },
      ],
    });

    const hook = buildLspDiagnosticHook({ hasShellTool: () => true });
    const state = makeState();
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    const text = (state.messages[0]!.content as Array<{ text: string }>)[0]!
      .text;
    expect(text).toContain('✗ [行 10:5] err');
    expect(text).toContain('⚠ [行 10:5] warn');
    expect(text).toContain('ℹ [行 10:5] info');
    expect(text).toContain('★ [行 10:5] hint');
  });

  it('code / source 缺省时不显示对应段', async () => {
    registerPendingLSPDiagnostic({
      serverName: 'typescript',
      files: [
        {
          uri: 'file:///foo.ts',
          diagnostics: [
            { ...makeDiagnostic(), code: undefined, source: undefined },
          ],
        },
      ],
    });

    const hook = buildLspDiagnosticHook({ hasShellTool: () => true });
    const state = makeState();
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    const text = (state.messages[0]!.content as Array<{ text: string }>)[0]!
      .text;
    // 不应有 `[xxx]` 或 `(xxx)` 后缀
    expect(text).toContain('✗ [行 10:5] something broke');
    expect(text).not.toMatch(/something broke \[/);
    expect(text).not.toMatch(/something broke.* \(/);
  });
});
