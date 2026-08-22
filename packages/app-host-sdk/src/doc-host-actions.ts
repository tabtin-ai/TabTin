export interface TabDocOpenResourceInput {
  resourceType: 'tabdoc' | 'tabdata' | 'tabslide' | 'tabwhiteboard'
  resourceId: string
  title?: string
}

export interface TabDocOpenWebUrlInput {
  /** 待打开的 http(s) 链接原文 */
  url: string
  /** Browser 标签标题（可选，默认由 URL 推导） */
  title?: string
  /** 附件识别提示；用于无扩展名签名 URL 在创建 Browser 标签前分流到预览。 */
  openIntentHints?: {
    filename?: string
    mimeType?: string
    assetId?: string
  }
}

export interface TabDocCreateEmbeddedTableInput {
  organizationId: string | null
  spaceId: string | null
  sourceDocumentId: string
  title?: string
}

export interface TabDocSyncResourceMetaInput {
  documentId: string
  linkedResourceIds: string[]
}

export interface TabDocSyncResourceTitleInput {
  documentId: string
  title: string
  updatedAt?: string | null
}

export interface TabDocListTablesInput {
  organizationId: string | null
  spaceId?: string | null
}

export interface TabDocUploadImportFileInput {
  file: File
  documentId?: string | null
  organizationId: string | null
  spaceId?: string | null
}

export interface TabDocUploadImportFileResult {
  fileRecordId: string
}

export interface TabDocTableSummary {
  id: string
  name: string
  description?: string
  icon?: string
  spaceId: string | null
  isArchived: boolean
}

/**
 * HTML 块「在浏览器打开」：打开稳定网页地址（documentId + blockId），
 * 权限继承文档（成员 ACL / DocumentShare），不再有独立 HTML 分享。
 */
export interface TabDocOpenHtmlArtifactInBrowserInput {
  documentId: string
  /** 稳定块身份；与文档分享解耦，URL 以 blockId 定位内容 */
  blockId: string
  /**
   * 编辑器侧当前 fileId。协作 onStore 尚未把块写入 description_json 时，
   * 成员 ACL 路径用其做短期兜底（外链分享不依赖此字段）。
   */
  fileId?: string
  title?: string
}

/**
 * TabDoc 宿主动作契约。
 *
 * 目标：
 * - 让共享 UI 不再直接依赖 Electron renderer store
 * - 让 Web / Electron 通过各自 adapter 注入资源跳转、嵌表创建等能力
 */
export interface TabDocHostActions {
  openResource(input: TabDocOpenResourceInput): Promise<void>
  /**
   * 打开文档正文中的 http(s) 外部链接。
   * 宿主据各自运行时和打开意图决定承载方式（Electron 对附件使用 Preview Modal，
   * 对网页使用当前 Space 的 tabweb；Web 在新浏览器标签打开），共享 UI 不再直接
   * `<a target=_blank>` 跳系统浏览器。
   */
  openWebUrl(input: TabDocOpenWebUrlInput): Promise<void>
  /**
   * 在浏览器打开 HTML 块的稳定网页地址。
   * 身份 = documentId + blockId；URL 可附带当前文档 share_id（可空）。
   * 成员未分享也可开（登录后 ACL）；外链依赖有效 DocumentShare。
   */
  openHtmlArtifactInBrowser?(input: TabDocOpenHtmlArtifactInBrowserInput): Promise<void>
  /**
   * 将用户选择的文档类文件上传为 FileRecord，供 `/tabdoc/import/file` 解析。
   * Electron 走 OSS 直传；不具备持久上传能力的宿主可以不实现，TabDoc UI 会保留纯文本导入。
   */
  uploadImportFile?(input: TabDocUploadImportFileInput): Promise<TabDocUploadImportFileResult>
  createEmbeddedTable(input: TabDocCreateEmbeddedTableInput): Promise<{ id: string; name: string }>
  listTables(input: TabDocListTablesInput): Promise<TabDocTableSummary[]>
  syncResourceMeta(input: TabDocSyncResourceMetaInput): Promise<void>
  syncResourceTitle(input: TabDocSyncResourceTitleInput): Promise<void>
}
