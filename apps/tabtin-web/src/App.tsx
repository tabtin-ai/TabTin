import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AppHostClientProvider } from '@tabtin/app-host-sdk'
import { Toaster } from '@tabtin/smartsheet-ui'
import { useAuthStore } from '@/stores/auth-store'
import { ErrorBoundary } from '@/components/layout/ErrorBoundary'
import { AppLoadingShell } from '@/components/layout/AppLoadingShell'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { PublicRoute } from '@/components/layout/PublicRoute'
import { SharedPageShell } from '@/components/layout/SharedPageShell'
import { getSharedAppHostClient } from '@/adapters/sharedAppHostClient'
import { WebPresentationProvider } from '@/components/layout/WebPresentationContext'

const AppLayout = lazy(() =>
  import('@/components/layout/AppLayout').then((module) => ({ default: module.AppLayout })),
)
const LoginPage = lazy(() =>
  import('@/pages/LoginPage').then((module) => ({ default: module.LoginPage })),
)
const RegisterPage = lazy(() =>
  import('@/pages/RegisterPage').then((module) => ({ default: module.RegisterPage })),
)
const ForgotPasswordPage = lazy(() =>
  import('@/pages/ForgotPasswordPage').then((module) => ({ default: module.ForgotPasswordPage })),
)
const SpaceHome = lazy(() =>
  import('@/components/space/SpaceHome').then((module) => ({ default: module.SpaceHome })),
)
const HomePage = lazy(() =>
  import('@/pages/HomePage').then((module) => ({ default: module.HomePage })),
)
const NotFoundPage = lazy(() =>
  import('@/pages/NotFoundPage').then((module) => ({ default: module.NotFoundPage })),
)
const PublicFormPage = lazy(() =>
  import('@/pages/PublicFormPage').then((module) => ({ default: module.PublicFormPage })),
)
const SharedDocPage = lazy(() =>
  import('@/pages/SharedDocPage').then((module) => ({ default: module.SharedDocPage })),
)
const SharedTablePage = lazy(() =>
  import('@/pages/SharedTablePage').then((module) => ({ default: module.SharedTablePage })),
)
const SharedHtmlPage = lazy(() =>
  import('@/pages/SharedHtmlPage').then((module) => ({ default: module.SharedHtmlPage })),
)
const LegacySharedHtmlGonePage = lazy(() =>
  import('@/pages/SharedHtmlPage').then((module) => ({
    default: module.LegacySharedHtmlGonePage,
  })),
)
const InviteBridgePage = lazy(() =>
  import('@/pages/InviteBridgePage').then((module) => ({ default: module.InviteBridgePage })),
)
const FeishuConnectPage = lazy(() =>
  import('@/pages/FeishuConnectPage').then((module) => ({ default: module.FeishuConnectPage })),
)
const FeishuConnectedPage = lazy(() =>
  import('@/pages/FeishuConnectedPage').then((module) => ({ default: module.FeishuConnectedPage })),
)
const WebTableRoute = lazy(() =>
  import('@/components/table/WebTableRoute').then((module) => ({ default: module.WebTableRoute })),
)
const WebDocRoute = lazy(() =>
  import('@/components/doc/WebDocRoute').then((module) => ({ default: module.WebDocRoute })),
)
const WebSlideRoute = lazy(() =>
  import('@/components/slide/WebSlideRoute').then((module) => ({ default: module.WebSlideRoute })),
)

export default function App() {
  const isInitializing = useAuthStore((s) => s.isInitializing)

  if (isInitializing) {
    return <AppLoadingShell />
  }

  // 全局兜底 client:share-dialog 等在编辑器路由外被渲染时通过 useAppHostClient 找到此 Provider;
  // WebDocRoute 等内层 Provider 会覆盖, 编辑器专属 client 不受影响。
  const sharedHostClient = getSharedAppHostClient()

  return (
    <AppHostClientProvider value={sharedHostClient}>
    <ErrorBoundary>
      <BrowserRouter>
        <WebPresentationProvider>
          <Suspense fallback={<AppLoadingShell />}>
            <Routes>
            <Route
              path="/login"
              element={
                <PublicRoute>
                  <LoginPage />
                </PublicRoute>
              }
            />
            <Route path="/forms/:shareId" element={<PublicFormPage />} />
            <Route path="/invite" element={<InviteBridgePage />} />
            <Route path="/invite/:token" element={<InviteBridgePage />} />
            <Route path="/integrations/feishu/connect" element={<FeishuConnectPage />} />
            <Route path="/integrations/feishu/connected" element={<FeishuConnectedPage />} />
            <Route
              path="/shared/docs/:documentId/html/:blockId"
              element={
                <SharedPageShell>
                  <SharedHtmlPage />
                </SharedPageShell>
              }
            />
            <Route
              path="/shared/docs/:shareId"
              element={
                <SharedPageShell>
                  <SharedDocPage />
                </SharedPageShell>
              }
            />
            <Route
              path="/shared/tables/:shareId"
              element={
                <SharedPageShell>
                  <SharedTablePage />
                </SharedPageShell>
              }
            />
            <Route
              path="/shared/html/:shareId"
              element={
                <SharedPageShell>
                  <LegacySharedHtmlGonePage />
                </SharedPageShell>
              }
            />
            <Route
              path="/register"
              element={
                <PublicRoute>
                  <RegisterPage />
                </PublicRoute>
              }
            />
            <Route
              path="/forgot-password"
              element={
                <PublicRoute>
                  <ForgotPasswordPage />
                </PublicRoute>
              }
            />
            <Route
              element={
                <ProtectedRoute>
                  <AppLayout />
                </ProtectedRoute>
              }
            >
              <Route index element={<SpaceHome />} />
              <Route path="spaces/:spaceId" element={<SpaceHome />} />
              <Route path="organizations/:organizationId/spaces/:spaceId" element={<SpaceHome />} />
              <Route path="tables/:tableId" element={<WebTableRoute />} />
              <Route path="spaces/:spaceId/tables/:tableId" element={<WebTableRoute />} />
              <Route path="organizations/:organizationId/spaces/:spaceId/tables/:tableId" element={<WebTableRoute />} />
              <Route path="docs/:documentId" element={<WebDocRoute />} />
              <Route path="spaces/:spaceId/docs/:documentId" element={<WebDocRoute />} />
              <Route path="organizations/:organizationId/spaces/:spaceId/docs/:documentId" element={<WebDocRoute />} />
              <Route path="slides/:slideId" element={<WebSlideRoute />} />
              <Route path="spaces/:spaceId/slides/:slideId" element={<WebSlideRoute />} />
              <Route path="organizations/:organizationId/spaces/:spaceId/slides/:slideId" element={<WebSlideRoute />} />
              <Route path="home" element={<HomePage />} />
            </Route>
            {/* 兼容旧 /workspaces/ 路径 → 重定向到 /organizations/ */}
            <Route path="workspaces/*" element={<LegacyWorkspaceRedirect />} />
            <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
          <Toaster />
        </WebPresentationProvider>
      </BrowserRouter>
    </ErrorBoundary>
    </AppHostClientProvider>
  )
}

function LegacyWorkspaceRedirect() {
  const location = useLocation()
  const newPath = location.pathname.replace(/^\/workspaces\//, '/organizations/') + location.search + location.hash
  return <Navigate to={newPath} replace />
}
