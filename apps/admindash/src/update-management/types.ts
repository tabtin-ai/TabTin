export type DesktopReleaseStatus = 'draft' | 'published' | 'deprecated'
export type DesktopReleaseChannel = 'stable' | 'beta' | 'alpha'
export type DesktopReleasePlatform = 'mac' | 'win' | 'linux'
export type DesktopReleaseArch = 'x64' | 'arm64'
export type DesktopReleaseAssetType = 'package' | 'manifest' | 'blockmap' | 'website_installer'

export interface AdminUpdateMatrixRelease {
  release_id: number
  version: string
  platform: DesktopReleasePlatform
  arch: DesktopReleaseArch
  channel: DesktopReleaseChannel
  published_at: string | null
  rollout_percentage: number
  priority: string
  mandatory: boolean
}

export interface AdminUpdateOverview {
  total_releases: number
  draft_releases: number
  published_releases: number
  deprecated_releases: number
  recent_24h_attempts: number
  recent_24h_installs: number
  recent_24h_failures: number
  latest_matrix: Record<DesktopReleaseChannel, Record<string, AdminUpdateMatrixRelease>>
}

export interface AdminUpdateReleaseListItem {
  id: number
  version: string
  platform: DesktopReleasePlatform
  arch: DesktopReleaseArch
  channel: DesktopReleaseChannel
  status: DesktopReleaseStatus
  file_url: string
  website_file_url: string
  feed_url: string
  file_size: number
  checksum_sha256: string
  checksum_sha512: string
  is_mandatory: boolean
  min_compatible_version: string
  priority: string
  rollout_percentage: number
  rollout_target_users: string[]
  release_notes: string
  release_notes_en: string
  created_by_id: string | null
  created_by_name: string
  created_at: string | null
  updated_at: string | null
  published_at: string | null
  deprecated_at: string | null
  push_count: number
  sent_push_count: number
  last_push_at: string | null
  effective_feed_url: string
  feed_url_derived: boolean
  manifest_file: string
  manifest_url: string
  asset_name: string
  website_asset_name: string
  download_file_url: string
  source_warnings: string[]
}

export interface AdminUpdatePagination {
  page: number
  page_size: number
  total: number
  total_pages: number
}

export interface AdminUpdateReleaseListResponse {
  items: AdminUpdateReleaseListItem[]
  pagination: AdminUpdatePagination
}

export interface AdminUpdatePushRecord {
  id: number
  status: string
  rollout_percentage: number
  silent: boolean
  pushed_at: string | null
  pushed_by_id: string | null
  pushed_by_name: string
  error_message: string
  target_group: string
  notes: string
}

export interface AdminUpdateLog {
  id: number
  device_id: string
  user_id: string
  organization_id: string
  from_version: string
  to_version: string
  trigger_source: string
  status: string
  progress: number
  success: boolean | null
  error_code: string
  error_message: string
  started_at: string | null
  completed_at: string | null
}

export interface AdminUpdateReleaseMetrics {
  total_attempts: number
  installed_count: number
  failed_count: number
  downloading_count: number
  downloaded_count: number
  available_count: number
  recent_24h_attempts: number
  success_rate: number
}

export interface AdminUpdateReadinessIssue {
  code: string
  severity: 'error' | 'warning' | 'info' | string
  message: string
  expected: string
  actual: string
}

export interface AdminUpdateReadinessAsset {
  raw_url: string
  resolved_url: string
  sha512: string
  size: number | null
  http_status: number | null
}

export interface AdminUpdateReleaseReadiness {
  status: 'ready' | 'warning' | 'blocked' | string
  checked_at: string | null
  manifest_url: string
  manifest_file: string
  manifest_http_status: number | null
  manifest_version: string
  manifest_release_date: string
  staging_percentage: number | null
  blocking_issue_count: number
  warning_issue_count: number
  info_issue_count: number
  asset: AdminUpdateReadinessAsset
  issues: AdminUpdateReadinessIssue[]
}

export interface AdminUpdateManifestPreview {
  can_generate: boolean
  manifest_file: string
  manifest_url: string
  content: string
  issues: string[]
}

export interface AdminUpdateReleaseDetail {
  release: AdminUpdateReleaseListItem
  metrics: AdminUpdateReleaseMetrics
  push_records: AdminUpdatePushRecord[]
  recent_logs: AdminUpdateLog[]
  active_version_distribution: Array<{ from_version: string; count: number }>
}

export interface AdminUpdateActionResponse {
  success: boolean
  message: string
  release: AdminUpdateReleaseListItem
}

export interface AdminUpdateReleaseAssetUploadIntentPayload {
  asset_type: DesktopReleaseAssetType
  file_name: string
  file_size: number
  content_type: string
}

export interface AdminUpdateReleaseAssetUploadIntent {
  asset_type: DesktopReleaseAssetType
  file_name: string
  expected_file_name: string
  object_key: string
  presigned_url: string
  access_url: string
  cdn_url: string
  public_url: string
  content_type: string
  expires_in: number
}

export interface AdminUpdateReleaseAssetCompletePayload {
  asset_type: DesktopReleaseAssetType
  object_key: string
  file_name: string
  file_size: number
  content_type: string
  checksum_sha256?: string
  checksum_sha512?: string
  auto_generate_manifest?: boolean
}

export interface AdminUpdateReleaseAsset {
  asset_type: DesktopReleaseAssetType
  file_record_id: string
  file_name: string
  object_key: string
  public_url: string
  access_url: string
  cdn_url: string
  file_size: number
  checksum_sha256: string
  checksum_sha512: string
  manifest_generated: boolean
  manifest_url: string
  manifest_file: string
  manifest_generation_error: string
}

export interface AdminUpdateAssetActionResponse {
  success: boolean
  message: string
  release: AdminUpdateReleaseListItem
  asset: AdminUpdateReleaseAsset
}

export interface AdminUpdateReleaseQuery {
  keyword?: string
  channel?: string
  platform?: string
  arch?: string
  status?: string
  page?: number
  page_size?: number
}

export interface AdminUpdateReleaseCreatePayload {
  version: string
  platform: DesktopReleasePlatform
  arch: DesktopReleaseArch
  channel: DesktopReleaseChannel
  file_url: string
  website_file_url?: string
  feed_url: string
  file_size: number
  checksum_sha256: string
  checksum_sha512?: string
  is_mandatory: boolean
  min_compatible_version: string
  priority: string
  rollout_percentage: number
  rollout_target_users: string[]
  release_notes: string
  release_notes_en: string
}

export interface AdminUpdateReleaseUpdatePayload {
  file_url?: string
  website_file_url?: string
  feed_url?: string
  file_size?: number
  checksum_sha256?: string
  checksum_sha512?: string
  is_mandatory?: boolean
  min_compatible_version?: string
  priority?: string
  rollout_percentage?: number
  rollout_target_users?: string[]
  release_notes?: string
  release_notes_en?: string
}

export interface AdminUpdatePushPayload {
  rollout_percentage?: number
  silent?: boolean
}
