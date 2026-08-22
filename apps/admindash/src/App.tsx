import { MessageHost } from '@tabtin/smartsheet-ui/message'
import { type ReactNode, Suspense, lazy } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Layout } from './components/layout/layout'
import { ProtectedRoute } from './components/layout/protected-route'
import { ADMIN_PERMISSION, hasAdminPermission } from './lib/admin-permissions'
import { useAuthStore } from './stores/auth-store'

const LoginPage = lazy(() => import('./pages/login').then((m) => ({ default: m.LoginPage })))
const UsersPage = lazy(() => import('./pages/users').then((m) => ({ default: m.UsersPage })))
const IntentUsersPage = lazy(() =>
  import('./pages/intent-users').then((m) => ({ default: m.IntentUsersPage }))
)
const InviteCodeManagementPage = lazy(() =>
  import('./invite-code-management/pages/InviteCodeManagementPage').then((m) => ({
    default: m.InviteCodeManagementPage,
  }))
)
const AdminAccountsPage = lazy(() =>
  import('./pages/admin-accounts').then((m) => ({ default: m.AdminAccountsPage }))
)
const AdminRbacPage = lazy(() =>
  import('./pages/admin-rbac').then((m) => ({ default: m.AdminRbacPage }))
)
const AdminSensitiveActionsPage = lazy(() =>
  import('./pages/admin-sensitive-actions').then((m) => ({
    default: m.AdminSensitiveActionsPage,
  }))
)
const AdminLoginLogsPage = lazy(() =>
  import('./pages/admin-login-logs').then((m) => ({ default: m.AdminLoginLogsPage }))
)
const OperationsDashboardPage = lazy(() =>
  import('./pages/operations-dashboard').then((m) => ({ default: m.OperationsDashboardPage }))
)
const TableManagementPage = lazy(() =>
  import('./table-management/pages/TableManagementPage').then((m) => ({
    default: m.TableManagementPage,
  }))
)
const TableManagementDetailPage = lazy(() =>
  import('./table-management/pages/TableManagementDetailPage').then((m) => ({
    default: m.TableManagementDetailPage,
  }))
)
const TableOperationsPage = lazy(() =>
  import('./table-management/pages/TableOperationsPage').then((m) => ({
    default: m.TableOperationsPage,
  }))
)
const DocManagementPage = lazy(() =>
  import('./doc-management/pages/DocManagementPage').then((m) => ({
    default: m.DocManagementPage,
  }))
)
const DocManagementDetailPage = lazy(() =>
  import('./doc-management/pages/DocManagementDetailPage').then((m) => ({
    default: m.DocManagementDetailPage,
  }))
)
const DocOperationsPage = lazy(() =>
  import('./doc-management/pages/DocOperationsPage').then((m) => ({
    default: m.DocOperationsPage,
  }))
)
const ShareManagementPage = lazy(() =>
  import('./share-management/pages/ShareManagementPage').then((m) => ({
    default: m.ShareManagementPage,
  }))
)
const OssManagementPage = lazy(() =>
  import('./oss-management/pages/OssManagementPage').then((m) => ({
    default: m.OssManagementPage,
  }))
)
const OssManagementDetailPage = lazy(() =>
  import('./oss-management/pages/OssManagementDetailPage').then((m) => ({
    default: m.OssManagementDetailPage,
  }))
)
const OssOperationsPage = lazy(() =>
  import('./oss-management/pages/OssOperationsPage').then((m) => ({
    default: m.OssOperationsPage,
  }))
)
const OrganizationsListPage = lazy(() =>
  import('./pages/organizations').then((m) => ({ default: m.OrganizationsListPage }))
)
const OrganizationDetailPage = lazy(() => import('./pages/organization-detail'))
const SpacesListPage = lazy(() =>
  import('./pages/space-list').then((m) => ({ default: m.SpacesListPage }))
)
const SpaceDetailPage = lazy(() =>
  import('./pages/space-list').then((m) => ({ default: m.SpaceDetailPage }))
)

const ContentOpsPage = lazy(() =>
  import('./content-ops/pages/ContentOpsPage').then((m) => ({ default: m.ContentOpsPage }))
)
const SlideManagementPage = lazy(() =>
  import('./slide-management/pages/SlideManagementPage').then((m) => ({
    default: m.SlideManagementPage,
  }))
)
const SlideOperationsPage = lazy(() =>
  import('./slide-management/pages/SlideOperationsPage').then((m) => ({
    default: m.SlideOperationsPage,
  }))
)
const MailManagementPage = lazy(() =>
  import('./mail-management/pages/MailManagementPage').then((m) => ({
    default: m.MailManagementPage,
  }))
)
const MailOperationsPage = lazy(() =>
  import('./mail-management/pages/MailOperationsPage').then((m) => ({
    default: m.MailOperationsPage,
  }))
)

const ThreadListPage = lazy(() =>
  import('./pages/agent-debug/thread-list').then((m) => ({ default: m.ThreadListPage }))
)
const ThreadDetailPage = lazy(() =>
  import('./pages/agent-debug/thread-detail').then((m) => ({ default: m.ThreadDetailPage }))
)
const TraceDetailPage = lazy(() =>
  import('./pages/agent-debug/trace-detail').then((m) => ({ default: m.TraceDetailPage }))
)
const ErrorDashboardPage = lazy(() =>
  import('./pages/agent-debug/error-dashboard').then((m) => ({ default: m.ErrorDashboardPage }))
)
const ToolOverviewPage = lazy(() =>
  import('./tool-management/pages/ToolOverviewPage').then((m) => ({
    default: m.ToolOverviewPage,
  }))
)
const ToolDetailPage = lazy(() =>
  import('./tool-management/pages/ToolDetailPage').then((m) => ({
    default: m.ToolDetailPage,
  }))
)
const ToolAuditPage = lazy(() =>
  import('./tool-management/pages/ToolAuditPage').then((m) => ({
    default: m.ToolAuditPage,
  }))
)
const BillingDashboardPage = lazy(() =>
  import('./billing-management/pages/BillingDashboard').then((m) => ({
    default: m.BillingDashboard,
  }))
)
const WalletManagementPage = lazy(() =>
  import('./billing-management/pages/WalletManagement').then((m) => ({
    default: m.WalletManagement,
  }))
)
const WalletDetailPage = lazy(() =>
  import('./billing-management/pages/WalletDetail').then((m) => ({
    default: m.WalletDetail,
  }))
)
const ProviderCreditManagementPage = lazy(() =>
  import('./billing-management/pages/ProviderCreditManagement').then((m) => ({
    default: m.ProviderCreditManagement,
  }))
)
const BillingEventsPage = lazy(() =>
  import('./billing-management/pages/BillingEvents').then((m) => ({
    default: m.BillingEvents,
  }))
)
const BudgetManagementPage = lazy(() =>
  import('./billing-management/pages/BudgetManagement').then((m) => ({
    default: m.BudgetManagement,
  }))
)
const ProductConfigPage = lazy(() =>
  import('./billing-management/pages/ProductConfigPage').then((m) => ({
    default: m.ProductConfigPage,
  }))
)
const AuditLogPage = lazy(() =>
  import('./billing-management/pages/AuditLog').then((m) => ({
    default: m.AuditLog,
  }))
)
const ReconciliationPage = lazy(() =>
  import('./billing-management/pages/ReconciliationPage').then((m) => ({
    default: m.ReconciliationPage,
  }))
)
const AnomalyAlertsPage = lazy(() =>
  import('./billing-management/pages/AnomalyAlertsPage').then((m) => ({
    default: m.AnomalyAlertsPage,
  }))
)
const CostAnalysisPage = lazy(() =>
  import('./billing-management/pages/CostAnalysisPage').then((m) => ({
    default: m.CostAnalysisPage,
  }))
)
const StorageBillingPage = lazy(() =>
  import('./billing-management/pages/StorageBillingPage').then((m) => ({
    default: m.StorageBillingPage,
  }))
)
const OrganizationCleanupPage = lazy(() =>
  import('./billing-management/pages/OrganizationCleanupPage').then((m) => ({
    default: m.OrganizationCleanupPage,
  }))
)
const OrganizationCreditExplanationPage = lazy(() =>
  import('./billing-management/pages/OrganizationCreditExplanationPage').then((m) => ({
    default: m.OrganizationCreditExplanationPage,
  }))
)
const PaymentOrdersPage = lazy(() =>
  import('./billing-management/pages/PaymentOrdersPage').then((m) => ({
    default: m.PaymentOrdersPage,
  }))
)
const DisputeManagementPage = lazy(() =>
  import('./billing-management/pages/DisputeManagement').then((m) => ({
    default: m.DisputeManagement,
  }))
)
const TrashManagementPage = lazy(() =>
  import('./trash-management/pages/TrashManagementPage').then((m) => ({
    default: m.TrashManagementPage,
  }))
)
const DesktopUpdateManagementPage = lazy(() =>
  import('./update-management/pages/DesktopUpdateManagementPage').then((m) => ({
    default: m.DesktopUpdateManagementPage,
  }))
)
const MobileVersionPage = lazy(() =>
  import('./mobile-version/pages/MobileVersionPage').then((m) => ({
    default: m.MobileVersionPage,
  }))
)
const ClientErrorsPage = lazy(() =>
  import('./client-errors/pages/ClientErrorsPage').then((m) => ({
    default: m.ClientErrorsPage,
  }))
)
const DiagnosticsInboxPage = lazy(() =>
  import('./diagnostics/pages/DiagnosticsInboxPage').then((m) => ({ default: m.DiagnosticsInboxPage }))
)
const MarketingPage = lazy(() =>
  import('./marketing/pages/MarketingPage').then((m) => ({
    default: m.MarketingPage,
  }))
)
const AppInstallManagementPage = lazy(() =>
  import('./app-platform/pages/AppInstallManagementPage').then((m) => ({
    default: m.AppInstallManagementPage,
  }))
)
const AppAuthorizationPage = lazy(() =>
  import('./app-platform/pages/AppAuthorizationPage').then((m) => ({
    default: m.AppAuthorizationPage,
  }))
)
const ConnectManagementPage = lazy(() =>
  import('./app-platform/pages/ConnectManagementPage').then((m) => ({
    default: m.ConnectManagementPage,
  }))
)
const CliAuditPage = lazy(() =>
  import('./app-platform/pages/CliAuditPage').then((m) => ({
    default: m.CliAuditPage,
  }))
)
const PermissionAuditPage = lazy(() =>
  import('./app-platform/pages/PermissionAuditPage').then((m) => ({
    default: m.PermissionAuditPage,
  }))
)
const SkillReviewPage = lazy(() =>
  import('./skill-review/pages/SkillReviewPage').then((m) => ({
    default: m.SkillReviewPage,
  }))
)

// v0.1 AI 能力 — 4 组 17 个二级页面
const ScenesPage = lazy(() =>
  import('./ai-admin/pages/ScenesPage').then((m) => ({ default: m.ScenesPage }))
)
const ProvidersPage = lazy(() =>
  import('./ai-admin/pages/ProvidersPage').then((m) => ({ default: m.ProvidersPage }))
)
const ModelsPage = lazy(() =>
  import('./ai-admin/pages/ModelsPage').then((m) => ({ default: m.ModelsPage }))
)
const PromptsPage = lazy(() =>
  import('./ai-admin/pages/PromptsPage').then((m) => ({ default: m.PromptsPage }))
)
const EmbeddingPage = lazy(() =>
  import('./ai-admin/pages/EmbeddingPage').then((m) => ({ default: m.EmbeddingPage }))
)
const MultimodalPage = lazy(() =>
  import('./ai-admin/pages/MultimodalPage').then((m) => ({ default: m.MultimodalPage }))
)
const AiOpsRuntimePage = lazy(() =>
  import('./ai-ops/pages/RuntimePage').then((m) => ({ default: m.RuntimePage }))
)
const AiOpsUsagePage = lazy(() =>
  import('./ai-ops/pages/UsagePage').then((m) => ({ default: m.UsagePage }))
)
const AiOpsAuditPage = lazy(() =>
  import('./ai-ops/pages/AuditPage').then((m) => ({ default: m.AuditPage }))
)
const AiOpsIncidentPage = lazy(() =>
  import('./ai-ops/pages/IncidentPage').then((m) => ({ default: m.IncidentPage }))
)
const AgentEnginePage = lazy(() =>
  import('./agent-config/pages/EnginePage').then((m) => ({ default: m.EnginePage }))
)
const AgentContextPage = lazy(() =>
  import('./agent-config/pages/ContextPage').then((m) => ({ default: m.ContextPage }))
)
const AgentGuardPage = lazy(() =>
  import('./agent-config/pages/GuardPage').then((m) => ({ default: m.GuardPage }))
)
const AgentFeaturesPage = lazy(() =>
  import('./agent-config/pages/FeaturesPage').then((m) => ({ default: m.FeaturesPage }))
)
const AgentCleanupPage = lazy(() =>
  import('./agent-config/pages/CleanupPage').then((m) => ({ default: m.CleanupPage }))
)
const ExternalSearchAdminPage = lazy(() =>
  import('./external/search-admin/pages/SearchAdminPage').then((m) => ({
    default: m.SearchAdminPage,
  }))
)
const PlatformConfigPage = lazy(() =>
  import('./platform-config/pages/PlatformConfigPage').then((m) => ({
    default: m.PlatformConfigPage,
  }))
)
const OpsUsersPage = lazy(() =>
  import('./ops-governance/pages').then((m) => ({ default: m.OpsUsersPage }))
)
const OpsIncidentsPage = lazy(() =>
  import('./ops-governance/pages').then((m) => ({
    default: () => <m.OpsP2PlaceholderPage kind="incidents" />,
  }))
)
const OpsCostSlaPage = lazy(() =>
  import('./ops-governance/pages').then((m) => ({
    default: () => <m.OpsP2PlaceholderPage kind="cost-sla" />,
  }))
)
const OpsFinanceTracePage = lazy(() =>
  import('./ops-governance/pages').then((m) => ({ default: m.OpsFinanceTracePage }))
)
const OpsAuditPage = lazy(() =>
  import('./ops-governance/pages').then((m) => ({ default: m.OpsAuditPage }))
)
const MonitoringQueuesPage = lazy(() =>
  import('./ops-governance/pages').then((m) => ({ default: m.MonitoringQueuesPage }))
)
const MonitoringConsumersPage = lazy(() =>
  import('./ops-governance/pages').then((m) => ({ default: m.MonitoringConsumersPage }))
)
const MonitoringWebSocketPage = lazy(() =>
  import('./ops-governance/pages').then((m) => ({ default: m.MonitoringWebSocketPage }))
)
const MonitoringCollabPage = lazy(() =>
  import('./ops-governance/pages').then((m) => ({ default: m.MonitoringCollabPage }))
)
const MonitoringImPage = lazy(() =>
  import('./ops-governance/pages').then((m) => ({ default: m.MonitoringImPage }))
)
const MonitoringMessagesPage = lazy(() =>
  import('./ops-governance/pages').then((m) => ({ default: m.MonitoringMessagesPage }))
)

function LoadingFallback() {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <span className="text-body">页面加载中...</span>
    </div>
  )
}

function withSuspense(element: ReactNode) {
  return <Suspense fallback={<LoadingFallback />}>{element}</Suspense>
}

function PermissionFallback() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md rounded-lg border bg-card p-6 text-center shadow-sm">
        <h2 className="text-subtitle font-semibold">无权限访问</h2>
        <p className="mt-2 text-body text-muted-foreground">
          当前账号没有该后台模块的权限。请联系超管调整 AdminDash 权限后再试。
        </p>
      </div>
    </div>
  )
}

function AdminPermissionGate({
  permission,
  children,
}: {
  permission: string | string[]
  children: ReactNode
}) {
  const { adminPermissions, adminPermissionsLoaded } = useAuthStore()
  if (!adminPermissionsLoaded) {
    return <LoadingFallback />
  }
  if (!hasAdminPermission(adminPermissions, permission)) {
    return <PermissionFallback />
  }
  return <>{children}</>
}

function withAdminPermission(element: ReactNode, permission: string | string[]) {
  return withSuspense(<AdminPermissionGate permission={permission}>{element}</AdminPermissionGate>)
}

/** 旧「账单管理」入口兼容：保留 query，并把 organization_id 映射为支付订单 organization。 */
function RedirectBillingInvoicesToPaymentOrders() {
  const { search } = useLocation()
  const params = new URLSearchParams(search)
  const organizationId = (params.get('organization_id') || '').trim()
  if (organizationId && !(params.get('organization') || '').trim()) {
    params.set('organization', organizationId)
  }
  params.delete('organization_id')
  params.delete('invoiceId')
  params.delete('keyword')
  const next = params.toString()
  return <Navigate to={`/billing/payment-orders${next ? `?${next}` : ''}`} replace />
}

export function App() {
  return (
    <BrowserRouter>
      <MessageHost />
      <Routes>
        <Route path="/login" element={withSuspense(<LoginPage />)} />

        <Route element={<ProtectedRoute />}>
          <Route path="/" element={<Layout />}>
            {/* Agent Debug 三层架构 */}
            <Route
              index
              element={withAdminPermission(
                <OperationsDashboardPage />,
                ADMIN_PERMISSION.BILLING_DASHBOARD_VIEW
              )}
            />
            <Route path="threads" element={withSuspense(<ThreadListPage />)} />
            <Route path="threads/:threadId" element={withSuspense(<ThreadDetailPage />)} />
            <Route path="traces/:traceId" element={withSuspense(<TraceDetailPage />)} />
            <Route path="agent-errors" element={withSuspense(<ErrorDashboardPage />)} />

            {/* 数据 & 内容 */}
            <Route path="content" element={withSuspense(<ContentOpsPage />)} />
            <Route path="tables" element={withSuspense(<TableManagementPage />)} />
            <Route path="tables/operations" element={withSuspense(<TableOperationsPage />)} />
            <Route path="tables/:tableId" element={withSuspense(<TableManagementDetailPage />)} />
            <Route path="docs" element={withSuspense(<DocManagementPage />)} />
            <Route path="docs/operations" element={withSuspense(<DocOperationsPage />)} />
            <Route path="docs/:documentId" element={withSuspense(<DocManagementDetailPage />)} />
            <Route
              path="shares"
              element={withAdminPermission(<ShareManagementPage />, ADMIN_PERMISSION.SHARE_LIST)}
            />
            <Route path="slides" element={withSuspense(<SlideManagementPage />)} />
            <Route path="slides/operations" element={withSuspense(<SlideOperationsPage />)} />
            <Route path="mail" element={withSuspense(<MailManagementPage />)} />
            <Route path="mail/operations" element={withSuspense(<MailOperationsPage />)} />
            <Route path="assets" element={withSuspense(<OssManagementPage />)} />
            <Route path="assets/operations" element={withSuspense(<OssOperationsPage />)} />
            <Route path="assets/:fileId" element={withSuspense(<OssManagementDetailPage />)} />
            {/* 组织管理 */}
            <Route path="organizations" element={withSuspense(<OrganizationsListPage />)} />
            <Route
              path="organizations/:organizationId"
              element={withSuspense(<OrganizationDetailPage />)}
            />

            {/* Space 管理 */}
            <Route path="spaces" element={withSuspense(<SpacesListPage />)} />
            <Route path="spaces/:spaceId" element={withSuspense(<SpaceDetailPage />)} />

            <Route path="users" element={withSuspense(<UsersPage />)} />
            <Route path="customers/user-diagnose" element={withSuspense(<OpsUsersPage />)} />
            <Route path="intent-users" element={withSuspense(<IntentUsersPage />)} />
            <Route path="invite-codes" element={withSuspense(<InviteCodeManagementPage />)} />
            <Route
              path="admin-accounts"
              element={withAdminPermission(<AdminAccountsPage />, [
                ADMIN_PERMISSION.ADMIN_ACCOUNT_LIST,
                ADMIN_PERMISSION.ADMIN_ROLE_LIST,
              ])}
            />
            <Route
              path="admin-accounts/:adminAccountId"
              element={withAdminPermission(
                <AdminAccountsPage />,
                ADMIN_PERMISSION.ADMIN_ACCOUNT_LIST
              )}
            />
            <Route
              path="admin-rbac"
              element={withAdminPermission(<AdminRbacPage />, ADMIN_PERMISSION.ADMIN_ROLE_LIST)}
            />
            <Route
              path="admin-sensitive-actions"
              element={withAdminPermission(<AdminSensitiveActionsPage />, [
                ADMIN_PERMISSION.SENSITIVE_ACTION_LIST,
                ADMIN_PERMISSION.ADMIN_LOGIN_LOG_LIST,
                ADMIN_PERMISSION.CLI_AUDIT_LIST,
              ])}
            />
            <Route
              path="admin-login-logs"
              element={withAdminPermission(
                <AdminLoginLogsPage />,
                ADMIN_PERMISSION.ADMIN_LOGIN_LOG_LIST
              )}
            />
            <Route path="governance/admin-logs" element={withSuspense(<OpsAuditPage />)} />
            <Route path="trash" element={withSuspense(<TrashManagementPage />)} />

            {/* v0.1 AI 能力 — 4 组 17 个二级页面 */}
            <Route
              path="ai/scenes"
              element={withAdminPermission(<ScenesPage />, [
                ADMIN_PERMISSION.AI_SCENE_LIST,
                ADMIN_PERMISSION.AI_MULTIMODAL_LIST,
              ])}
            />
            <Route
              path="ai/providers"
              element={withAdminPermission(<ProvidersPage />, [
                ADMIN_PERMISSION.PROVIDER_LIST,
                ADMIN_PERMISSION.MODEL_LIST,
                ADMIN_PERMISSION.AI_EMBEDDING_LIST,
                ADMIN_PERMISSION.AI_PROMPT_LIST,
              ])}
            />
            <Route
              path="ai/models"
              element={withAdminPermission(<ModelsPage />, ADMIN_PERMISSION.MODEL_LIST)}
            />
            <Route
              path="ai/prompts"
              element={withAdminPermission(<PromptsPage />, ADMIN_PERMISSION.AI_PROMPT_LIST)}
            />
            <Route
              path="ai/embedding"
              element={withAdminPermission(<EmbeddingPage />, ADMIN_PERMISSION.AI_EMBEDDING_LIST)}
            />
            <Route
              path="ai/multimodal"
              element={withAdminPermission(<MultimodalPage />, ADMIN_PERMISSION.AI_MULTIMODAL_LIST)}
            />
            <Route path="ai/speech" element={<Navigate to="/ai/multimodal?tab=speech" replace />} />

            <Route
              path="ai-ops/runtime"
              element={withAdminPermission(<AiOpsRuntimePage />, ADMIN_PERMISSION.AI_OPS_VIEW)}
            />
            <Route
              path="ai-ops/usage"
              element={withAdminPermission(<AiOpsUsagePage />, [
                ADMIN_PERMISSION.USAGE_EVENT_LIST,
                ADMIN_PERMISSION.AI_OPS_VIEW,
                ADMIN_PERMISSION.AUDIT_LOG_LIST,
              ])}
            />
            <Route
              path="ai-ops/audit"
              element={withAdminPermission(<AiOpsAuditPage />, ADMIN_PERMISSION.AUDIT_LOG_LIST)}
            />
            <Route
              path="ai-ops/incident"
              element={withAdminPermission(<AiOpsIncidentPage />, ADMIN_PERMISSION.AI_OPS_VIEW)}
            />

            <Route path="agent-config/engine" element={withSuspense(<AgentEnginePage />)} />
            <Route path="agent-config/context" element={withSuspense(<AgentContextPage />)} />
            <Route path="agent-config/guard" element={withSuspense(<AgentGuardPage />)} />
            <Route path="agent-config/features" element={withSuspense(<AgentFeaturesPage />)} />
            <Route path="agent-config/cleanup" element={withSuspense(<AgentCleanupPage />)} />

            <Route
              path="external/search-admin"
              element={withSuspense(<ExternalSearchAdminPage />)}
            />
            <Route
              path="platform-config"
              element={withAdminPermission(
                <PlatformConfigPage />,
                ADMIN_PERMISSION.PLATFORM_CONFIG_LIST
              )}
            />

            {/* 系统监控 / 旧路由兼容 */}
            <Route
              path="monitoring/overview"
              element={<Navigate to="/monitoring/queues" replace />}
            />
            <Route path="monitoring/queues" element={withSuspense(<MonitoringQueuesPage />)} />
            <Route path="monitoring/workers" element={withSuspense(<MonitoringConsumersPage />)} />
            <Route
              path="monitoring/failed-samples"
              element={withSuspense(<MonitoringMessagesPage />)}
            />
            <Route
              path="monitoring/websocket"
              element={withSuspense(<MonitoringWebSocketPage />)}
            />
            <Route path="monitoring/collab" element={withSuspense(<MonitoringCollabPage />)} />
            <Route path="monitoring/im" element={withSuspense(<MonitoringImPage />)} />
            <Route
              path="monitoring/consumers"
              element={<Navigate to="/monitoring/workers" replace />}
            />
            <Route
              path="monitoring/connections"
              element={<Navigate to="/monitoring/websocket" replace />}
            />
            <Route path="monitoring/channels" element={<Navigate to="/monitoring/im" replace />} />
            <Route
              path="monitoring/messages"
              element={<Navigate to="/monitoring/failed-samples" replace />}
            />
            <Route
              path="monitoring/tasks"
              element={<Navigate to="/monitoring/failed-samples" replace />}
            />
            <Route
              path="monitoring/search"
              element={<Navigate to="/monitoring/queues?tab=outbox" replace />}
            />
            <Route
              path="monitoring/realtime"
              element={<Navigate to="/monitoring/websocket" replace />}
            />
            <Route
              path="monitoring/dependencies"
              element={<Navigate to="/monitoring/queues" replace />}
            />
            <Route
              path="monitoring/client-errors"
              element={<Navigate to="/client-errors" replace />}
            />
            <Route path="ops/stability" element={<Navigate to="/monitoring/queues" replace />} />
            <Route path="ops/stability/*" element={<Navigate to="/monitoring/queues" replace />} />
            <Route path="ops/users" element={<Navigate to="/customers/user-diagnose" replace />} />
            <Route
              path="ops/users/*"
              element={<Navigate to="/customers/user-diagnose" replace />}
            />
            <Route
              path="ops/tasks"
              element={<Navigate to="/monitoring/failed-samples" replace />}
            />
            <Route
              path="ops/tasks/*"
              element={<Navigate to="/monitoring/failed-samples" replace />}
            />
            <Route
              path="ops/beat"
              element={<Navigate to="/monitoring/queues?tab=beat" replace />}
            />
            <Route
              path="ops/beat/*"
              element={<Navigate to="/monitoring/queues?tab=beat" replace />}
            />
            <Route path="ops/llm-trace" element={<Navigate to="/monitoring/queues" replace />} />
            <Route path="ops/llm-trace/*" element={<Navigate to="/monitoring/queues" replace />} />
            <Route path="ops/oss-sms" element={<Navigate to="/monitoring/queues" replace />} />
            <Route path="ops/oss-sms/*" element={<Navigate to="/monitoring/queues" replace />} />
            <Route path="ops/dependencies" element={<Navigate to="/monitoring/queues" replace />} />
            <Route
              path="ops/dependencies/*"
              element={<Navigate to="/monitoring/queues" replace />}
            />
            <Route path="ops/incidents" element={withSuspense(<OpsIncidentsPage />)} />
            <Route path="ops/cost-sla" element={withSuspense(<OpsCostSlaPage />)} />
            <Route path="ops/realtime" element={<Navigate to="/monitoring/websocket" replace />} />
            <Route
              path="ops/realtime/*"
              element={<Navigate to="/monitoring/websocket" replace />}
            />
            <Route path="ops/collab" element={<Navigate to="/monitoring/collab" replace />} />
            <Route path="ops/collab/*" element={<Navigate to="/monitoring/collab" replace />} />
            <Route
              path="ops/search"
              element={<Navigate to="/monitoring/queues?tab=outbox" replace />}
            />
            <Route
              path="ops/search/*"
              element={<Navigate to="/monitoring/queues?tab=outbox" replace />}
            />
            <Route
              path="ops/finance-trace"
              element={<Navigate to="/billing/finance-trace" replace />}
            />
            <Route
              path="ops/audit"
              element={<Navigate to="/governance/admin-logs?type=audit" replace />}
            />
            <Route
              path="ops/audit/*"
              element={<Navigate to="/governance/admin-logs?type=audit" replace />}
            />

            {/* 工具 */}
            <Route
              path="tools"
              element={withAdminPermission(<ToolOverviewPage />, ADMIN_PERMISSION.TOOL_LIST)}
            />
            <Route
              path="tools/:toolName"
              element={withAdminPermission(<ToolDetailPage />, ADMIN_PERMISSION.TOOL_LIST)}
            />
            <Route
              path="tool-audit"
              element={withAdminPermission(<ToolAuditPage />, ADMIN_PERMISSION.TOOL_AUDIT_LIST)}
            />
            <Route
              path="skill-review"
              element={withAdminPermission(<SkillReviewPage />, ADMIN_PERMISSION.SKILL_REVIEW_LIST)}
            />

            {/* 系统运维 */}
            <Route path="celery" element={<Navigate to="/monitoring/queues" replace />} />
            <Route
              path="celery/failed-tasks"
              element={<Navigate to="/monitoring/failed-samples" replace />}
            />
            <Route
              path="desktop-updates"
              element={withAdminPermission(
                <DesktopUpdateManagementPage />,
                ADMIN_PERMISSION.DESKTOP_UPDATE_LIST
              )}
            />
            <Route
              path="mobile-version"
              element={withAdminPermission(
                <MobileVersionPage />,
                ADMIN_PERMISSION.DESKTOP_UPDATE_LIST
              )}
            />
            <Route
              path="client-errors"
              element={withAdminPermission(
                <ClientErrorsPage />,
                ADMIN_PERMISSION.CLIENT_ERROR_LIST
              )}
            />
            <Route
              path="diagnostics"
              element={withAdminPermission(<DiagnosticsInboxPage />, ADMIN_PERMISSION.CLIENT_ERROR_LIST)}
            />
            <Route
              path="marketing"
              element={withAdminPermission(<MarketingPage />, ADMIN_PERMISSION.ANALYTICS_VIEW)}
            />
            <Route path="monitor" element={<Navigate to="/monitoring/queues" replace />} />

            {/* 计费 */}
            <Route
              path="billing"
              element={withAdminPermission(
                <BillingDashboardPage />,
                ADMIN_PERMISSION.BILLING_DASHBOARD_VIEW
              )}
            />
            <Route path="billing/finance-trace" element={withSuspense(<OpsFinanceTracePage />)} />
            <Route
              path="billing/wallets"
              element={withAdminPermission(<WalletManagementPage />, [
                ADMIN_PERMISSION.WALLET_LIST,
                ADMIN_PERMISSION.CREDIT_PACKAGE_LIST,
              ])}
            />
            <Route
              path="billing/wallets/:walletId"
              element={withAdminPermission(<WalletDetailPage />, ADMIN_PERMISSION.WALLET_VIEW)}
            />
            <Route
              path="billing/provider-credit"
              element={withAdminPermission(<ProviderCreditManagementPage />, [
                ADMIN_PERMISSION.PROVIDER_CREDIT_VIEW,
                ADMIN_PERMISSION.PROVIDER_CREDIT_OPERATE,
                ADMIN_PERMISSION.PROVIDER_CREDIT_ADMIN,
              ])}
            />
            <Route
              path="billing/events"
              element={withAdminPermission(<BillingEventsPage />, [
                ADMIN_PERMISSION.BILLING_EVENT_LIST,
                ADMIN_PERMISSION.COST_ANALYSIS_VIEW,
                ADMIN_PERMISSION.STORAGE_BILLING_LIST,
              ])}
            />
            <Route
              path="billing/budget"
              element={withAdminPermission(
                <BudgetManagementPage />,
                ADMIN_PERMISSION.BUDGET_POLICY_LIST
              )}
            />
            <Route
              path="billing/products/pricing"
              element={<Navigate to="/billing/products#pricing" replace />}
            />
            <Route
              path="billing/products"
              element={withAdminPermission(<ProductConfigPage />, [
                ADMIN_PERMISSION.PRODUCT_CONFIG_LIST,
                ADMIN_PERMISSION.PLAN_LIST,
                ADMIN_PERMISSION.PRICING_RULE_LIST,
                ADMIN_PERMISSION.CREDIT_PACKAGE_LIST,
                ADMIN_PERMISSION.ADDON_PACKAGE_LIST,
                ADMIN_PERMISSION.BILLING_RUNTIME_CONFIG_VIEW,
              ])}
            />
            <Route
              path="billing/products/membership"
              element={<Navigate to="/billing/products#membership" replace />}
            />
            <Route
              path="billing/audit-log"
              element={withAdminPermission(<AuditLogPage />, ADMIN_PERMISSION.AUDIT_LOG_LIST)}
            />
            <Route
              path="billing/reconciliation"
              element={withAdminPermission(
                <ReconciliationPage />,
                ADMIN_PERMISSION.RECONCILIATION_LIST
              )}
            />
            <Route
              path="billing/anomalies"
              element={withAdminPermission(<AnomalyAlertsPage />, [
                ADMIN_PERMISSION.ANOMALY_ALERT_LIST,
                ADMIN_PERMISSION.BUDGET_POLICY_LIST,
                ADMIN_PERMISSION.STORAGE_BILLING_LIST,
              ])}
            />
            <Route
              path="billing/cost-analysis"
              element={withAdminPermission(
                <CostAnalysisPage />,
                ADMIN_PERMISSION.COST_ANALYSIS_VIEW
              )}
            />
            <Route
              path="billing/storage"
              element={withAdminPermission(
                <StorageBillingPage />,
                ADMIN_PERMISSION.STORAGE_BILLING_LIST
              )}
            />
            <Route
              path="billing/organization-cleanup"
              element={withAdminPermission(
                <OrganizationCleanupPage />,
                ADMIN_PERMISSION.STORAGE_BILLING_LIST
              )}
            />
            <Route
              path="billing/organization-credit-explanation"
              element={withAdminPermission(<OrganizationCreditExplanationPage />, [
                ADMIN_PERMISSION.BILLING_EVENT_LIST,
                ADMIN_PERMISSION.WALLET_LIST,
              ])}
            />
            <Route
              path="billing/invoices"
              element={<RedirectBillingInvoicesToPaymentOrders />}
            />
            <Route
              path="billing/payment-orders"
              element={withAdminPermission(
                <PaymentOrdersPage />,
                ADMIN_PERMISSION.INVOICE_LIST
              )}
            />
            <Route
              path="billing/runtime-config"
              element={<Navigate to="/billing/products#runtime" replace />}
            />
            <Route
              path="billing/products/credit-packages"
              element={<Navigate to="/billing/products#credits" replace />}
            />
            <Route
              path="billing/products/addon-packages"
              element={<Navigate to="/billing/products#addons" replace />}
            />
            <Route
              path="billing/disputes"
              element={withAdminPermission(
                <DisputeManagementPage />,
                ADMIN_PERMISSION.DISPUTE_LIST
              )}
            />

            {/* App 平台 */}
            <Route
              path="app-installs"
              element={withAdminPermission(<AppInstallManagementPage />, [
                ADMIN_PERMISSION.APP_INSTALL_LIST,
                ADMIN_PERMISSION.APP_AUTHORIZATION_LIST,
                ADMIN_PERMISSION.CONNECT_LIST,
                ADMIN_PERMISSION.TOOL_LIST,
                ADMIN_PERMISSION.TOOL_AUDIT_LIST,
                ADMIN_PERMISSION.SKILL_REVIEW_LIST,
              ])}
            />
            <Route
              path="connect-management"
              element={withAdminPermission(
                <ConnectManagementPage />,
                ADMIN_PERMISSION.CONNECT_LIST
              )}
            />
            <Route
              path="connects"
              element={withAdminPermission(
                <ConnectManagementPage />,
                ADMIN_PERMISSION.CONNECT_LIST
              )}
            />
            <Route
              path="connects/:connectId"
              element={withAdminPermission(
                <ConnectManagementPage />,
                ADMIN_PERMISSION.CONNECT_VIEW
              )}
            />
            <Route
              path="app-authorization"
              element={withAdminPermission(
                <AppAuthorizationPage />,
                ADMIN_PERMISSION.APP_AUTHORIZATION_LIST
              )}
            />
            <Route
              path="cli-audit"
              element={withAdminPermission(<CliAuditPage />, ADMIN_PERMISSION.CLI_AUDIT_LIST)}
            />
            <Route
              path="permission-audit"
              element={withAdminPermission(
                <PermissionAuditPage />,
                ADMIN_PERMISSION.CLI_AUDIT_LIST
              )}
            />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
