import { describe, expect, it } from 'vitest';
import { deriveBillingIdempotencyKey } from '../src/engine/core/llm-request-builder.js';

describe('Agent LLM billing idempotency', () => {
  it('同一 Agent 任务重放时派生相同计费键', () => {
    const firstRun = deriveBillingIdempotencyKey('job-1', '_main_chat', 0);
    const retriedRun = deriveBillingIdempotencyKey('job-1', '_main_chat', 0);

    expect(retriedRun).toBe(firstRun);
  });

  it('同一任务内不同合法模型调用使用不同计费键', () => {
    expect(deriveBillingIdempotencyKey('job-1', '_main_chat', 1)).not.toBe(
      deriveBillingIdempotencyKey('job-1', '_main_chat', 0),
    );
  });

  it('主调用、compact、summary 与子 Agent 使用互不冲突的键空间', () => {
    const main = deriveBillingIdempotencyKey('job-1', '_main_chat', 0);
    const compact = deriveBillingIdempotencyKey('job-1', '_compact', 0);
    const summary = deriveBillingIdempotencyKey('job-1', '_summary', 0);
    const subagent = deriveBillingIdempotencyKey(
      'job-1:subagent:child-1',
      '_sub_agent',
      0,
    );
    const nestedSubagent = deriveBillingIdempotencyKey(
      'job-1:subagent:child-1:subagent:child-2',
      '_sub_agent',
      0,
    );

    expect(new Set([
      main,
      compact,
      summary,
      subagent,
      nestedSubagent,
    ])).toHaveLength(5);
  });

  it('nested SubAgent 重放时保持稳定计费键', () => {
    const firstRun = deriveBillingIdempotencyKey(
      'job-1:subagent:child-1:subagent:child-2',
      '_sub_agent',
      3,
    );
    const retriedRun = deriveBillingIdempotencyKey(
      'job-1:subagent:child-1:subagent:child-2',
      '_sub_agent',
      3,
    );

    expect(retriedRun).toBe(firstRun);
  });
});
