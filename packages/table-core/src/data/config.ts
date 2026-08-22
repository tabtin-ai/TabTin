export interface TableDataEndpoints {
  TABLE: {
    LIST_BY_SPACE: (organizationId: string, spaceId: string) => string
    CREATE_IN_SPACE: (organizationId: string, spaceId: string) => string
    LIST: (organizationId: string) => string
    CREATE: string
    DETAIL: (tableId: string) => string
    UPDATE: (tableId: string) => string
    DELETE: (tableId: string) => string
    ARCHIVE: (tableId: string) => string
    RESTORE: (tableId: string) => string
    STATS: (tableId: string) => string
    SEARCH_INDEX_STATUS: (tableId: string) => string
    SEARCH_INDEX_TOGGLE: (tableId: string) => string
    SEARCH_INDEX_REPAIR: (tableId: string) => string
    SEARCH_INDEX_QUERY: (tableId: string) => string
    SEARCH_INDEX_COUNT: (tableId: string) => string
  }
  VIEW: {
    LIST_BY_TABLE: (tableId: string) => string
    CREATE: string
    DETAIL: (viewId: string) => string
    UPDATE: (viewId: string) => string
    COLUMN_META: (viewId: string) => string
    DELETE: (viewId: string) => string
    SET_DEFAULT: (tableId: string, viewId: string) => string
    REORDER: (tableId: string) => string
    VALIDATE_CONFIG: string
    RECORDS: (viewId: string) => string
    COLUMN_STATISTICS: (viewId: string) => string
    FORM_SHARE: (viewId: string) => string
  }
  RECORD: {
    LIST: (tableId: string) => string
    CREATE: string
    DETAIL: (recordId: string) => string
    UPDATE: (recordId: string) => string
    DELETE: (recordId: string) => string
    REORDER: string
    BULK_CREATE: string
    BULK_UPDATE: string
    BULK_DELETE: string
    UPDATE_BY_FILTER_PREFLIGHT: (tableId: string) => string
    UPDATE_BY_FILTER_COMMIT: (tableId: string) => string
  }
  SUB_RECORD: {
    CREATE: string
    MOVE: string
    REORDER_TREE: string
    PARENT_FIELD: (tableId: string) => string
    ENSURE_PARENT_FIELD: (tableId: string) => string
    CREATE_PARENT_FIELD: (tableId: string) => string
  }
  FIELD: {
    LIST: (tableId: string) => string
    CREATE: string
    BULK_CREATE: (tableId: string) => string
    DETAIL: (fieldId: string) => string
    UPDATE: (fieldId: string) => string
    DELETE: (fieldId: string) => string
    DELETE_REFERENCES: (fieldId: string) => string
    EXPLAIN: (fieldId: string) => string
    REORDER: (tableId: string) => string
    CONVERT: (fieldId: string) => string
    CHECK_CONVERSION: (fieldId: string) => string
    PREVIEW_CONVERSION: (fieldId: string) => string
  }
  LLM_CATALOG: string
  ATTACHMENT: {
    CREATE_UPLOAD_TASK: string
    UPLOAD_PART: (taskId: string, uploadItemId: string) => string
    COMPLETE_UPLOAD: (taskId: string, uploadItemId: string) => string
    ABORT_UPLOAD: (taskId: string, uploadItemId: string) => string
    REUSE: string
    ACCESS_URL: string
    REMOVE_REFERENCE: (referenceId: string) => string
    RECORD_ATTACHMENTS: (recordId: string) => string
    CONVERT_FIELD: (fieldId: string) => string
  }
  IMPORT_EXPORT: {
    STATS: (tableId: string) => string
    EXPORT_CSV: string
    EXPORT_EXCEL: string
    EXPORT_JSON: string
    EXPORT_PDF: string
    IMPORT_TEMPLATE: (tableId: string) => string
    IMPORT_PREVIEW: string
    IMPORT_CSV: string
    IMPORT_EXCEL: string
    IMPORT_JSON: string
  }
  SKILL_REGISTRY: {
    LIST: string
    DETAIL: (appId: string) => string
  }
  LINK_FIELD: {
    LINKABLE_RECORDS: (tableId: string, fieldId: string) => string
    LINKABLE_FIELDS: (tableId: string, fieldId: string) => string
  }
  UNDO_REDO: {
    RECORD_UNDO: (recordId: string) => string
    RECORD_REDO: (recordId: string) => string
    RECORD_HISTORY: (recordId: string) => string
    TABLE_HISTORY: (tableId: string) => string
    TABLE_UNDO: (tableId: string) => string
    TABLE_REDO: (tableId: string) => string
    TABLE_UNDO_STACK: (tableId: string) => string
    TABLE_REDO_STACK: (tableId: string) => string
    RECORD_SNAPSHOT: (recordId: string) => string
    RECORD_RESTORE: (recordId: string) => string
    TABLE_SNAPSHOT: (tableId: string) => string
    TABLE_RESTORE: (tableId: string) => string
    TABLE_NAMED_VERSIONS: (tableId: string) => string
    TABLE_NAMED_VERSION_DETAIL: (tableId: string, versionId: string) => string
  }
}

export interface TableDataClientConfig {
  baseURL: string
  endpoints: TableDataEndpoints
}

export const DEFAULT_TABLE_DATA_ENDPOINTS: TableDataEndpoints = {
  TABLE: {
    LIST_BY_SPACE: (organizationId: string, spaceId: string) =>
      `/tabdata/organizations/${organizationId}/spaces/${spaceId}/tables`,
    CREATE_IN_SPACE: (organizationId: string, spaceId: string) =>
      `/tabdata/organizations/${organizationId}/spaces/${spaceId}/tables`,
    LIST: (organizationId: string) => `/tabdata/organizations/${organizationId}/tables`,
    CREATE: '/tabdata/tables',
    DETAIL: (tableId: string) => `/tabdata/tables/${tableId}`,
    UPDATE: (tableId: string) => `/tabdata/tables/${tableId}`,
    DELETE: (tableId: string) => `/tabdata/tables/${tableId}`,
    ARCHIVE: (tableId: string) => `/tabdata/tables/${tableId}/archive`,
    RESTORE: (tableId: string) => `/tabdata/tables/${tableId}/restore`,
    STATS: (tableId: string) => `/tabdata/tables/${tableId}/stats`,
    SEARCH_INDEX_STATUS: (tableId: string) => `/tabdata/tables/${tableId}/search-index/status`,
    SEARCH_INDEX_TOGGLE: (tableId: string) => `/tabdata/tables/${tableId}/search-index/toggle`,
    SEARCH_INDEX_REPAIR: (tableId: string) => `/tabdata/tables/${tableId}/search-index/repair`,
    SEARCH_INDEX_QUERY: (tableId: string) => `/tabdata/tables/${tableId}/search-index/query`,
    SEARCH_INDEX_COUNT: (tableId: string) => `/tabdata/tables/${tableId}/search-index/count`,
  },
  VIEW: {
    LIST_BY_TABLE: (tableId: string) => `/tabdata/tables/${tableId}/views`,
    CREATE: '/tabdata/views',
    DETAIL: (viewId: string) => `/tabdata/views/${viewId}`,
    UPDATE: (viewId: string) => `/tabdata/views/${viewId}`,
    COLUMN_META: (viewId: string) => `/tabdata/views/${viewId}/column-meta`,
    DELETE: (viewId: string) => `/tabdata/views/${viewId}`,
    SET_DEFAULT: (tableId: string, viewId: string) =>
      `/tabdata/tables/${tableId}/views/set-default/${viewId}`,
    REORDER: (tableId: string) => `/tabdata/tables/${tableId}/views/reorder`,
    VALIDATE_CONFIG: '/tabdata/views/validate-config',
    RECORDS: (viewId: string) => `/tabdata/views/${viewId}/records`,
    COLUMN_STATISTICS: (viewId: string) => `/tabdata/views/${viewId}/column-statistics`,
    FORM_SHARE: (viewId: string) => `/tabdata/views/${viewId}/form-share`,
  },
  RECORD: {
    LIST: (tableId: string) => `/tabdata/tables/${tableId}/records`,
    CREATE: '/tabdata/records',
    DETAIL: (recordId: string) => `/tabdata/records/${recordId}`,
    UPDATE: (recordId: string) => `/tabdata/records/${recordId}`,
    DELETE: (recordId: string) => `/tabdata/records/${recordId}`,
    REORDER: '/tabdata/records/reorder',
    BULK_CREATE: '/tabdata/records/bulk-create',
    BULK_UPDATE: '/tabdata/records/bulk-update',
    BULK_DELETE: '/tabdata/records/bulk-delete',
    UPDATE_BY_FILTER_PREFLIGHT: (tableId: string) => `/tabdata/tables/${tableId}/records/update-by-filter/preflight`,
    UPDATE_BY_FILTER_COMMIT: (tableId: string) => `/tabdata/tables/${tableId}/records/update-by-filter/commit`,
  },
  SUB_RECORD: {
    CREATE: '/tabdata/sub-records/create',
    MOVE: '/tabdata/sub-records/move',
    REORDER_TREE: '/tabdata/sub-records/reorder-tree',
    PARENT_FIELD: (tableId: string) => `/tabdata/sub-records/tables/${tableId}/parent-field`,
    ENSURE_PARENT_FIELD: (tableId: string) => `/tabdata/sub-records/tables/${tableId}/ensure-parent-field`,
    CREATE_PARENT_FIELD: (tableId: string) => `/tabdata/sub-records/tables/${tableId}/create-parent-field`,
  },
  FIELD: {
    LIST: (tableId: string) => `/tabdata/tables/${tableId}/fields`,
    CREATE: '/tabdata/fields',
    BULK_CREATE: (tableId: string) => `/tabdata/tables/${tableId}/fields/bulk`,
    DETAIL: (fieldId: string) => `/tabdata/fields/${fieldId}`,
    UPDATE: (fieldId: string) => `/tabdata/fields/${fieldId}`,
    DELETE: (fieldId: string) => `/tabdata/fields/${fieldId}`,
    DELETE_REFERENCES: (fieldId: string) => `/tabdata/fields/${fieldId}/delete-references`,
    EXPLAIN: (fieldId: string) => `/tabdata/fields/${fieldId}/explain`,
    REORDER: (tableId: string) => `/tabdata/tables/${tableId}/fields/reorder`,
    CONVERT: (fieldId: string) => `/tabdata/fields/${fieldId}/convert`,
    CHECK_CONVERSION: (fieldId: string) => `/tabdata/fields/${fieldId}/check-conversion`,
    PREVIEW_CONVERSION: (fieldId: string) => `/tabdata/fields/${fieldId}/preview-conversion`,
  },
  LLM_CATALOG: '/services/llm/catalog',
  ATTACHMENT: {
    CREATE_UPLOAD_TASK: '/tabdata/attachments/upload-task',
    UPLOAD_PART: (taskId: string, uploadItemId: string) =>
      `/tabdata/attachments/upload-task/${taskId}/files/${uploadItemId}/part`,
    COMPLETE_UPLOAD: (taskId: string, uploadItemId: string) =>
      `/tabdata/attachments/upload-task/${taskId}/files/${uploadItemId}/complete`,
    ABORT_UPLOAD: (taskId: string, uploadItemId: string) =>
      `/tabdata/attachments/upload-task/${taskId}/files/${uploadItemId}/abort`,
    REUSE: '/tabdata/attachments/reuse',
    ACCESS_URL: '/tabdata/attachments/access-url',
    REMOVE_REFERENCE: (referenceId: string) => `/tabdata/attachments/${referenceId}`,
    RECORD_ATTACHMENTS: (recordId: string) => `/tabdata/records/${recordId}/attachments`,
    CONVERT_FIELD: (fieldId: string) => `/tabdata/fields/${fieldId}/convert`,
  },
  IMPORT_EXPORT: {
    STATS: (tableId: string) => `/tabdata/export/stats/${tableId}`,
    EXPORT_CSV: '/tabdata/export/csv',
    EXPORT_EXCEL: '/tabdata/export/excel',
    EXPORT_JSON: '/tabdata/export/json',
    EXPORT_PDF: '/tabdata/export/pdf',
    IMPORT_TEMPLATE: (tableId: string) => `/tabdata/import/template/${tableId}`,
    IMPORT_PREVIEW: '/tabdata/import/preview',
    IMPORT_CSV: '/tabdata/import/csv',
    IMPORT_EXCEL: '/tabdata/import/excel',
    IMPORT_JSON: '/tabdata/import/json',
  },
  SKILL_REGISTRY: {
    LIST: '/skills/registry',
    DETAIL: (appId: string) => `/skills/${appId}`,
  },
  LINK_FIELD: {
    LINKABLE_RECORDS: (tableId: string, fieldId: string) =>
      `/tabdata/tables/${tableId}/fields/${fieldId}/linkable-records`,
    LINKABLE_FIELDS: (tableId: string, fieldId: string) =>
      `/tabdata/tables/${tableId}/fields/${fieldId}/linkable-fields`,
  },
  UNDO_REDO: {
    RECORD_UNDO: (recordId: string) => `/tabdata/records/${recordId}/undo`,
    RECORD_REDO: (recordId: string) => `/tabdata/records/${recordId}/redo`,
    RECORD_HISTORY: (recordId: string) => `/tabdata/records/${recordId}/history`,
    TABLE_HISTORY: (tableId: string) => `/tabdata/tables/${tableId}/history`,
    TABLE_UNDO: (tableId: string) => `/tabdata/tables/${tableId}/undo`,
    TABLE_REDO: (tableId: string) => `/tabdata/tables/${tableId}/redo`,
    TABLE_UNDO_STACK: (tableId: string) => `/tabdata/tables/${tableId}/undo-stack`,
    TABLE_REDO_STACK: (tableId: string) => `/tabdata/tables/${tableId}/redo-stack`,
    RECORD_SNAPSHOT: (recordId: string) => `/tabdata/records/${recordId}/snapshot`,
    RECORD_RESTORE: (recordId: string) => `/tabdata/records/${recordId}/restore-history`,
    TABLE_SNAPSHOT: (tableId: string) => `/tabdata/tables/${tableId}/snapshot`,
    TABLE_RESTORE: (tableId: string) => `/tabdata/tables/${tableId}/history-restore`,
    TABLE_NAMED_VERSIONS: (tableId: string) => `/tabdata/tables/${tableId}/named-versions`,
    TABLE_NAMED_VERSION_DETAIL: (tableId: string, versionId: string) => `/tabdata/tables/${tableId}/named-versions/${versionId}`,
  },
}

let tableDataClientConfig: TableDataClientConfig = {
  baseURL: '',
  endpoints: DEFAULT_TABLE_DATA_ENDPOINTS,
}

export const configureTableDataClient = (next: Partial<TableDataClientConfig>): void => {
  tableDataClientConfig = {
    ...tableDataClientConfig,
    ...next,
    endpoints: next.endpoints ?? tableDataClientConfig.endpoints,
  }
}

export const getTableDataClientConfig = (): Readonly<TableDataClientConfig> => {
  return tableDataClientConfig
}

export const resetTableDataClientConfig = (): void => {
  tableDataClientConfig = {
    baseURL: '',
    endpoints: DEFAULT_TABLE_DATA_ENDPOINTS,
  }
}
