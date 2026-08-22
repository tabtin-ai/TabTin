/**
 * H1-E: MTTR 辅助函数单测。
 *
 * 验收点：
 *   - emitMttrStart / emitMttrResolved 生成符合规范的 TelemetryRecord
 *   - generateIncidentId 产出 `inc-YYYYMMDD-HHmmss-xxxx` 形式
 *   - resolution / description 不会因为巨大字符串把 record 撑爆（由调用层截断）
 *   - 不包含敏感用户数据
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  emitMttrStart,
  emitMttrResolved,
  generateIncidentId,
  setTelemetrySink,
  resetTelemetrySink,
  TelemetryEvents,
  type TelemetryRecord,
} from '../src/telemetry/index.js';

describe('mttr helpers', () => {
  let captured: TelemetryRecord[];

  beforeEach(() => {
    resetTelemetrySink();
    captured = [];
    setTelemetrySink((r) => captured.push(r));
  });

  it('generateIncidentId 形如 inc-YYYYMMDD-HHmmss-xxxx', () => {
    const id = generateIncidentId(new Date(2026, 3, 17, 9, 5, 3));
    // 月份是 0-based，所以 3 = 4 月
    expect(id).toMatch(/^inc-20260417-090503-[0-9a-f]{4}$/);
  });

  it('emitMttrStart 生成 mttr.start 事件', () => {
    emitMttrStart({
      incident_id: 'inc-test-1',
      description: 'Agent stuck in tool loop',
      reporter: 'on-call',
      session_id: 's-123',
      severity: 'p1',
    });

    expect(captured).toHaveLength(1);
    const rec = captured[0]!;
    expect(rec.event_name).toBe(TelemetryEvents.MTTR_START);
    expect(rec.session_id).toBe('s-123');
    expect(rec.payload).toEqual({
      incident_id: 'inc-test-1',
      description: 'Agent stuck in tool loop',
      reporter: 'on-call',
      severity: 'p1',
    });
  });

  it('emitMttrResolved 生成 mttr.resolved 事件并带 duration_ms', () => {
    emitMttrResolved({
      incident_id: 'inc-test-1',
      resolution: 'Increased warnThreshold from 5 to 7',
      duration_ms: 1_450_000,
      resolver: 'harness',
      session_id: 's-123',
      error_class: 'LLM_ERROR',
    });

    expect(captured[0]).toMatchObject({
      event_name: TelemetryEvents.MTTR_RESOLVED,
      session_id: 's-123',
      payload: {
        incident_id: 'inc-test-1',
        resolution: 'Increased warnThreshold from 5 to 7',
        duration_ms: 1_450_000,
        resolver: 'harness',
        error_class: 'LLM_ERROR',
      },
    });
  });

  it('emitMttrStart/resolved 可配对还原 incident 生命周期', () => {
    const incidentId = 'inc-pair-1';
    emitMttrStart({ incident_id: incidentId, description: 'api 400 burst' });
    // 模拟处置耗时
    emitMttrResolved({
      incident_id: incidentId,
      resolution: 'Fixed normalization',
      duration_ms: 60_000,
    });

    const starts = captured.filter((r) => r.event_name === TelemetryEvents.MTTR_START);
    const ends = captured.filter((r) => r.event_name === TelemetryEvents.MTTR_RESOLVED);
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(
      (starts[0]?.payload as { incident_id: string }).incident_id,
    ).toBe((ends[0]?.payload as { incident_id: string }).incident_id);
  });

  // ── 程序内直接调用的长度防线（Review #8 补齐）───────────────────

  it('emitMttrStart 对超长 description / reporter / severity 强制截断', () => {
    const longDescription = 'x'.repeat(500);
    const longReporter = 'team-ops-'.repeat(20); // 180 字符
    const longSeverity = 'super-critical-overflow';

    emitMttrStart({
      incident_id: 'inc-trunc-1',
      description: longDescription,
      reporter: longReporter,
      severity: longSeverity,
    });

    const p = captured[0]!.payload as Record<string, unknown>;
    expect((p.description as string).length).toBe(200);
    expect((p.description as string).startsWith('x')).toBe(true);
    expect((p.reporter as string).length).toBeLessThanOrEqual(80);
    expect((p.severity as string).length).toBeLessThanOrEqual(16);
  });

  it('emitMttrResolved 对超长 resolution / resolver / error_class 强制截断', () => {
    const longResolution = 'y'.repeat(900);
    const longResolver = 'r'.repeat(200);
    const longErrorClass = 'z'.repeat(200);

    emitMttrResolved({
      incident_id: 'inc-trunc-2',
      resolution: longResolution,
      resolver: longResolver,
      error_class: longErrorClass,
      duration_ms: 100,
    });

    const p = captured[0]!.payload as Record<string, unknown>;
    expect((p.resolution as string).length).toBe(400);
    expect((p.resolver as string).length).toBe(80);
    expect((p.error_class as string).length).toBe(80);
    expect(p.duration_ms).toBe(100);
  });
});
