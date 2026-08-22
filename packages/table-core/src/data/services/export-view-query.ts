import type { ExportViewQuery } from '../types/import-export';
import type { ViewRecordsQuery } from '../types/view';

type ViewDraftQuery = ExportViewQuery & { isDirty?: boolean };

/** 导出复用用户眼前的查询态：脏草稿优先，已应用查询兜底。 */
export const resolveExportViewQuery = (
  recordsQuery: ViewRecordsQuery,
  draft?: ViewDraftQuery,
): ExportViewQuery => {
  const source = draft?.isDirty ? draft : recordsQuery;
  const query: ExportViewQuery = {};
  if (source.filters !== undefined) query.filters = source.filters;
  if (source.filter_logic !== undefined)
    query.filter_logic = source.filter_logic;
  if (source.sorts !== undefined) query.sorts = source.sorts;
  if (source.groups !== undefined) query.groups = source.groups;
  return query;
};
