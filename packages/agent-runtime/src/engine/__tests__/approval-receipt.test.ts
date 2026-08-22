/**
 * approval-receipt.test.ts —  审批回执纯函数契约。
 *
 * 覆盖回执文案（用户批准 / memo 自动放行）与前置行为
 * （string / ContentBlock[] / llmContextContent / 空内容）。
 */

import { describe, it, expect } from 'vitest';
import {
  buildApprovalReceiptText,
  prependApprovalReceiptToResult,
} from '../tooling/approval-receipt.js';
import type { ToolResult } from '../contracts/tools.js';

describe('#4760 buildApprovalReceiptText', () => {
  it('用户批准 → 与 deny 对称的英文回执，含工具名', () => {
    const text = buildApprovalReceiptText('run_terminal_command', { source: 'user_approval' });
    expect(text).toContain('<approval_note>');
    expect(text).toContain("User approved tool 'run_terminal_command'.");
    expect(text).toContain('</approval_note>');
  });

  it('memo 自动放行 → 「always allow」英文回执', () => {
    const text = buildApprovalReceiptText('write_file', { source: 'memo' });
    expect(text).toContain('auto-approved');
    expect(text).toContain('always allow');
    expect(text).toContain("write_file");
  });
});

describe('#4760 prependApprovalReceiptToResult', () => {
  const receipt = "<approval_note>\nUser approved tool 't'.\n</approval_note>";

  it('string content → 回执 + 空行 + 原文', () => {
    const result: ToolResult = { content: '原始输出', isError: false };
    const out = prependApprovalReceiptToResult(result, receipt);
    expect(out.content).toBe(`${receipt}\n\n原始输出`);
    expect(out.isError).toBe(false);
  });

  it('空 string content → 仅回执，不带多余空行', () => {
    const result: ToolResult = { content: '', isError: false };
    const out = prependApprovalReceiptToResult(result, receipt);
    expect(out.content).toBe(receipt);
  });

  it('ContentBlock[] content → 前置一个 text 块，原块保留', () => {
    const result: ToolResult = {
      content: [{ type: 'text', text: '原始' }],
      isError: false,
    };
    const out = prependApprovalReceiptToResult(result, receipt);
    expect(Array.isArray(out.content)).toBe(true);
    const blocks = out.content as Array<{ type: string; text: string }>;
    expect(blocks[0]).toEqual({ type: 'text', text: receipt });
    expect(blocks[1]).toEqual({ type: 'text', text: '原始' });
  });

  it('存在 llmContextContent 时同步前置（避免 shell slim 路径丢回执）', () => {
    const result: ToolResult = {
      content: '完整输出',
      llmContextContent: 'slim 输出',
      isError: false,
    };
    const out = prependApprovalReceiptToResult(result, receipt);
    expect(out.content).toBe(`${receipt}\n\n完整输出`);
    expect(out.llmContextContent).toBe(`${receipt}\n\nslim 输出`);
  });

  it('无 llmContextContent 时不凭空造出该字段', () => {
    const result: ToolResult = { content: 'x', isError: false };
    const out = prependApprovalReceiptToResult(result, receipt);
    expect('llmContextContent' in out).toBe(false);
  });
});
