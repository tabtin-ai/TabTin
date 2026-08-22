import type { ViewFilter, ViewFilterLogic, ViewGroup, ViewSort } from './view'

export interface ExportViewQuery {
  filters?: ViewFilter[]
  filter_logic?: ViewFilterLogic
  sorts?: ViewSort[]
  groups?: ViewGroup[]
}

export interface ExportOptions extends ExportViewQuery {
  field_ids?: string[]
  record_ids?: string[]
  view_id?: string
  include_headers?: boolean
  sheet_name?: string
  format_type?: 'array' | 'structured' | 'table_full'
  orientation?: 'portrait' | 'landscape'
  title?: string
}

export type ExportFormat = 'csv' | 'excel' | 'json' | 'pdf'

export type ExportRangeType = 'all' | 'selected' | 'view'

export interface ExportStats {
  table_id: string
  field_count: number
  record_count: number
  estimated_size: {
    csv_kb: number
    excel_kb: number
    json_kb: number
    pdf_kb: number
  }
  is_sampled?: boolean
  original_record_count?: number
}

export interface ExportConfig extends ExportOptions {
  table_id: string
}

export interface ImportOptions {
  skip_errors?: boolean
  update_existing?: boolean
  primary_key_field?: string
  sheet_name?: string
  auto_create_missing_fields?: boolean
}

export type ImportFormatType = 'csv' | 'excel' | 'json'

export interface FieldMapping {
  source: string
  target: string
  target_name: string
  confidence: number
  inferred_type: string
}

export interface ValidationIssue {
  row: number
  field: string
  issue: string
}

export interface ImportPreviewResponse {
  preview_data: Record<string, any>[]
  field_mapping: FieldMapping[]
  validation_issues: ValidationIssue[]
  stats: {
    total_rows: number
    preview_rows: number
    field_count: number
    total_validation_issues: number
  }
}

// ── Import Error Classification ──

export type ImportErrorType =
  | 'type_mismatch'
  | 'null_violation'
  | 'unique_violation'
  | 'format_error'
  | 'column_mismatch'
  | 'validation_error'
  | 'row_limit'
  | 'field_limit'
  | 'table_not_found'
  | 'permission_denied'
  | 'unknown'

export interface ClassifiedImportError {
  type: ImportErrorType
  row: number | null
  field_name: string | null
  message: string
}

export type ImportErrorSummary = Partial<Record<ImportErrorType, number>>

export interface ImportResultResponse {
  created_count: number
  updated_count: number
  skipped_count?: number
  error_summary?: ImportErrorSummary
  errors: ClassifiedImportError[] | string[]
  import_metadata?: {
    auto_create_missing_fields?: boolean
    field_creation?: {
      attempted?: number
      created?: number
      failed?: number
      created_fields?: string[]
      errors?: string[]
    }
    write_batches?: {
      batch_size?: number
      create_batches?: number
      update_batches?: number
    }
  }
}
