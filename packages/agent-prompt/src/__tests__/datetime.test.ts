import { describe, expect, it } from 'vitest';
import { formatAgentDatetime } from '../datetime.js';

describe('formatAgentDatetime', () => {
  it('renders an instant in the user device timezone with explicit offset', () => {
    // 这正是原 bug 场景：UTC 看着是 5/30 23:33，UTC+8 本地其实是 5/31 07:33。
    expect(formatAgentDatetime('2026-05-30T23:33:24.748Z', 'Asia/Shanghai'))
      .toBe('2026-05-31 07:33 (UTC+8)');
  });

  it('crosses the date line correctly for negative offsets', () => {
    // UTC 5/31 02:00 → 纽约（UTC-4 夏令时）还是 5/30 22:00。
    expect(formatAgentDatetime('2026-05-31T02:00:00Z', 'America/New_York'))
      .toBe('2026-05-30 22:00 (UTC-4)');
  });

  it('supports half-hour offsets', () => {
    // 印度 UTC+5:30。
    expect(formatAgentDatetime('2026-05-30T23:33:00Z', 'Asia/Kolkata'))
      .toBe('2026-05-31 05:03 (UTC+5:30)');
  });

  it('falls back to UTC when timezone is missing', () => {
    expect(formatAgentDatetime('2026-05-30T23:33:24.748Z'))
      .toBe('2026-05-30 23:33 (UTC+0)');
  });

  it('falls back to UTC when timezone is invalid', () => {
    expect(formatAgentDatetime('2026-05-30T23:33:24.748Z', 'Not/AZone'))
      .toBe('2026-05-30 23:33 (UTC+0)');
  });

  it('truncates to minute precision (prefix-cache stability)', () => {
    // 同一分钟内不同秒/毫秒 → 输出 byte-identical。
    const a = formatAgentDatetime('2026-05-30T23:33:01.000Z', 'Asia/Shanghai');
    const b = formatAgentDatetime('2026-05-30T23:33:59.999Z', 'Asia/Shanghai');
    expect(a).toBe(b);
    expect(a).toBe('2026-05-31 07:33 (UTC+8)');
  });

  it('returns empty string for empty input', () => {
    expect(formatAgentDatetime('')).toBe('');
    expect(formatAgentDatetime(null)).toBe('');
    expect(formatAgentDatetime(undefined)).toBe('');
  });

  it('returns the raw value unchanged when unparseable', () => {
    expect(formatAgentDatetime('not-a-date', 'Asia/Shanghai')).toBe('not-a-date');
  });
});
