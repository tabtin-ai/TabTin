import type { ViewRecordsQuery, ViewRecordsResponse } from '@tabtin/table-core'
import {
  buildCalendarViewRecords,
  buildCollabViewRecords,
  buildKanbanViewRecords,
  type BuildCollabViewRecordsInput,
} from '@tabtin/table-engine/collab'

export interface BuildWebCollabViewRecordsInput
  extends Omit<BuildCollabViewRecordsInput, 'page' | 'pageSize'> {
  query: ViewRecordsQuery
}

export function buildWebCollabViewRecords(
  input: BuildWebCollabViewRecordsInput,
): ViewRecordsResponse {
  const common = {
    ...input,
    page: input.query.page,
    pageSize: input.query.page_size,
  }

  if (input.view?.view_type === 'kanban') {
    return buildKanbanViewRecords({
      ...common,
      perGroupLimit: input.query.per_group_limit,
      groupOffsets: input.query.group_offsets,
    })
  }

  if (input.view?.view_type === 'calendar') {
    return buildCalendarViewRecords({
      ...common,
      dateRange: input.query.date_range,
    })
  }

  return buildCollabViewRecords(common)
}
