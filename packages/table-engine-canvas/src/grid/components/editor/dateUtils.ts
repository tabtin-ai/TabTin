import {
  formatDateStoredValue,
  normalizeDateFieldFormatting,
  type DateFieldOptionsLike,
  type ResolvedDateFormatting,
} from '@tabtin/smartsheet-ui';
import { fromZonedTime } from 'date-fns-tz';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';

dayjs.extend(customParseFormat);

const DEFAULT_DATETIME_FORMATTING: ResolvedDateFormatting = {
  date: 'YYYY-MM-DD',
  time: 'HH:mm',
  timeZone: (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  })(),
};

type DateTimeDisplayFormat = ResolvedDateFormatting['time'];

const normalizeTimeFormatting = (value: unknown): DateTimeDisplayFormat => {
  if (
    value === 'HH:mm' ||
    value === 'HH:mm:ss' ||
    value === 'hh:mm A' ||
    value === 'hh:mm:ss A' ||
    value === 'None'
  ) {
    return value;
  }
  return DEFAULT_DATETIME_FORMATTING.time;
};

export const resolveDatetimeFormatting = (
  options?: DateFieldOptionsLike | null,
): ResolvedDateFormatting => {
  const baseFormatting = options?.formatting;
  const normalizedTime = normalizeTimeFormatting(baseFormatting?.time);

  return normalizeDateFieldFormatting(
    {
      date: baseFormatting?.date ?? DEFAULT_DATETIME_FORMATTING.date,
      time: normalizedTime,
      timeZone: baseFormatting?.timeZone ?? DEFAULT_DATETIME_FORMATTING.timeZone,
    },
    normalizedTime === 'None'
  );
};

export const buildDateInputPlaceholder = (formatting: ResolvedDateFormatting): string => {
  const { date, time } = formatting;
  if (time === 'None') {
    return date;
  }
  return `${date} ${time}`;
};

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const formatDisplayValue = (value: string, formatting: ResolvedDateFormatting): string => {
  if (!value) return '';
  if (DATE_ONLY_RE.test(value.trim())) {
    return dayjs(value).isValid() ? formatDateStoredValue(value, formatting) : '';
  }
  return dayjs(value).isValid() ? formatDateStoredValue(value, formatting) : '';
};

export const convertZonedInputToUtc = (
  inputValue: string,
  formatting: ResolvedDateFormatting
): string | null => {
  const { date: dateFormatting, time: timeFormatting, timeZone } = formatting;
  const isTimeNone = timeFormatting === 'None';
  const normalizedDateFormatting = normalizeDateFieldFormatting(
    { date: dateFormatting, time: timeFormatting, timeZone },
    isTimeNone
  ).date;
  const parseFormats = isTimeNone
    ? [normalizedDateFormatting]
    : [`${normalizedDateFormatting} ${timeFormatting}`, normalizedDateFormatting];
  let currentDate = dayjs(inputValue.trim(), parseFormats);

  if (!currentDate.isValid()) {
    return null;
  }

  if (isTimeNone) {
    return currentDate.format('YYYY-MM-DD');
  }

  const zonedDate = currentDate.toDate();
  const utcDate = fromZonedTime(zonedDate, timeZone);
  return utcDate.toISOString();
};
