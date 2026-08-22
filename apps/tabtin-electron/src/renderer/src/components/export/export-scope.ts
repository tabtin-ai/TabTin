export type ExportScope = 'all' | 'selected' | 'view';

/** Only current-view exports inherit the view's visible-field boundary. */
export const resolveExportFieldsForScope = <T>(
  scope: ExportScope,
  allFields: T[],
  visibleViewFields: T[],
): T[] => (scope === 'view' ? visibleViewFields : allFields);

/** Filters, sorting and grouping belong exclusively to the current-view record scope. */
export const shouldApplyCurrentViewQuery = (scope: ExportScope): boolean =>
  scope === 'view';

/** Prefer totals over rendered rows; virtualized/paginated grids may render only a subset. */
export const resolveCurrentViewRecordCount = (
  matchedTotal: number | undefined,
  viewTotal: number | undefined,
  statsTotal: number | undefined,
  renderedTotal?: number,
): number | undefined =>
  matchedTotal ?? viewTotal ?? statsTotal ?? renderedTotal;
