import { describe, expect, it } from 'vitest';

import { convertZonedInputToUtc, formatDisplayValue, resolveDatetimeFormatting } from './dateUtils';

describe('grid date editor display formatting', () => {
  it('shows midnight time for date-only values when date fields enable time display', () => {
    const formatting = resolveDatetimeFormatting({
      formatting: {
        date: 'YYYY-MM-DD',
        time: 'HH:mm:ss',
        timeZone: 'Asia/Shanghai',
      },
    });

    expect(formatDisplayValue('2026-08-09', formatting)).toBe('2026-08-09 00:00:00');
  });

  it('stores date-only text input as the legacy date format when time is disabled', () => {
    const formatting = resolveDatetimeFormatting({
      formatting: {
        date: 'YYYY-MM-DD',
        time: 'None',
        timeZone: 'Asia/Shanghai',
      },
    });

    expect(convertZonedInputToUtc('2026-08-09', formatting)).toBe('2026-08-09');
  });
});
