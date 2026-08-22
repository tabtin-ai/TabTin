import { describe, it, expect } from 'vitest';
import { nextArrivalSeq } from '../src/event/event-emitter.js';

describe('nextArrivalSeq ( 块级时间线抵达序号)', () => {
  it('严格单调递增,即便同一毫秒内多次调用', () => {
    const seqs = Array.from({ length: 1000 }, () => nextArrivalSeq());
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  it('微秒尺度,落在 JS Number 安全整数(9e15)内', () => {
    const seq = nextArrivalSeq();
    expect(seq).toBeGreaterThan(1_000_000_000_000_000); // > 1e15(微秒级)
    expect(seq).toBeLessThan(Number.MAX_SAFE_INTEGER); // < 9.007e15
  });
});
