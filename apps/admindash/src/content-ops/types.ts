export interface ContentOverviewOrganizationSummary {
  total_organizations: number
  total_spaces: number
  trashed_spaces: number
}

export interface ContentOverviewTableSummary {
  total_tables: number
  active_tables: number
  archived_tables: number
  system_tables: number
}

export interface ContentOverviewDocSummary {
  total_documents: number
  active_documents: number
  archived_documents: number
  documents_with_permission_overrides: number
}

export interface ContentOverviewSlideSummary {
  total_projects: number
  active_projects: number
  archived_projects: number
  trashed_projects: number
  dirty_projects: number
  total_pages: number
}

export interface ContentOverviewMailSummary {
  total_accounts: number
  active_accounts: number
  syncing_accounts: number
  error_accounts: number
  total_messages: number
  unread_messages: number
  pending_drafts: number
}

export interface ContentOverviewAssetSummary {
  total_files: number
  completed_files: number
  failed_files: number
  deleted_files: number
  public_files: number
  private_files: number
  total_size: number
  orphan_files: number
  orphan_size: number
}

export interface ContentOverviewTrashSummary {
  total_trashed_resources: number
  trashed_spaces: number
  expiring_soon_3_days: number
  by_type: Array<{ item_type: string; count: number }>
}

export interface ContentOverviewTotals {
  managed_resources: number
  pending_attention: number
}

export interface ContentOverviewResponse {
  organizations: ContentOverviewOrganizationSummary
  tables: ContentOverviewTableSummary
  docs: ContentOverviewDocSummary
  slides: ContentOverviewSlideSummary
  mail: ContentOverviewMailSummary
  assets: ContentOverviewAssetSummary
  trash: ContentOverviewTrashSummary
  totals: ContentOverviewTotals
}
