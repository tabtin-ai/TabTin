/**
 * API 端点路径常量
 * 集中管理所有 API 路径，便于多平台（Electron / Web / Mobile）共享
 */
export const API_ENDPOINTS = {
  AUTH: {
    LOGIN: '/auth/login',
    LOGIN_VERIFICATION_CODE: '/auth/login/verification-code',
    REGISTER: '/auth/register',
    LOGOUT: '/auth/logout',
    REFRESH: '/auth/refresh-token',
    PROFILE: '/auth/profile',
    REDEEM_INVITE_CODE: '/auth/invite-code/redeem',
    PROFILE_SETTINGS: '/auth/profile/settings',
    // IA Phase 2：个人偏好跨设备同步（theme/fontSize/colorScheme/notificationPrefs/
    // voiceHotwords/resourceOpenPrefs）。后端 2A 单元并行实现；envelope per-namespace
    // {value, updatedAt(ms)}，后端 last-write-wins，写后 WS ``ui_settings_changed`` 回灌。
    PROFILE_UI_SETTINGS: '/auth/profile/ui-settings',
    // IA Phase 3 §8.6：三层规则·个人基线层（per-User 全局，跨 Organization）。
    // GET 返回 {personal_rules:str}；PUT body {personal_rules:str}（≤5000，空串=清空）。
    PROFILE_PERSONAL_RULES: '/auth/profile/personal-rules',
    HEALTH: '/auth/health',
  },

  VERIFICATION: {
    SEND_CODE: '/auth/send-verification-code',
    SEND_EMAIL: '/auth/send-email-verification',
    SEND_PHONE: '/auth/send-phone-verification',
    SEND_BIND_EMAIL_CODE: '/auth/send-bind-email-code',
    BIND_EMAIL: '/auth/bind-email',
    VERIFY_EMAIL: '/auth/verify-email',
    VERIFY_PHONE: '/auth/verify-phone',
  },

  PASSWORD: {
    FORGOT: '/auth/forgot-password',
    RESET: '/auth/reset-password',
    SEND_CURRENT_RESET_CODE: '/auth/send-current-password-reset-code',
    RESET_CURRENT: '/auth/reset-current-password',
    CHANGE: '/auth/change-password',
    STRENGTH: '/auth/password-strength',
  },

  SESSION: {
    LIST: '/auth/sessions',
    DELETE: (sessionId: string) => `/auth/sessions/${sessionId}`,
  },

  ORGANIZATION: {
    LIST: '/context/organizations',
    CREATE: '/context/organizations',
    DETAIL: (organizationId: string) => `/context/organizations/${organizationId}`,
    UPDATE: (organizationId: string) => `/context/organizations/${organizationId}`,
    DELETE: (organizationId: string) => `/context/organizations/${organizationId}`,
    LEAVE: (organizationId: string) => `/context/organizations/${organizationId}/leave`,
    SEARCH: (organizationId: string) => `/context/organizations/${organizationId}/search`,
    CONTEXT_ITEMS: (organizationId: string) => `/context/organizations/${organizationId}/context-items`,
    KNOWLEDGE_TREE: (organizationId: string) => `/context/organizations/${organizationId}/knowledge-tree`,
    KNOWLEDGE_TREE_CHILDREN: (organizationId: string, nodeId: string) =>
      `/context/organizations/${organizationId}/knowledge-tree/nodes/${nodeId}/children`,
    KNOWLEDGE_TREE_REORDER_SIBLINGS: (organizationId: string) =>
      `/context/organizations/${organizationId}/knowledge-tree/reorder-siblings`,
    /** @deprecated  已 410；改用 TRASHED_PROJECTS */
    TRASHED_SPACES: (organizationId: string) => `/context/organizations/${organizationId}/trashed-spaces`,
    TRASHED_PROJECTS: (organizationId: string) =>
      `/context/organizations/${organizationId}/trashed-projects`,
    TRASH: (organizationId: string) => `/context/organizations/${organizationId}/trash`,
    TRASH_EMPTY: (organizationId: string) => `/context/organizations/${organizationId}/trash/empty`,
    DEACTIVATED_AGENTS: (organizationId: string) =>
      `/agents/deactivated?organization_id=${encodeURIComponent(organizationId)}`,
    HEALTH: '/tabdata/health',
    APP_CATALOG: (organizationId: string) => `/context/organizations/${organizationId}/app-catalog`,
    APP_INSTALL: (organizationId: string, appId: string) =>
      `/context/organizations/${organizationId}/app-catalog/${appId}/install`,
    APP_UNINSTALL: (organizationId: string, appId: string) =>
      `/context/organizations/${organizationId}/app-catalog/${appId}/uninstall`,
    // ：TabFiles 组织级云盘裸文件（org-only，不挂 workspace/project）。
    FILE_UPLOAD: (organizationId: string) =>
      `/context/organizations/${organizationId}/files/upload`,
    FILE_FROM_CHAT: (organizationId: string) =>
      `/context/organizations/${organizationId}/files/from-chat`,
    FILE_DOWNLOAD_URL: (organizationId: string, itemId: string) =>
      `/context/organizations/${organizationId}/files/${itemId}/download-url`,
    FILE_TRASH: (organizationId: string, fileRecordId: string) =>
      `/context/organizations/${organizationId}/files/${fileRecordId}/trash`,
    FILE_RESTORE: (organizationId: string, fileRecordId: string) =>
      `/context/organizations/${organizationId}/files/${fileRecordId}/restore`,
    FILE_PERMANENT: (organizationId: string, fileRecordId: string) =>
      `/context/organizations/${organizationId}/files/${fileRecordId}/permanent`,
    // ：云文档支持普通文件和文件夹 —— Organization Collection（组织级文件夹），
    // 与 WORKSPACE.COLLECTIONS* 对等但归属 organization-only 资源（不挂 workspace/project）。
    COLLECTIONS: (organizationId: string) =>
      `/context/organizations/${organizationId}/collections`,
    COLLECTIONS_REORDER: (organizationId: string) =>
      `/context/organizations/${organizationId}/collections/reorder`,
    COLLECTIONS_MOVE_ITEMS: (organizationId: string) =>
      `/context/organizations/${organizationId}/collections/move-items`,
  },

  LLM_ORGANIZATION: {
    PROVIDERS: (organizationId: string) => `/services/llm/organizations/${organizationId}/providers`,
    PROVIDER_DETAIL: (organizationId: string, providerId: string) =>
      `/services/llm/organizations/${organizationId}/providers/${providerId}`,
    PROVIDER_PROBE: (organizationId: string, providerId: string) =>
      `/services/llm/organizations/${organizationId}/providers/${providerId}/probe`,
    PROVIDER_KEYS: (organizationId: string, providerId: string) =>
      `/services/llm/organizations/${organizationId}/providers/${providerId}/keys`,
    PROVIDER_KEY_DETAIL: (organizationId: string, providerId: string, keyId: string) =>
      `/services/llm/organizations/${organizationId}/providers/${providerId}/keys/${keyId}`,
    MODELS: (organizationId: string) => `/services/llm/organizations/${organizationId}/models`,
    MODEL_DETAIL: (organizationId: string, modelId: string) =>
      `/services/llm/organizations/${organizationId}/models/${modelId}`,
    DEFAULT_MODEL: (organizationId: string) => `/services/llm/organizations/${organizationId}/default-model`,
    USER_DEFAULT_MODEL: (organizationId: string) =>
      `/services/llm/organizations/${organizationId}/user-default-model`,
    SUBAGENT_MODEL: (organizationId: string) => `/services/llm/organizations/${organizationId}/subagent-model`,
    USER_SUBAGENT_MODEL: (organizationId: string) =>
      `/services/llm/organizations/${organizationId}/user-subagent-model`,
  },

  LLM_CATALOG: '/services/llm/catalog',
  LLM_VALIDATE: '/services/llm/validate',
  LLM_SEARCH_MODELS: '/services/llm/search-models',

  ORGANIZATION_MEMBER: {
    LIST: (organizationId: string) => `/context/organizations/${organizationId}/members`,
    ADD: (organizationId: string) => `/context/organizations/${organizationId}/members`,
    UPDATE: (organizationId: string, userId: string) => `/context/organizations/${organizationId}/members/${userId}`,
    REMOVE: (organizationId: string, userId: string) => `/context/organizations/${organizationId}/members/${userId}`,
  },

  ORGANIZATION_AGENT: {
    LIST: (organizationId: string) =>
      `/agents?organization_id=${encodeURIComponent(organizationId)}`,
  },

  // Agent 身份 CRUD — 挂载 /api/agents（与 Space/Workspace 的 /api/context 分离，）。
  AGENT: {
    LIST: '/agents',
    CREATE: '/agents',
    TEMPLATES: '/agents/templates',
    DETAIL: (agentId: string) => `/agents/${agentId}`,
    UPDATE: (agentId: string) => `/agents/${agentId}`,
    DELETE: (agentId: string) => `/agents/${agentId}`,
    PERMANENT_DELETE: (agentId: string) => `/agents/${agentId}/permanent`,
    REACTIVATE: (agentId: string) => `/agents/${agentId}/reactivate`,
    PREFERRED_MODEL: (agentId: string) => `/agents/${agentId}/preferred-model`,
    SKILLS: (agentId: string) => `/agents/${agentId}/skills`,
    SKILL: (agentId: string, skillCanonicalKey: string) =>
      `/agents/${agentId}/skills/${encodeURIComponent(skillCanonicalKey)}`,
  },

  // Agent Memory 独立域— 与 TabMemo 用户笔记分离。
  AGENT_MEMORY: {
    LIST: '/agent-memory/memories/',
    STATS: '/agent-memory/memories/stats/',
    DETAIL: (memoryId: string) => `/agent-memory/memories/${memoryId}/`,
    CORRECT: (memoryId: string) => `/agent-memory/memories/${memoryId}/correct/`,
    FORGET: (memoryId: string) => `/agent-memory/memories/${memoryId}/forget/`,
    FEEDBACK: (memoryId: string) => `/agent-memory/memories/${memoryId}/feedback/`,
    EXPORT: '/agent-memory/memories/export/',
  },

  // Workspace 审批记忆 CRUD。
  // 后端定义见 apps/tabtin_django/apps/tabtinspace/routers/approval_memo.py（router
  // 挂在 tabtinspace_router 下，tabtinspace_router 挂在 /context 前缀；ninja 路由
  // 严格匹配，**无尾斜杠**）。任何客户端（agent-runtime memo-sync-client、Electron
  // renderer AgentSecurityPanel、Daemon 等）都应从这里取路径，避免再次出现
  // /space/agents/... 或漏 /context 前缀的 404 静默失败。
  APPROVAL_MEMO: {
    GET: (workspaceId: string) => `/context/workspaces/${workspaceId}/approval-memo`,
    UPSERT: (workspaceId: string, entryKey: string) =>
      `/context/workspaces/${workspaceId}/approval-memo/${encodeURIComponent(entryKey)}`,
    DELETE: (workspaceId: string, entryKey: string) =>
      `/context/workspaces/${workspaceId}/approval-memo/${encodeURIComponent(entryKey)}`,
    REVOKE_ALL: (workspaceId: string) => `/context/workspaces/${workspaceId}/approval-memo/_revoke_all`,
  },

  ORGANIZATION_INVITATION: {
    CREATE_EMAIL: (organizationId: string) => `/context/organizations/${organizationId}/invitations/email`,
    CREATE_LINK: (organizationId: string) => `/context/organizations/${organizationId}/invitations/link`,
    CREATE_DIRECT: (organizationId: string) => `/context/organizations/${organizationId}/invitations/direct`,
    CREATE_PHONE: (organizationId: string) => `/context/organizations/${organizationId}/invitations/phone`,
    LIST: (organizationId: string) => `/context/organizations/${organizationId}/invitations`,
    CANCEL: (organizationId: string, invitationId: string) => `/context/organizations/${organizationId}/invitations/${invitationId}`,
    INFO: (token: string) => `/context/invitations/${token}`,
    ACCEPT: (token: string) => `/context/invitations/${token}/accept`,
    MY_PENDING: '/context/invitations/my-pending',
    RESPOND: (invitationId: string) => `/context/invitations/${invitationId}/respond`,
  },

  ORGANIZATION_TRANSFER: (organizationId: string) => `/context/organizations/${organizationId}/transfer-ownership`,
  ORGANIZATION_AUDIT: (organizationId: string) => `/context/organizations/${organizationId}/audit-logs`,
  ORGANIZATION_ACTIVITY: (organizationId: string) => `/context/organizations/${organizationId}/activities`,

  NOTIFICATIONS: {
    LIST: '/notifications/',
    UNREAD_COUNT: '/notifications/unread-count',
    MARK_READ: (notificationId: string) => `/notifications/${notificationId}/read`,
    MARK_ALL_READ: '/notifications/read-all',
    ACKNOWLEDGE_AGENT_SESSION: (sessionId: string) =>
      `/notifications/agent-sessions/${encodeURIComponent(sessionId)}/acknowledge`,
  },

  RESOURCE_PERMISSIONS: {
    LIST: (resourceType: string, resourceId: string) => `/context/resources/${resourceType}/${resourceId}/permissions`,
    GRANT: (resourceType: string, resourceId: string) => `/context/resources/${resourceType}/${resourceId}/permissions`,
    REVOKE: (resourceType: string, resourceId: string, permissionId: string) => `/context/resources/${resourceType}/${resourceId}/permissions/${permissionId}`,
  },

  MEMBERSHIP: {
    TIERS: '/membership/tiers',
    ORGANIZATION_MEMBERSHIP: (organizationId: string) => `/membership/organizations/${organizationId}/membership`,
    ORGANIZATION_SUBSCRIPTION_OVERVIEW: (organizationId: string) =>
      `/membership/organizations/${organizationId}/overview`,
    ORGANIZATION_SUBSCRIPTION_PLANS: (organizationId: string) =>
      `/membership/organizations/${organizationId}/plans`,
    ORGANIZATION_PURCHASE: (organizationId: string) => `/membership/organizations/${organizationId}/purchase`,
    ORGANIZATION_PURCHASE_PREVIEW: (organizationId: string) =>
      `/membership/organizations/${organizationId}/purchase/preview`,
    ORGANIZATION_UPGRADE_PREVIEW: (organizationId: string) =>
      `/membership/organizations/${organizationId}/upgrade-preview`,
    ORGANIZATION_UPGRADE: (organizationId: string) =>
      `/membership/organizations/${organizationId}/upgrade`,
    ORGANIZATION_UPGRADE_ORDER: (organizationId: string, orderId: string) =>
      `/membership/organizations/${organizationId}/upgrade-orders/${orderId}`,
    ORGANIZATION_ACTIVE_UPGRADE_ORDER: (organizationId: string) =>
      `/membership/organizations/${organizationId}/upgrade-orders/active`,
    ORGANIZATION_UPGRADE_ORDER_WALLET_PAY: (organizationId: string, orderId: string) =>
      `/membership/organizations/${organizationId}/upgrade-orders/${orderId}/wallet-pay`,
    ORGANIZATION_AUTO_RENEW: (organizationId: string) => `/membership/organizations/${organizationId}/membership/auto-renew`,
  },

  WALLET: {
    PACKAGES: '/wallet/packages',
    RECHARGE: '/wallet/recharge',
    TRANSACTIONS: '/wallet/transactions',
    ORGANIZATION_WALLET: (organizationId: string) => `/wallet/organizations/${organizationId}/wallet`,
    ORGANIZATION_CASH_WALLET: (organizationId: string) => `/wallet/organizations/${organizationId}/cash-wallet`,
    ORGANIZATION_CASH_WALLET_RECHARGE: (organizationId: string) =>
      `/wallet/organizations/${organizationId}/cash-wallet/recharge`,
    ORGANIZATION_CASH_TRANSACTIONS: (organizationId: string) => `/wallet/organizations/${organizationId}/cash-transactions`,
    ORGANIZATION_TRANSACTIONS: (organizationId: string) => `/wallet/organizations/${organizationId}/transactions`,
    ORGANIZATION_TRANSACTIONS_EXPORT: (organizationId: string) => `/wallet/organizations/${organizationId}/transactions/export`,
    ORGANIZATION_DISPUTES: (organizationId: string) => `/wallet/organizations/${organizationId}/disputes`,
  },

  BILLING_ORGANIZATION: {
    SUMMARY: (organizationId: string) => `/services/billing/organizations/${organizationId}/summary`,
    ADDON_PACKAGES: '/services/billing/addon-packages',
    ADDON_PACKAGE_PURCHASE: (organizationId: string) =>
      `/services/billing/organizations/${organizationId}/addon-packages/purchase`,
    POLICY: (organizationId: string) => `/services/billing/organizations/${organizationId}/policy`,
    ENTITLEMENT: (organizationId: string) => `/services/billing/organizations/${organizationId}/entitlement`,
    INVOICES: (organizationId: string) => `/services/billing/organizations/${organizationId}/invoices`,
    INVOICE_DETAIL: (organizationId: string, invoiceId: string) =>
      `/services/billing/organizations/${organizationId}/invoices/${invoiceId}`,
    INVOICE_COLLECT: (organizationId: string, invoiceId: string) =>
      `/services/billing/organizations/${organizationId}/invoices/${invoiceId}/collect`,
    INVOICE_OVERVIEW: (organizationId: string) =>
      `/services/billing/organizations/${organizationId}/reports/invoice-overview`,
    USAGE_DASHBOARD: (organizationId: string) =>
      `/services/billing/organizations/${organizationId}/usage-dashboard`,
    USAGE_EVENTS: (organizationId: string) =>
      `/services/billing/organizations/${organizationId}/usage-events`,
    MEMBER_USAGE: (organizationId: string) =>
      `/services/billing/organizations/${organizationId}/member-usage`,
    SERVICE_CATALOG: (organizationId: string) =>
      `/services/billing/organizations/${organizationId}/service-catalog`,
    SERVICE_POLICY: (organizationId: string) =>
      `/services/billing/organizations/${organizationId}/service-policy`,
    COST_ESTIMATE: () => `/services/billing/estimate`,
    LOW_BALANCE_CONFIG: (organizationId: string) =>
      `/services/billing/organizations/${organizationId}/low-balance-config`,
  },

  PAYMENT: {
    QUERY: '/services/payment/query-order',
    CANCEL: '/services/payment/cancel-order',
    MY_ORDERS: '/services/payment/my-orders',
    // 账单中心「资金流水」组织级读接口：付款 + 退款按时间倒序混排
    ORGANIZATION_TRANSACTIONS: (organizationId: string) =>
      `/services/payment/organizations/${organizationId}/transactions`,
  },

  /**
   * @deprecated  Space 终态退役：所有 `/context/spaces/...` 均已迁移到
   *   `WORKSPACE.*`（个人域）或 `PROJECT.*`（团队域）。保留该常量仅供
   *   backend 迁移过渡期临时读；新代码禁止引用。目标：在 Space 表 DROP
   *   同批 PR 内彻底删除本 block。
   */
  SPACE: {
    LIST: '/context/spaces',
    CREATE: '/context/spaces',
    DETAIL: (spaceId: string) => `/context/spaces/${spaceId}`,
    UPDATE: (spaceId: string) => `/context/spaces/${spaceId}`,
    DELETE: (spaceId: string) => `/context/spaces/${spaceId}`,
    STATUS: (spaceId: string) => `/context/spaces/${spaceId}/status`,
    ARCHIVE: (spaceId: string) => `/context/spaces/${spaceId}/archive`,
    RESTORE: (spaceId: string) => `/context/spaces/${spaceId}/restore`,
    STATS: (spaceId: string) => `/context/spaces/${spaceId}/stats`,
    APP_SETTINGS: (spaceId: string) => `/context/spaces/${spaceId}/apps`,
    SEARCH: (spaceId: string) => `/context/spaces/${spaceId}/search`,
    CONTEXT_ITEMS: (spaceId: string) => `/context/spaces/${spaceId}/context-items`,
    /** @deprecated  请改用 CONTEXT_ITEM.DETAIL */
    CONTEXT_ITEM_DETAIL: (itemId: string) => `/context/context-items/${itemId}`,
    /** @deprecated  请改用 CONTEXT_ITEM.ACCESS */
    CONTEXT_ITEM_ACCESS: (itemId: string) => `/context/context-items/${itemId}/access`,
    /** @deprecated  请改用 WORKSPACE / PROJECT.FILE_UPLOAD */
    FILE_UPLOAD: (spaceId: string) => `/context/spaces/${spaceId}/files/upload`,
    /** @deprecated  请改用 WORKSPACE / PROJECT.FILE_DOWNLOAD_URL */
    FILE_DOWNLOAD_URL: (spaceId: string, itemId: string) =>
      `/context/spaces/${spaceId}/files/${itemId}/download-url`,
    TRASH: (spaceId: string) => `/context/spaces/${spaceId}/trash`,
    TRASH_EMPTY: (spaceId: string) => `/context/spaces/${spaceId}/trash/empty`,
    TRASH_SELF: (spaceId: string) => `/context/spaces/${spaceId}/trash-self`,
    RESTORE_FROM_TRASH: (spaceId: string) => `/context/spaces/${spaceId}/restore-from-trash`,
    PERMANENT_FROM_TRASH: (spaceId: string) => `/context/spaces/${spaceId}/permanent-from-trash`,
    MEMBERSHIPS: (spaceId: string) => `/context/spaces/${spaceId}/memberships`,
    MEMBERSHIP_REMOVE: (spaceId: string, membershipId: string) =>
      `/context/spaces/${spaceId}/memberships/${membershipId}`,
    AVAILABLE_TOOLS: (spaceId: string) => `/context/spaces/${spaceId}/available-tools`,
    ENSURE_EXECUTION_AGENT: (spaceId: string) =>
      `/context/spaces/${spaceId}/ensure-execution-agent`,
    ACTIVITIES: (spaceId: string) => `/context/spaces/${spaceId}/activities`,
  },

  /**
   * 全局 ContextItem（不挂在宿主路径下）。
   * 原先误挂在 SPACE.* 下，路径本身一直是 `/context/context-items/...`。
   */
  CONTEXT_ITEM: {
    DETAIL: (itemId: string) => `/context/context-items/${itemId}`,
    ACCESS: (itemId: string) => `/context/context-items/${itemId}/access`,
  },

  /**
   * 个人域执行现场（ 终态）。
   *
   * Workspace 是「个人 Space」的最终真身：`/context/workspaces/...` 为唯一 SSoT，
   * 承接资源、审批、Trash、成员、活动、能力发现等所有个人域操作。
   */
  WORKSPACE: {
    LIST: '/context/workspaces',
    CREATE: '/context/workspaces',
    ENSURE_HOME: '/context/workspaces/ensure-home',
    DETAIL: (workspaceId: string) => `/context/workspaces/${workspaceId}`,
    UPDATE: (workspaceId: string) => `/context/workspaces/${workspaceId}`,
    DELETE: (workspaceId: string) => `/context/workspaces/${workspaceId}`,
    STATS: (workspaceId: string) => `/context/workspaces/${workspaceId}/stats`,
    APP_SETTINGS: (workspaceId: string) => `/context/workspaces/${workspaceId}/apps`,
    SEARCH: (workspaceId: string) => `/context/workspaces/${workspaceId}/search`,
    CONTEXT_ITEMS: (workspaceId: string) =>
      `/context/workspaces/${workspaceId}/context-items`,
    FILE_UPLOAD: (workspaceId: string) =>
      `/context/workspaces/${workspaceId}/files/upload`,
    FILE_DOWNLOAD_URL: (workspaceId: string, itemId: string) =>
      `/context/workspaces/${workspaceId}/files/${itemId}/download-url`,
    /** ：补齐与 /spaces/... 别名对等的正式路径（文件级回收站三件套） */
    FILE_TRASH: (workspaceId: string, fileRecordId: string) =>
      `/context/workspaces/${workspaceId}/files/${fileRecordId}/trash`,
    FILE_RESTORE_FROM_TRASH: (workspaceId: string, fileRecordId: string) =>
      `/context/workspaces/${workspaceId}/files/${fileRecordId}/restore-from-trash`,
    FILE_PERMANENT_FROM_TRASH: (workspaceId: string, fileRecordId: string) =>
      `/context/workspaces/${workspaceId}/files/${fileRecordId}/permanent`,
    TRASH: (workspaceId: string) => `/context/workspaces/${workspaceId}/trash`,
    TRASH_EMPTY: (workspaceId: string) =>
      `/context/workspaces/${workspaceId}/trash/empty`,
    COLLECTIONS: (workspaceId: string) =>
      `/context/workspaces/${workspaceId}/collections`,
    COLLECTIONS_REORDER: (workspaceId: string) =>
      `/context/workspaces/${workspaceId}/collections/reorder`,
    COLLECTIONS_MOVE_ITEMS: (workspaceId: string) =>
      `/context/workspaces/${workspaceId}/collections/move-items`,
    COLLECTIONS_REORDER_ITEMS: (workspaceId: string) =>
      `/context/workspaces/${workspaceId}/collections/reorder-items`,
    MEMBERSHIPS: (workspaceId: string) =>
      `/context/workspaces/${workspaceId}/memberships`,
    MEMBERSHIP_REMOVE: (workspaceId: string, membershipId: string) =>
      `/context/workspaces/${workspaceId}/memberships/${membershipId}`,
    AVAILABLE_TOOLS: (workspaceId: string) =>
      `/context/workspaces/${workspaceId}/available-tools`,
    ENSURE_EXECUTION_AGENT: (workspaceId: string) =>
      `/context/workspaces/${workspaceId}/ensure-execution-agent`,
    ACTIVITIES: (workspaceId: string) =>
      `/context/workspaces/${workspaceId}/activities`,
    APPROVAL_GRANT: (workspaceId: string) =>
      `/context/workspaces/${workspaceId}/approval-grant`,
    CAPABILITY_DISCOVERY: (workspaceId: string) =>
      `/context/workspaces/${workspaceId}/capability-discovery`,
    CAPABILITY_REFRESH: (workspaceId: string) =>
      `/context/workspaces/${workspaceId}/capability-refresh`,
    BIND_DEVICE: (workspaceId: string) =>
      `/context/workspaces/${workspaceId}/device`,
  },

  /**
   * 团队域协作场景（ 终态）。
   *
   * Project 是「团队 Space」的最终真身：承载 Task / 成员 / 资源引用 / 动态。
   * 执行绑定通过 `Project.workspace/ensure` 指向 owner 的 Workspace。
   */
  PROJECT: {
    LIST: '/context/projects',
    CREATE: '/context/projects',
    CREATE_WITH_WORKSPACE: '/context/projects/create-with-workspace',
    DETAIL: (projectId: string) => `/context/projects/${projectId}`,
    UPDATE: (projectId: string) => `/context/projects/${projectId}`,
    DELETE: (projectId: string) => `/context/projects/${projectId}`,
    PENDING_INVITATIONS: '/context/projects/invitations/pending',
    /** Owner 侧：列出某 Project 尚未接受的邀请 */
    PROJECT_INVITATIONS: (projectId: string) => `/context/projects/${projectId}/invitations`,
    INVITE: (projectId: string) => `/context/projects/${projectId}/invitations`,
    INVITE_ACCEPT: (projectId: string) =>
      `/context/projects/${projectId}/invitations/accept`,
    INVITE_REJECT: (projectId: string) =>
      `/context/projects/${projectId}/invitations/reject`,
    WORKSPACE_ENSURE: (projectId: string) =>
      `/context/projects/${projectId}/workspace/ensure`,
    MEMBERSHIPS: (projectId: string) =>
      `/context/projects/${projectId}/memberships`,
    MEMBERSHIP_REMOVE: (projectId: string, membershipId: string) =>
      `/context/projects/${projectId}/memberships/${membershipId}`,
    AVAILABLE_TOOLS: (projectId: string) =>
      `/context/projects/${projectId}/available-tools`,
    ACTIVITIES: (projectId: string) => `/context/projects/${projectId}/activities`,
    CONTEXT_ITEMS: (projectId: string) =>
      `/context/projects/${projectId}/context-items`,
    FILE_UPLOAD: (projectId: string) =>
      `/context/projects/${projectId}/files/upload`,
    FILE_DOWNLOAD_URL: (projectId: string, itemId: string) =>
      `/context/projects/${projectId}/files/${itemId}/download-url`,
    /** ：补齐与 /spaces/... 别名对等的正式路径（文件级回收站三件套） */
    FILE_TRASH: (projectId: string, fileRecordId: string) =>
      `/context/projects/${projectId}/files/${fileRecordId}/trash`,
    FILE_RESTORE_FROM_TRASH: (projectId: string, fileRecordId: string) =>
      `/context/projects/${projectId}/files/${fileRecordId}/restore-from-trash`,
    FILE_PERMANENT_FROM_TRASH: (projectId: string, fileRecordId: string) =>
      `/context/projects/${projectId}/files/${fileRecordId}/permanent`,
    TASKS: (projectId: string) => `/context/projects/${projectId}/tasks`,
    /** ：按 Agent 跨 Project 聚合任务 */
    AGENT_TASKS: (organizationId: string, agentId: string) =>
      `/context/organizations/${organizationId}/agents/${agentId}/tasks`,
    TASK_INBOX: (projectId: string) => `/context/projects/${projectId}/tasks/inbox`,
    TASK_DETAIL: (projectId: string, taskId: string) =>
      `/context/projects/${projectId}/tasks/${taskId}`,
    TASK_COMMENTS: (projectId: string, taskId: string) =>
      `/context/projects/${projectId}/tasks/${taskId}/comments`,
    TASK_ASSIGNMENT_RESPONSE: (projectId: string, taskId: string) =>
      `/context/projects/${projectId}/tasks/${taskId}/assignment-response`,
    TASK_EXECUTION: (projectId: string, taskId: string) =>
      `/context/projects/${projectId}/tasks/${taskId}/execution`,
    TASK_RUNS: (projectId: string, taskId: string) =>
      `/context/projects/${projectId}/tasks/${taskId}/runs`,
    TASK_RUN_PREPARE: (projectId: string, taskId: string) =>
      `/context/projects/${projectId}/tasks/${taskId}/runs/prepare`,
    TASK_CANCEL: (projectId: string, taskId: string) =>
      `/context/projects/${projectId}/tasks/${taskId}/cancel`,
    TASK_ACCEPTANCE: (projectId: string, taskId: string) =>
      `/context/projects/${projectId}/tasks/${taskId}/acceptance`,
    TASK_RESULT_VISIBILITY: (projectId: string, taskId: string) =>
      `/context/projects/${projectId}/tasks/${taskId}/result-visibility`,
    ARCHIVE: (projectId: string) => `/context/projects/${projectId}/archive`,
    RESTORE: (projectId: string) => `/context/projects/${projectId}/restore`,
    TRASH: (projectId: string) => `/context/projects/${projectId}/trash`,
    RESTORE_FROM_TRASH: (projectId: string) =>
      `/context/projects/${projectId}/restore-from-trash`,
    PERMANENT_FROM_TRASH: (projectId: string) =>
      `/context/projects/${projectId}/permanent-from-trash`,
  },

  DEVICE: {
    REGISTER: '/context/devices/register',
    HEARTBEAT: '/context/devices/heartbeat',
    TOKEN_RENEW: '/context/devices/token/renew',
    OFFLINE: '/context/devices/offline',
    INSTALL_TOKEN: '/context/devices/install-token',
    LIST: '/context/devices/',
    UPDATE: (deviceId: string) => `/context/devices/${deviceId}`,
    DELETE: (deviceId: string) => `/context/devices/${deviceId}`,
    /**
     * @deprecated  使用 `WORKSPACE.BIND_DEVICE` / `WORKSPACE.CAPABILITY_*`。
     */
    BIND_SPACE: (workspaceId: string) => `/context/workspaces/${workspaceId}/device`,
    /** @deprecated  使用 `WORKSPACE.CAPABILITY_DISCOVERY`。 */
    CAPABILITY_DISCOVERY: (workspaceId: string) =>
      `/context/workspaces/${workspaceId}/capability-discovery`,
    /** @deprecated  使用 `WORKSPACE.CAPABILITY_REFRESH`。 */
    CAPABILITY_REFRESH: (workspaceId: string) =>
      `/context/workspaces/${workspaceId}/capability-refresh`,
  },

  SSH: {
    LIST: (deviceId: string) => `/context/devices/${deviceId}/ssh-servers`,
    CREATE: (deviceId: string) => `/context/devices/${deviceId}/ssh-servers`,
    UPDATE: (serverId: string) => `/context/ssh-servers/${serverId}`,
    DELETE: (serverId: string) => `/context/ssh-servers/${serverId}`,
    TEST: (serverId: string) => `/context/ssh-servers/${serverId}/test`,
    RESET_HOST_KEY: (serverId: string) => `/context/ssh-servers/${serverId}/reset-host-key`,
  },

  // 设置 IA Phase 1·1C：本地 MCP 连接（device 维度，对仗 SSH 段）。
  // PROBE 只写入 Electron 端回传的健康结果，后端不真连。
  MCP_CONNECTION: {
    LIST: (deviceId: string) => `/context/devices/${deviceId}/mcp-connections`,
    CREATE: (deviceId: string) => `/context/devices/${deviceId}/mcp-connections`,
    LIST_ORG: (organizationId: string) => `/context/organizations/${organizationId}/mcp-connections`,
    CREATE_ORG: (organizationId: string) => `/context/organizations/${organizationId}/mcp-connections`,
    UPDATE: (connectionId: string) => `/context/mcp-connections/${connectionId}`,
    DELETE: (connectionId: string) => `/context/mcp-connections/${connectionId}`,
    PROBE: (connectionId: string) => `/context/mcp-connections/${connectionId}/probe`,
    RUNTIME_CONFIG: (connectionId: string) => `/context/mcp-connections/${connectionId}/runtime-config`,
  },

  SKILLS: {
    /**
     * Wave 1（PRD V3.3 §9.1）— 4 来源 + enabled。
     * ：技能库目录只需 organization_id；agent_id 可选（携带态，Agent 设置/斜杠/兼容旧调用）。
     */
    VISIBLE: (organizationId: string, agentId?: string | null) => {
      const qs = new URLSearchParams({ organization_id: organizationId })
      if (agentId) qs.set('agent_id', agentId)
      return `/skills/visible?${qs.toString()}`
    },
    /** Agent runtime 用：合并 + enabled 过滤后的索引 */
    INDEX: (organizationId: string, agentId?: string | null) => {
      const qs = new URLSearchParams({ organization_id: organizationId })
      if (agentId) qs.set('agent_id', agentId)
      return `/skills/index?${qs.toString()}`
    },
    MARKET: (params?: { q?: string; category?: string }) => {
      const qs = new URLSearchParams();
      if (params?.q) qs.set('q', params.q);
      if (params?.category) qs.set('category', params.category);
      const suffix = qs.toString();
      return `/skills/market${suffix ? `?${suffix}` : ''}`;
    },
    /** UI 字段配置面板用 */
    REGISTRY: (organizationId?: string) =>
      `/skills/registry${organizationId ? `?organization_id=${organizationId}` : ''}`,
    /** Wave 1：创建 / 启用 / 禁用 / 改 visibility / 丢弃草稿 */
    CREATE: '/skills/create',
    ENABLE: (canonicalKey: string) =>
      `/skills/${encodeURIComponent(canonicalKey)}/enable`,
    DISABLE: (canonicalKey: string) =>
      `/skills/${encodeURIComponent(canonicalKey)}/disable`,
    UPDATE_VISIBILITY: (skillId: string) => `/skills/${skillId}/visibility`,
    UPDATE_CATEGORY: (skillId: string) => `/skills/${skillId}/category`,
    /** 快速使用模板草稿（写 Skill.quick_use_json；发布时随版本快照） */
    UPDATE_QUICK_USE: (skillId: string) => `/skills/${skillId}/quick-use`,
    PUBLISH: (skillId: string) => `/skills/${skillId}/publish`,
    DISCARD_DRAFT: (skillId: string) => `/skills/${skillId}/draft`,
    /** 删除 owner 自己的 user skill（含已发布；后端校验无他人启用） */
    DELETE_SKILL: (skillId: string) => `/skills/${skillId}`,
    /** Wave 4：版本列表 / 升级 / 导入 */
    VERSIONS: (skillId: string) => `/skills/${skillId}/versions`,
    ACTIVATE_VERSION: (skillId: string) => `/skills/${skillId}/activate-version`,
    UPGRADE: (skillId: string) => `/skills/${skillId}/upgrade`,
    IMPORT: '/skills/import',
    SAVE_AS_COPY: '/skills/import',
    EXPORT: (skillId: string) => `/skills/${skillId}/export`,
    /** AgentSkillLink.config_json 读写（ 锚点 organization + agent） */
    CONFIG_LIST: (organizationId: string, agentId?: string | null) => {
      const qs = new URLSearchParams({ organization_id: organizationId })
      if (agentId) qs.set('agent_id', agentId)
      return `/skills/config?${qs.toString()}`
    },
    CONFIG_UPDATE: (canonicalKey: string) =>
      `/skills/config/${encodeURIComponent(canonicalKey)}`,
    /** SKILL.md 全文（PR PackageFile 反查） */
    SKILL_PACKAGE: (canonicalKey: string) =>
      `/skills/${encodeURIComponent(canonicalKey)}/package`,
  },

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

  FIELD: {
    LIST: (tableId: string) => `/tabdata/tables/${tableId}/fields`,
    CREATE: '/tabdata/fields',
    BULK_CREATE: (tableId: string) => `/tabdata/tables/${tableId}/fields/bulk`,
    DETAIL: (fieldId: string) => `/tabdata/fields/${fieldId}`,
    UPDATE: (fieldId: string) => `/tabdata/fields/${fieldId}`,
    DELETE: (fieldId: string) => `/tabdata/fields/${fieldId}`,
    REORDER: (tableId: string) => `/tabdata/tables/${tableId}/fields/reorder`,
    CONVERT: (fieldId: string) => `/tabdata/fields/${fieldId}/convert`,
  },

  LINK_FIELD: {
    LINKABLE_RECORDS: (tableId: string, fieldId: string) =>
      `/tabdata/tables/${tableId}/fields/${fieldId}/linkable-records`,
    LINKABLE_FIELDS: (tableId: string, fieldId: string) =>
      `/tabdata/tables/${tableId}/fields/${fieldId}/linkable-fields`,
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
    UPDATE_BY_FILTER_PREFLIGHT: (tableId: string) =>
      `/tabdata/tables/${tableId}/records/update-by-filter/preflight`,
    UPDATE_BY_FILTER_COMMIT: (tableId: string) =>
      `/tabdata/tables/${tableId}/records/update-by-filter/commit`,
  },

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

  // EXTRACT 模块已移除：后端 /extract/ 下无 recommend-schemas / history-schemas /
  // save-user-schema / record-schema-usage 四条路由（后端仅有 generate-schema 等），
  // renderer 内也无外部调用方。原 api.ts 对应方法已同步清理。

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
    FORM_SUBMIT_DIRECT: (tableId: string, viewId: string) =>
      `/tabdata/tables/${tableId}/views/${viewId}/form-submit`,
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
    TABLE_NAMED_VERSION_DETAIL: (tableId: string, versionId: string) =>
      `/tabdata/tables/${tableId}/named-versions/${versionId}`,
  },

  /**
   * Open API 对外接口（`/open/v1/*`）。
   *
   * TODO( backend): 目前仍以 `spaces` 命名，backend 迁移完成后按新版协议
   *   （workspaces）切换；同期需与移动端/第三方约定过渡窗口。
   */
  OPEN_API: {
    SPACES: '/open/v1/spaces',
    SPACE_TABLES: (spaceId: string) => `/open/v1/spaces/${spaceId}/data/tables`,
  },

  // TABDATA_OPEN 已移除：后端 open API 注册在 /open/v1（非 /tabdata/open/v1），
  // 且路径结构为 /open/v1/spaces/{spaceId}/data/tables/{tableId}/records（需 spaceId）。
  // renderer 内无调用方；daemon 端调用方已改为本地定义。

  TABDOC: {
    DOCUMENTS: '/tabdoc/documents',
    DOCUMENT_DETAIL: (docId: string) => `/tabdoc/documents/${docId}`,
    DOCUMENT_EXPORT: (docId: string, format: string) =>
      `/tabdoc/documents/${docId}/export?format=${encodeURIComponent(format)}`,
    DOCUMENT_CONTENT: (docId: string) => `/tabdoc/documents/${docId}/content`,
    DOCUMENT_AGENT_WRITE: (docId: string) => `/tabdoc/documents/${docId}/agent-write`,
    SEARCH: '/tabdoc/search',
  },

  TABMEMO: {
    MEMOS: '/tabmemo/memos/',
    MEMO_DETAIL: (memoId: string) => `/tabmemo/memos/${memoId}/`,
    STATS: '/tabmemo/stats/',
  },

  FTS: {
    SEARCH: '/search',
  },

  /** Marketplace 公共配置（PRD §5.4 B3）。endpoint 级 ``auth=None`` 可匿名拉取。 */
  MARKETPLACE: {
    /** 聚合 marketplace App ``embeddedWeb.urlPatterns``，供 Electron AppDiscovery 主进程消费。 */
    DISCOVERY_PATTERNS: '/marketplace/discovery-patterns',
  },

} as const;

/**
 * @deprecated  Space 终态退役：使用 `API_ENDPOINTS.WORKSPACE` /
 *   `API_ENDPOINTS.PROJECT`。保留此别名仅供尚未迁移的调用方兜底。
 */
export const AGENT_SPACE = API_ENDPOINTS.SPACE;
