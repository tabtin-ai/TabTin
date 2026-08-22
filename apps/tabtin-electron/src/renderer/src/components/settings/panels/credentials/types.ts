export type {
  BrowserProfile,
  DetectedBrowser,
  CookieDomainSummary,
  PartitionCookieSummary,
} from '../../../../../../shared/types/credential'

export interface CredentialItem {
  id: string
  category: string
  service_name: string
  display_name: string
  masked_data: Record<string, string>
  metadata: Record<string, any>
  is_active: boolean
  expires_at: string | null
  created_at: string
  updated_at: string
}

export interface WebsiteCredentialItem {
  id: string
  url: string
  username: string
  masked_password: string
  display_name: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface AppCredentialItem {
  id: string
  app_package: string
  app_name: string
  username: string
  masked_password: string
  display_name: string
  is_active: boolean
  created_at: string
  updated_at: string
}
