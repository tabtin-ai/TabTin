import type { ContextItem } from '@components/context-space/registry/types'
import type { CrawlspaceViewInfo } from '@stores/useCrawlTabStore'
import type { CreateTableRequest, Table } from '@tabtin/table-core'

export type BrowserContextSourceResult = {
  viewList: CrawlspaceViewInfo[]
  items: ContextItem[]
  activeViewId: string | null
}

export type TableContextSourceResult = {
  tables: Table[]
  items: ContextItem[]
  openTableIds: string[]
  isLoading: boolean
  error: string | null
  createTable: (data: CreateTableRequest) => Promise<Table | null>
  /** @deprecated 遗留 Space 路径；应用门请用 createTable(org-only) */
  createTableInSpace: (
    organizationId: string,
    spaceId: string,
    data: Omit<CreateTableRequest, 'space_id' | 'organization_id'>,
  ) => Promise<Table | null>
  selectedOrganizationId: string | null
}
