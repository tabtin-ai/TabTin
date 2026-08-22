import {
  formatDateCellValue,
  formatDateTimeCellValue,
  formatFieldDisplayValue,
  normalizeDateCellValue,
} from '../cellValueUtils'

describe('date formatting helpers', () => {
  it('formats date fields with 24-hour time configuration', () => {
    expect(
      formatDateCellValue('2026-03-07T19:22:00Z', {
        date: 'YYYY-MM-DD',
        time: 'HH:mm',
        timeZone: 'America/New_York',
      })
    ).toBe('2026-03-07 14:22')
  })

  it('formats date fields with 12-hour time configuration', () => {
    expect(
      formatDateTimeCellValue('2026-03-07T19:22:00Z', {
        date: 'YYYY-MM-DD',
        time: 'hh:mm A',
        timeZone: 'America/New_York',
      })
    ).toBe('2026-03-07 02:22 PM')
  })

  it('formats date fields with seconds when configured', () => {
    expect(
      formatDateTimeCellValue('2026-03-07T19:22:33Z', {
        date: 'YYYY-MM-DD',
        time: 'HH:mm:ss',
        timeZone: 'America/New_York',
      })
    ).toBe('2026-03-07 14:22:33')
  })

  it('shows midnight time for legacy date-only date values', () => {
    expect(
      formatDateCellValue('2026-08-09', {
        date: 'YYYY-MM-DD',
        time: 'HH:mm:ss',
        timeZone: 'Asia/Shanghai',
      })
    ).toBe('2026-08-09 00:00:00')
  })

  it('normalizes date-only edits into legacy date storage', () => {
    expect(
      normalizeDateCellValue('2026-08-09', 'date', 'Asia/Shanghai')
    ).toEqual({
      value: '2026-08-09',
      isValid: true,
    })
  })

  it('preserves timestamp values for date fields when the value carries time', () => {
    expect(
      normalizeDateCellValue('2026-08-09T03:22:33.000Z', 'date', 'Asia/Shanghai')
    ).toEqual({
      value: '2026-08-09T03:22:33.000Z',
      isValid: true,
    })
  })

  it('preserves timestamp edits for date fields when time formatting is enabled', () => {
    expect(
      normalizeDateCellValue('2026-08-09T03:22:33.000Z', 'date', 'Asia/Shanghai', true)
    ).toEqual({
      value: '2026-08-09T03:22:33.000Z',
      isValid: true,
    })
  })

  it('formats readonly date values with field formatting', () => {
    expect(
      formatFieldDisplayValue(
        '2026-03-07',
        {
          field_type: 'date',
          options: {
            formatting: {
              date: 'D/M/YYYY',
              time: 'None',
              timeZone: 'Asia/Shanghai',
            },
          },
        },
        { emptyLabel: '-' }
      )
    ).toBe('7/3/2026')
  })
})
