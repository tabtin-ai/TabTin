export enum StatFunc {
  None = 'none',
  Count = 'count',
  Empty = 'empty',
  Filled = 'filled',
  Unique = 'unique',
  Sum = 'sum',
  Average = 'average',
  Min = 'min',
  Max = 'max',
  Checked = 'checked',
  Unchecked = 'unchecked',
  PercentEmpty = 'percent_empty',
  PercentFilled = 'percent_filled',
  PercentUnique = 'percent_unique',
  PercentChecked = 'percent_checked',
  PercentUnchecked = 'percent_unchecked',
  EarliestDate = 'earliest_date',
  LatestDate = 'latest_date',
  DateRangeOfDays = 'date_range_days',
  DateRangeOfMonths = 'date_range_months',
}

export function getValidStatFuncs(fieldType: string): StatFunc[] {
  const normalizedType = fieldType.trim().toLowerCase()
  const numberTypes = new Set([
    'number', 'currency', 'percent', 'count',
  ])
  const dateTypes = new Set([
    'date', 'created_time', 'last_modified_time',
  ])
  const booleanTypes = new Set(['checkbox', 'boolean'])
  const userTypes = new Set(['user', 'created_by', 'last_modified_by'])

  if (numberTypes.has(normalizedType)) {
    return [
      StatFunc.Sum,
      StatFunc.Average,
      StatFunc.Min,
      StatFunc.Max,
      StatFunc.Count,
      StatFunc.Empty,
      StatFunc.Filled,
      StatFunc.Unique,
      StatFunc.PercentEmpty,
      StatFunc.PercentFilled,
      StatFunc.PercentUnique,
    ]
  }

  if (dateTypes.has(normalizedType)) {
    return [
      StatFunc.Count,
      StatFunc.Empty,
      StatFunc.Filled,
      StatFunc.Unique,
      StatFunc.EarliestDate,
      StatFunc.LatestDate,
      StatFunc.DateRangeOfDays,
      StatFunc.DateRangeOfMonths,
      StatFunc.PercentEmpty,
      StatFunc.PercentFilled,
      StatFunc.PercentUnique,
    ]
  }

  if (booleanTypes.has(normalizedType)) {
    return [
      StatFunc.Count,
      StatFunc.Checked,
      StatFunc.Unchecked,
      StatFunc.PercentChecked,
      StatFunc.PercentUnchecked,
    ]
  }

  if (userTypes.has(normalizedType)) {
    return [
      StatFunc.Count,
      StatFunc.Empty,
      StatFunc.Filled,
      StatFunc.PercentEmpty,
      StatFunc.PercentFilled,
    ]
  }

  if (normalizedType === 'attachment') {
    return [
      StatFunc.Count,
      StatFunc.Empty,
      StatFunc.Filled,
      StatFunc.PercentEmpty,
      StatFunc.PercentFilled,
    ]
  }

  return [
    StatFunc.Count,
    StatFunc.Empty,
    StatFunc.Filled,
    StatFunc.Unique,
    StatFunc.PercentEmpty,
    StatFunc.PercentFilled,
    StatFunc.PercentUnique,
  ]
}

export interface StatisticMenuLabels {
  none?: string
  [key: string]: string | undefined
}

export const defaultStatLabels: Record<string, string> = {
  [StatFunc.None]: 'None',
  [StatFunc.Count]: 'Count',
  [StatFunc.Empty]: 'Empty',
  [StatFunc.Filled]: 'Filled',
  [StatFunc.Unique]: 'Unique',
  [StatFunc.Sum]: 'Sum',
  [StatFunc.Average]: 'Average',
  [StatFunc.Min]: 'Min',
  [StatFunc.Max]: 'Max',
  [StatFunc.Checked]: 'Checked',
  [StatFunc.Unchecked]: 'Unchecked',
  [StatFunc.PercentEmpty]: 'Percent empty',
  [StatFunc.PercentFilled]: 'Percent filled',
  [StatFunc.PercentUnique]: 'Percent unique',
  [StatFunc.PercentChecked]: 'Percent checked',
  [StatFunc.PercentUnchecked]: 'Percent unchecked',
  [StatFunc.EarliestDate]: 'Earliest date',
  [StatFunc.LatestDate]: 'Latest date',
  [StatFunc.DateRangeOfDays]: 'Date range (days)',
  [StatFunc.DateRangeOfMonths]: 'Date range (months)',
}
