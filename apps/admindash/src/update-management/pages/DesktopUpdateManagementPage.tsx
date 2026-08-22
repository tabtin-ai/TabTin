import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Copy,
  Edit3,
  Plus,
  RefreshCw,
  Rocket,
  Send,
  ShieldAlert,
} from 'lucide-react'
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { AdminPage } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { PageSizeSelect } from '@/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { formatDateTime } from '@/lib/utils'
import {
  checkDesktopUpdateReleaseReadiness,
  completeDesktopUpdateReleaseAssetUpload,
  createDesktopUpdateRelease,
  createDesktopUpdateReleaseAssetUploadIntent,
  deprecateDesktopUpdateRelease,
  generateDesktopUpdateReleaseManifest,
  getDesktopUpdateOverview,
  getDesktopUpdateReleaseDetail,
  getDesktopUpdateReleaseManifestPreview,
  getDesktopUpdateReleases,
  publishDesktopUpdateRelease,
  pushDesktopUpdateRelease,
  rolloutDesktopUpdateRelease,
  updateDesktopUpdateRelease,
} from '@/update-management/api/update-management'
import type {
  AdminUpdateAssetActionResponse,
  AdminUpdateManifestPreview,
  AdminUpdateOverview,
  AdminUpdatePagination,
  AdminUpdateReleaseCreatePayload,
  AdminUpdateReleaseDetail,
  AdminUpdateReleaseListItem,
  AdminUpdateReleaseQuery,
  AdminUpdateReleaseReadiness,
  AdminUpdateReleaseUpdatePayload,
  DesktopReleaseArch,
  DesktopReleaseAssetType,
  DesktopReleaseChannel,
  DesktopReleasePlatform,
} from '@/update-management/types'

type ReleaseFormState = {
  version: string
  platform: DesktopReleasePlatform
  arch: DesktopReleaseArch
  channel: DesktopReleaseChannel
  file_url: string
  feed_url: string
  file_size: string
  checksum_sha256: string
  is_mandatory: boolean
  min_compatible_version: string
  priority: string
  rollout_percentage: string
  rollout_target_users_text: string
  release_notes: string
  release_notes_en: string
}

type AssetUploadState = {
  assetType: DesktopReleaseAssetType
  step: string
  fileName: string
}

type ReleaseWorkflowStep = {
  key: string
  label: string
  description: string
  status: 'done' | 'current' | 'todo' | 'blocked'
}

const EMPTY_PAGINATION: AdminUpdatePagination = {
  page: 1,
  page_size: 20,
  total: 0,
  total_pages: 1,
}

const DEFAULT_FORM: ReleaseFormState = {
  version: '',
  platform: 'mac',
  arch: 'x64',
  channel: 'stable',
  file_url: '',
  feed_url: '',
  file_size: '',
  checksum_sha256: '',
  is_mandatory: false,
  min_compatible_version: '',
  priority: 'normal',
  rollout_percentage: '0',
  rollout_target_users_text: '',
  release_notes: '',
  release_notes_en: '',
}

function formatFileSize(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function toTargetUsers(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function toFormState(release?: AdminUpdateReleaseListItem | null): ReleaseFormState {
  if (!release) return { ...DEFAULT_FORM }
  return {
    version: release.version,
    platform: release.platform,
    arch: release.arch,
    channel: release.channel,
    file_url: release.file_url,
    feed_url: release.feed_url || '',
    file_size: String(release.file_size || ''),
    checksum_sha256: release.checksum_sha256,
    is_mandatory: release.is_mandatory,
    min_compatible_version: release.min_compatible_version || '',
    priority: release.priority,
    rollout_percentage: String(release.rollout_percentage ?? 0),
    rollout_target_users_text: (release.rollout_target_users || []).join('\n'),
    release_notes: release.release_notes || '',
    release_notes_en: release.release_notes_en || '',
  }
}

function toCreatePayload(form: ReleaseFormState): AdminUpdateReleaseCreatePayload {
  return {
    version: form.version.trim(),
    platform: form.platform,
    arch: form.arch,
    channel: form.channel,
    file_url: form.file_url.trim(),
    feed_url: normalizeFeedUrl(form.feed_url),
    file_size: Number(form.file_size || 0),
    checksum_sha256: form.checksum_sha256.trim(),
    is_mandatory: form.is_mandatory,
    min_compatible_version: form.min_compatible_version.trim(),
    priority: form.priority,
    rollout_percentage: Number(form.rollout_percentage || 0),
    rollout_target_users: toTargetUsers(form.rollout_target_users_text),
    release_notes: form.release_notes.trim(),
    release_notes_en: form.release_notes_en.trim(),
  }
}

function toUpdatePayload(form: ReleaseFormState): AdminUpdateReleaseUpdatePayload {
  return {
    file_url: form.file_url.trim(),
    feed_url: normalizeFeedUrl(form.feed_url),
    file_size: Number(form.file_size || 0),
    checksum_sha256: form.checksum_sha256.trim(),
    is_mandatory: form.is_mandatory,
    min_compatible_version: form.min_compatible_version.trim(),
    priority: form.priority,
    rollout_percentage: Number(form.rollout_percentage || 0),
    rollout_target_users: toTargetUsers(form.rollout_target_users_text),
    release_notes: form.release_notes.trim(),
    release_notes_en: form.release_notes_en.trim(),
  }
}

function validateForm(form: ReleaseFormState, mode: 'create' | 'edit'): string | null {
  if (mode === 'create' && !form.version.trim()) return '版本号为必填项'
  if (!form.release_notes.trim()) return '更新日志为必填项'

  if (form.file_url.trim()) {
    try {
      new URL(form.file_url.trim())
    } catch {
      return '安装包地址必须是合法 URL'
    }
  }

  if (form.feed_url.trim()) {
    try {
      new URL(normalizeFeedUrl(form.feed_url))
    } catch {
      return '更新源目录必须是合法 URL'
    }
  }

  const fileSize = Number(form.file_size)
  if (form.file_url.trim()) {
    if (!Number.isInteger(fileSize) || fileSize <= 0) {
      return '填写安装包地址时，文件大小必须是大于 0 的整数'
    }

    if (!/^[a-fA-F0-9]{64}$/.test(form.checksum_sha256.trim())) {
      return '填写安装包地址时，SHA256 必须是 64 位十六进制字符串'
    }
  } else if (form.file_size.trim() || form.checksum_sha256.trim()) {
    return '如果暂时不填安装包地址，请同时清空文件大小和 SHA256，后续可用资产上传自动回填'
  }

  const rolloutPercentage = Number(form.rollout_percentage)
  if (!Number.isInteger(rolloutPercentage) || rolloutPercentage < 0 || rolloutPercentage > 100) {
    return '灰度比例必须在 0 到 100 之间'
  }

  return null
}

function statusBadgeVariant(status: string): 'outline' | 'success' | 'warning' | 'destructive' {
  if (status === 'published') return 'success'
  if (status === 'deprecated') return 'destructive'
  return 'warning'
}

function readinessBadgeVariant(status: string): 'outline' | 'success' | 'warning' | 'destructive' {
  if (status === 'ready') return 'success'
  if (status === 'blocked') return 'destructive'
  if (status === 'warning') return 'warning'
  return 'outline'
}

function readinessStatusLabel(status: string): string {
  if (status === 'ready') return '已就绪'
  if (status === 'warning') return '有警告'
  if (status === 'blocked') return '不可发布'
  return '未检查'
}

function releaseStatusLabel(status: string): string {
  if (status === 'draft') return '草稿'
  if (status === 'published') return '已发布'
  if (status === 'deprecated') return '已废弃'
  return status || '未知'
}

function channelLabel(channel: string): string {
  if (channel === 'stable') return '正式版'
  if (channel === 'beta') return '测试版'
  if (channel === 'alpha') return '预发版'
  return channel || '未知渠道'
}

function platformLabel(platform: string): string {
  if (platform === 'mac') return 'macOS'
  if (platform === 'win') return 'Windows'
  if (platform === 'linux') return 'Linux'
  return platform || '未知平台'
}

function platformArchLabel(platform: string, arch: string): string {
  return `${platformLabel(platform)} / ${arch || '未知架构'}`
}

function priorityLabel(priority: string): string {
  if (priority === 'low') return '低'
  if (priority === 'normal') return '普通'
  if (priority === 'high') return '高'
  if (priority === 'critical') return '紧急'
  return priority || '未知'
}

function pushStatusLabel(status: string): string {
  if (status === 'sent') return '已发送'
  if (status === 'failed') return '发送失败'
  if (status === 'pending') return '待发送'
  if (status === 'skipped') return '已跳过'
  return status || '未知状态'
}

function updateLogStatusLabel(status: string): string {
  if (status === 'checking') return '检查中'
  if (status === 'available') return '有更新'
  if (status === 'downloading') return '下载中'
  if (status === 'downloaded') return '已下载'
  if (status === 'installing') return '安装中'
  if (status === 'installed') return '已安装'
  if (status === 'failed') return '失败'
  return status || '未知状态'
}

function triggerSourceLabel(source: string): string {
  if (source === 'manual') return '手动检查'
  if (source === 'http_poll') return '后台轮询'
  if (source === 'ws_push') return '推送触发'
  if (source === 'startup') return '启动检查'
  return source || '未知来源'
}

function severityLabel(severity: string): string {
  if (severity === 'error') return '错误'
  if (severity === 'warning') return '警告'
  if (severity === 'info') return '提示'
  return severity || '提示'
}

function readinessIssueTone(severity: string): string {
  if (severity === 'error') {
    return 'border-destructive/30 bg-destructive/10 text-destructive'
  }
  if (severity === 'warning') {
    return 'border-warning/30 bg-warning/10 text-warning'
  }
  return 'border-border bg-muted text-foreground'
}

function summarizeHash(value?: string | null): string {
  if (!value) return '—'
  if (value.length <= 20) return value
  return `${value.slice(0, 16)}...${value.slice(-8)}`
}

function assetTypeLabel(assetType: DesktopReleaseAssetType): string {
  if (assetType === 'package') return '自动更新安装包'
  if (assetType === 'website_installer') return '官网安装包'
  if (assetType === 'manifest') return '更新清单'
  return '差分索引'
}

function getWebsiteInstallerUploadRule(platform: DesktopReleasePlatform): {
  accept: string
  allowedExtensions: string[]
  description: string
} {
  if (platform === 'mac') {
    return {
      accept: '.dmg,application/x-apple-diskimage,application/octet-stream',
      allowedExtensions: ['.dmg'],
      description: 'macOS 官网手动下载请上传 .dmg；自动更新仍使用 .zip。',
    }
  }
  if (platform === 'win') {
    return {
      accept: '.exe,application/vnd.microsoft.portable-executable,application/x-msdownload',
      allowedExtensions: ['.exe'],
      description: 'Windows 官网下载可复用 NSIS .exe；未单独上传时短链回退自动更新包。',
    }
  }
  return {
    accept: '.AppImage,.deb,.rpm,application/octet-stream',
    allowedExtensions: ['.appimage', '.deb', '.rpm'],
    description: 'Linux 官网安装包可上传 AppImage / deb / rpm。',
  }
}

function validateWebsiteInstallerFileForRelease(
  file: File,
  release: AdminUpdateReleaseListItem
): string | null {
  const extension = `.${file.name.split('.').pop() || ''}`.toLowerCase()
  const rule = getWebsiteInstallerUploadRule(release.platform)
  if (!rule.allowedExtensions.includes(extension)) {
    return `${platformArchLabel(release.platform, release.arch)} 的官网安装包类型不匹配。${rule.description}`
  }
  return null
}

function normalizeFeedUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

function deriveFeedUrlFromFileUrl(fileUrl: string): string {
  try {
    const url = new URL(fileUrl.trim())
    url.search = ''
    url.hash = ''
    url.pathname = url.pathname.replace(/[^/]*$/, '')
    return normalizeFeedUrl(url.toString())
  } catch {
    return ''
  }
}

function getManifestFile(
  channel: DesktopReleaseChannel,
  platform: DesktopReleasePlatform,
  arch: DesktopReleaseArch
): string {
  const channelName = channel === 'stable' ? 'latest' : channel
  if (platform === 'mac') return `${channelName}-mac.yml`
  if (platform === 'linux') {
    return arch === 'x64' ? `${channelName}-linux.yml` : `${channelName}-linux-${arch}.yml`
  }
  return `${channelName}.yml`
}

function getPackageUploadRule(platform: DesktopReleasePlatform): {
  accept: string
  allowedExtensions: string[]
  description: string
} {
  if (platform === 'mac') {
    return {
      accept: '.zip,application/zip,application/x-zip-compressed',
      allowedExtensions: ['.zip'],
      description:
        'macOS 自动更新请上传 electron-builder 生成的 .zip；.dmg 仅适合官网手动下载，不用于生成 latest-mac.yml。',
    }
  }
  if (platform === 'win') {
    return {
      accept: '.exe,application/vnd.microsoft.portable-executable,application/x-msdownload',
      allowedExtensions: ['.exe'],
      description:
        'Windows 自动更新请上传 NSIS .exe；msi/nupkg 不是当前 generic 更新通道的安装包。',
    }
  }
  return {
    accept: '.AppImage,application/octet-stream',
    allowedExtensions: ['.appimage'],
    description: 'Linux 自动更新请上传 AppImage 安装包。',
  }
}

function validatePackageFileForRelease(
  file: File,
  release: AdminUpdateReleaseListItem
): string | null {
  const extension = `.${file.name.split('.').pop() || ''}`.toLowerCase()
  const rule = getPackageUploadRule(release.platform)
  if (!rule.allowedExtensions.includes(extension)) {
    return `${platformArchLabel(release.platform, release.arch)} 的更新安装包类型不匹配。${rule.description}`
  }
  return null
}

function buildManifestUrl(feedUrl: string, manifestFile: string): string {
  if (!feedUrl) return ''
  try {
    return new URL(manifestFile, normalizeFeedUrl(feedUrl)).toString()
  } catch {
    return ''
  }
}

function workflowBadgeVariant(
  status: ReleaseWorkflowStep['status']
): 'outline' | 'success' | 'warning' | 'destructive' {
  if (status === 'done') return 'success'
  if (status === 'blocked') return 'destructive'
  if (status === 'current') return 'warning'
  return 'outline'
}

function workflowStatusLabel(status: ReleaseWorkflowStep['status']): string {
  if (status === 'done') return '完成'
  if (status === 'blocked') return '阻塞'
  if (status === 'current') return '下一步'
  return '待处理'
}

function buildReleaseWorkflowSteps(
  release: AdminUpdateReleaseListItem,
  readiness: AdminUpdateReleaseReadiness | null,
  manifestPreview: AdminUpdateManifestPreview | null
): {
  steps: ReleaseWorkflowStep[]
  nextAction: string
} {
  const packageReady = Boolean(
    release.file_url && release.file_size > 0 && release.checksum_sha256 && release.checksum_sha512
  )
  const manifestReady = Boolean(
    readiness &&
      readiness.manifest_http_status === 200 &&
      readiness.manifest_version === release.version &&
      readiness.asset.resolved_url
  )
  const readinessPassed = Boolean(readiness && readiness.blocking_issue_count === 0)
  const published = release.status !== 'draft'
  const pushed = release.sent_push_count > 0

  const steps: ReleaseWorkflowStep[] = [
    {
      key: 'draft',
      label: '创建草稿',
      description: '版本号、平台、渠道与更新日志已经建立。',
      status: 'done',
    },
    {
      key: 'package',
      label: '托管安装包',
      description: '需要可下载安装包，以及 SHA256 / SHA512 / 文件大小。',
      status: packageReady ? 'done' : 'current',
    },
    {
      key: 'manifest',
      label: '准备更新清单',
      description: '生成或上传最新的 Electron 更新清单。',
      status: manifestReady ? 'done' : packageReady ? 'current' : 'todo',
    },
    {
      key: 'readiness',
      label: '通过发布检查',
      description: '确认 manifest、安装包与灰度配置都已可用。',
      status: readiness
        ? readiness.blocking_issue_count > 0
          ? 'blocked'
          : 'done'
        : manifestReady
          ? 'current'
          : 'todo',
    },
    {
      key: 'publish',
      label: '发布版本',
      description: '版本进入可推送状态。',
      status: published ? 'done' : readinessPassed ? 'current' : 'todo',
    },
    {
      key: 'push',
      label: '推送/灰度',
      description: '向设备提醒更新或静默下载，并观察安装结果。',
      status: pushed ? 'done' : published ? 'current' : 'todo',
    },
  ]

  if (!packageReady) {
    return { steps, nextAction: '下一步建议：上传安装包并自动生成更新清单。' }
  }
  if (!manifestReady) {
    if (manifestPreview && !manifestPreview.can_generate) {
      return {
        steps,
        nextAction: '下一步建议：先补齐更新清单生成条件，再重新生成或上传自定义更新清单。',
      }
    }
    return { steps, nextAction: '下一步建议：生成更新清单，或上传自定义更新清单覆盖。' }
  }
  if (!readiness) {
    return { steps, nextAction: '下一步建议：执行一次发布就绪检查，确认远端链路可用。' }
  }
  if (readiness.blocking_issue_count > 0) {
    return { steps, nextAction: '下一步建议：修复阻塞问题后重新检查，再执行发布。' }
  }
  if (!published) {
    return { steps, nextAction: '下一步建议：发布当前版本。' }
  }
  if (!pushed) {
    return { steps, nextAction: '下一步建议：推送提醒或开启静默下载。' }
  }
  return { steps, nextAction: '当前版本已进入发版闭环，可继续观察灰度和安装结果。' }
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

async function computeFileDigests(file: File): Promise<{
  sha256: string
  sha512: string
}> {
  const buffer = await file.arrayBuffer()
  const [sha256Buffer, sha512Buffer] = await Promise.all([
    crypto.subtle.digest('SHA-256', buffer),
    crypto.subtle.digest('SHA-512', buffer),
  ])
  return {
    sha256: bufferToHex(sha256Buffer),
    sha512: bufferToBase64(sha512Buffer),
  }
}

async function uploadFileToPresignedUrl(
  url: string,
  file: File,
  contentType: string
): Promise<void> {
  const headers = contentType ? { 'Content-Type': contentType } : undefined
  const response = await fetch(url, {
    method: 'PUT',
    headers,
    body: file,
  })
  if (!response.ok) {
    throw new Error(`上传到对象存储失败（HTTP ${response.status}）`)
  }
}

const CHANNEL_OPTIONS = [
  { value: 'stable', label: '正式版' },
  { value: 'beta', label: '测试版' },
  { value: 'alpha', label: '预发版' },
] as const

const PLATFORM_OPTIONS = [
  { value: 'mac', label: 'macOS' },
  { value: 'win', label: 'Windows' },
  { value: 'linux', label: 'Linux' },
] as const

export function DesktopUpdateManagementPage() {
  const { show, element } = useSimpleToast()

  const [overview, setOverview] = useState<AdminUpdateOverview | null>(null)
  const [releases, setReleases] = useState<AdminUpdateReleaseListItem[]>([])
  const [pagination, setPagination] = useState<AdminUpdatePagination>(EMPTY_PAGINATION)
  const [selectedReleaseId, setSelectedReleaseId] = useState<number | null>(null)
  const [detail, setDetail] = useState<AdminUpdateReleaseDetail | null>(null)
  const [readiness, setReadiness] = useState<AdminUpdateReleaseReadiness | null>(null)
  const [readinessReleaseId, setReadinessReleaseId] = useState<number | null>(null)
  const [manifestPreview, setManifestPreview] = useState<AdminUpdateManifestPreview | null>(null)
  const [manifestPreviewReleaseId, setManifestPreviewReleaseId] = useState<number | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [readinessLoading, setReadinessLoading] = useState(false)
  const [manifestPreviewLoading, setManifestPreviewLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [assetUploadState, setAssetUploadState] = useState<AssetUploadState | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogMode, setDialogMode] = useState<'create' | 'edit'>('create')
  const [form, setForm] = useState<ReleaseFormState>({ ...DEFAULT_FORM })
  const [filters, setFilters] = useState<AdminUpdateReleaseQuery>({
    page: 1,
    page_size: 20,
  })
  const packageFileInputRef = useRef<HTMLInputElement | null>(null)
  const websiteInstallerFileInputRef = useRef<HTMLInputElement | null>(null)
  const manifestFileInputRef = useRef<HTMLInputElement | null>(null)
  const blockmapFileInputRef = useRef<HTMLInputElement | null>(null)

  const selectedRelease = useMemo(
    () => releases.find((item) => item.id === selectedReleaseId) ?? detail?.release ?? null,
    [detail?.release, releases, selectedReleaseId]
  )
  const packageUploadRule = useMemo(
    () => getPackageUploadRule(detail?.release.platform ?? selectedRelease?.platform ?? 'mac'),
    [detail?.release.platform, selectedRelease?.platform]
  )
  const websiteInstallerUploadRule = useMemo(
    () =>
      getWebsiteInstallerUploadRule(detail?.release.platform ?? selectedRelease?.platform ?? 'mac'),
    [detail?.release.platform, selectedRelease?.platform]
  )
  const currentReadiness = useMemo(
    () => (readinessReleaseId === selectedReleaseId ? readiness : null),
    [readiness, readinessReleaseId, selectedReleaseId]
  )
  const currentManifestPreview = useMemo(
    () => (manifestPreviewReleaseId === selectedReleaseId ? manifestPreview : null),
    [manifestPreview, manifestPreviewReleaseId, selectedReleaseId]
  )
  const manifestFilePreview = useMemo(
    () => getManifestFile(form.channel, form.platform, form.arch),
    [form.arch, form.channel, form.platform]
  )
  const effectiveFeedUrlPreview = useMemo(
    () => normalizeFeedUrl(form.feed_url) || deriveFeedUrlFromFileUrl(form.file_url),
    [form.feed_url, form.file_url]
  )
  const manifestUrlPreview = useMemo(
    () => buildManifestUrl(effectiveFeedUrlPreview, manifestFilePreview),
    [effectiveFeedUrlPreview, manifestFilePreview]
  )
  const releaseWorkflow = useMemo(
    () =>
      detail?.release
        ? buildReleaseWorkflowSteps(detail.release, currentReadiness, currentManifestPreview)
        : null,
    [currentManifestPreview, currentReadiness, detail?.release]
  )

  const latestMatrixEntries = useMemo(() => {
    if (!overview) return []
    return CHANNEL_OPTIONS.map((option) => ({
      channel: option.value,
      label: option.label,
      items: Object.values(overview.latest_matrix[option.value] || {}).sort((left, right) => {
        const platformOrder: Record<DesktopReleasePlatform, number> = {
          mac: 0,
          win: 1,
          linux: 2,
        }
        const archOrder: Record<DesktopReleaseArch, number> = {
          x64: 0,
          arm64: 1,
        }
        return (
          platformOrder[left.platform] - platformOrder[right.platform] ||
          archOrder[left.arch] - archOrder[right.arch]
        )
      }),
    }))
  }, [overview])

  const loadOverview = useCallback(async () => {
    const data = await getDesktopUpdateOverview()
    setOverview(data)
  }, [])

  const loadReleases = useCallback(async (nextFilters: AdminUpdateReleaseQuery) => {
    setListLoading(true)
    try {
      const data = await getDesktopUpdateReleases(nextFilters)
      setPagination(data.pagination)
      setReleases(data.items)
      setSelectedReleaseId((prev) => {
        if (prev && data.items.some((item) => item.id === prev)) return prev
        return data.items[0]?.id ?? null
      })
    } finally {
      setListLoading(false)
    }
  }, [])

  const loadDetail = useCallback(async (releaseId: number | null) => {
    if (!releaseId) {
      setDetail(null)
      return
    }
    setDetailLoading(true)
    try {
      const data = await getDesktopUpdateReleaseDetail(releaseId)
      setDetail(data)
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const loadReadiness = useCallback(
    async (
      releaseId: number | null,
      options: {
        silent?: boolean
      } = {}
    ): Promise<AdminUpdateReleaseReadiness | null> => {
      if (!releaseId) {
        setReadiness(null)
        setReadinessReleaseId(null)
        return null
      }

      setReadinessLoading(true)
      try {
        const data = await checkDesktopUpdateReleaseReadiness(releaseId)
        setReadiness(data)
        setReadinessReleaseId(releaseId)
        return data
      } catch (err) {
        if (!options.silent) {
          show(err instanceof Error ? err.message : '检查发布就绪状态失败', 'error')
        }
        return null
      } finally {
        setReadinessLoading(false)
      }
    },
    [show]
  )

  const loadManifestPreview = useCallback(
    async (
      releaseId: number | null,
      options: {
        silent?: boolean
      } = {}
    ): Promise<AdminUpdateManifestPreview | null> => {
      if (!releaseId) {
        setManifestPreview(null)
        setManifestPreviewReleaseId(null)
        return null
      }

      setManifestPreviewLoading(true)
      try {
        const data = await getDesktopUpdateReleaseManifestPreview(releaseId)
        setManifestPreview(data)
        setManifestPreviewReleaseId(releaseId)
        return data
      } catch (err) {
        if (!options.silent) {
          show(err instanceof Error ? err.message : '加载更新清单预览失败', 'error')
        }
        return null
      } finally {
        setManifestPreviewLoading(false)
      }
    },
    [show]
  )

  const refreshAll = useCallback(async () => {
    await Promise.all([loadOverview(), loadReleases(filters)])
    if (selectedReleaseId) {
      await Promise.all([
        loadDetail(selectedReleaseId),
        loadReadiness(selectedReleaseId, { silent: true }),
        loadManifestPreview(selectedReleaseId, { silent: true }),
      ])
    }
  }, [
    filters,
    loadDetail,
    loadManifestPreview,
    loadOverview,
    loadReadiness,
    loadReleases,
    selectedReleaseId,
  ])

  const refreshAllWithToast = useCallback(async () => {
    try {
      await refreshAll()
    } catch (err) {
      show(err instanceof Error ? err.message : '刷新桌面更新信息失败', 'error')
    }
  }, [refreshAll, show])

  useEffect(() => {
    void loadOverview().catch((err) => {
      show(err instanceof Error ? err.message : '加载桌面更新概览失败', 'error')
    })
  }, [loadOverview, show])

  useEffect(() => {
    void loadReleases(filters).catch((err) => {
      show(err instanceof Error ? err.message : '加载版本列表失败', 'error')
    })
  }, [filters, loadReleases, show])

  useEffect(() => {
    if (selectedReleaseId) {
      void loadDetail(selectedReleaseId).catch((err) => {
        show(err instanceof Error ? err.message : '加载版本详情失败', 'error')
      })
    }
  }, [loadDetail, selectedReleaseId, show])

  useEffect(() => {
    if (!selectedReleaseId) {
      setReadiness(null)
      setReadinessReleaseId(null)
      return
    }

    setReadiness(null)
    setReadinessReleaseId(null)
    void loadReadiness(selectedReleaseId, { silent: true })
  }, [loadReadiness, selectedReleaseId])

  useEffect(() => {
    if (!selectedReleaseId) {
      setManifestPreview(null)
      setManifestPreviewReleaseId(null)
      return
    }

    setManifestPreview(null)
    setManifestPreviewReleaseId(null)
    void loadManifestPreview(selectedReleaseId, { silent: true })
  }, [loadManifestPreview, selectedReleaseId])

  const handleFilterChange = <K extends keyof AdminUpdateReleaseQuery>(
    key: K,
    value: AdminUpdateReleaseQuery[K]
  ) => {
    const next = {
      ...filters,
      [key]: value,
      page: 1,
    }
    setFilters(next)
  }

  const openCreateDialog = () => {
    setDialogMode('create')
    setForm({ ...DEFAULT_FORM })
    setDialogOpen(true)
  }

  const openEditDialog = () => {
    if (!selectedRelease) return
    setDialogMode('edit')
    setForm(toFormState(selectedRelease))
    setDialogOpen(true)
  }

  const ensureReleaseReady = useCallback(
    async (releaseId: number, actionLabel: string): Promise<boolean> => {
      const result = await loadReadiness(releaseId)
      if (!result) return false
      if (result.blocking_issue_count <= 0) return true

      const firstBlockingIssue = result.issues.find((issue) => issue.severity === 'error')
      show(
        `${actionLabel}前检查未通过${firstBlockingIssue ? `：${firstBlockingIssue.message}` : ''}`,
        'error'
      )
      return false
    },
    [loadReadiness, show]
  )

  const handleSave = async () => {
    const validationMessage = validateForm(form, dialogMode)
    if (validationMessage) {
      show(validationMessage, 'error')
      return
    }

    if (dialogMode === 'edit' && !selectedReleaseId) {
      show('未选中需要编辑的版本', 'error')
      return
    }

    setIsSaving(true)
    try {
      const createPayload = toCreatePayload(form)
      const response =
        dialogMode === 'create'
          ? await createDesktopUpdateRelease(createPayload)
          : await updateDesktopUpdateRelease(selectedReleaseId as number, toUpdatePayload(form))
      show(response.message)
      setDialogOpen(false)
      await refreshAll()
      setSelectedReleaseId(response.release.id)
      await Promise.all([
        loadDetail(response.release.id),
        loadReadiness(response.release.id, { silent: true }),
        loadManifestPreview(response.release.id, { silent: true }),
      ])
    } catch (err) {
      show(err instanceof Error ? err.message : '保存版本失败', 'error')
    } finally {
      setIsSaving(false)
    }
  }

  const handlePublish = async () => {
    if (!selectedRelease) return
    try {
      const canPublish = await ensureReleaseReady(selectedRelease.id, '发布')
      if (!canPublish) return

      const response = await publishDesktopUpdateRelease(selectedRelease.id)
      show(response.message)
      await refreshAll()
      setSelectedReleaseId(response.release.id)
      await Promise.all([
        loadDetail(response.release.id),
        loadReadiness(response.release.id, { silent: true }),
        loadManifestPreview(response.release.id, { silent: true }),
      ])
    } catch (err) {
      show(err instanceof Error ? err.message : '发布失败', 'error')
    }
  }

  const handlePush = async (silent = false) => {
    if (!selectedRelease) return
    try {
      const canPush = await ensureReleaseReady(selectedRelease.id, silent ? '静默下载推送' : '推送')
      if (!canPush) return

      const response = await pushDesktopUpdateRelease(selectedRelease.id, {
        silent,
        rollout_percentage: selectedRelease.rollout_percentage,
      })
      show(response.message)
      await refreshAll()
      setSelectedReleaseId(response.release.id)
      await Promise.all([
        loadDetail(response.release.id),
        loadReadiness(response.release.id, { silent: true }),
        loadManifestPreview(response.release.id, { silent: true }),
      ])
    } catch (err) {
      show(err instanceof Error ? err.message : '推送失败', 'error')
    }
  }

  const handleRolloutToFull = async () => {
    if (!selectedRelease) return
    try {
      const canRollout = await ensureReleaseReady(selectedRelease.id, '灰度推进')
      if (!canRollout) return

      const response = await rolloutDesktopUpdateRelease(selectedRelease.id, 100)
      show(response.message)
      await refreshAll()
      setSelectedReleaseId(response.release.id)
      await Promise.all([
        loadDetail(response.release.id),
        loadReadiness(response.release.id, { silent: true }),
        loadManifestPreview(response.release.id, { silent: true }),
      ])
    } catch (err) {
      show(err instanceof Error ? err.message : '推进灰度失败', 'error')
    }
  }

  const handleStopRollout = async () => {
    if (!selectedRelease) return
    try {
      const response = await rolloutDesktopUpdateRelease(selectedRelease.id, 0)
      show('已将灰度设置为 0%，后续客户端不会再命中该版本')
      await refreshAll()
      setSelectedReleaseId(response.release.id)
      await loadDetail(response.release.id)
    } catch (err) {
      show(err instanceof Error ? err.message : '停止扩散失败', 'error')
    }
  }

  const handleDeprecate = async () => {
    if (!selectedRelease) return
    try {
      const response = await deprecateDesktopUpdateRelease(selectedRelease.id)
      show(response.message)
      await refreshAll()
      setSelectedReleaseId(response.release.id)
      await loadDetail(response.release.id)
    } catch (err) {
      show(err instanceof Error ? err.message : '废弃版本失败', 'error')
    }
  }

  const syncAfterAssetAction = useCallback(
    async (response: AdminUpdateAssetActionResponse) => {
      const toastTone = response.asset.manifest_generation_error ? 'error' : 'success'
      show(response.message, toastTone)
      await refreshAll()
      setSelectedReleaseId(response.release.id)
      await Promise.all([
        loadDetail(response.release.id),
        loadReadiness(response.release.id, { silent: true }),
        loadManifestPreview(response.release.id, { silent: true }),
      ])
    },
    [loadDetail, loadManifestPreview, loadReadiness, refreshAll, show]
  )

  const runAssetUpload = useCallback(
    async (assetType: DesktopReleaseAssetType, file: File, autoGenerateManifest = false) => {
      if (!selectedReleaseId) {
        show('请先选中一个版本', 'error')
        return
      }
      const releaseForUpload = detail?.release ?? selectedRelease
      if (assetType === 'package' || assetType === 'website_installer') {
        if (!releaseForUpload) {
          show('请先加载版本详情后再上传安装包', 'error')
          return
        }
        const packageError =
          assetType === 'package'
            ? validatePackageFileForRelease(file, releaseForUpload)
            : validateWebsiteInstallerFileForRelease(file, releaseForUpload)
        if (packageError) {
          show(packageError, 'error')
          return
        }
      }

      setAssetUploadState({
        assetType,
        step: assetType === 'package' ? '计算校验中...' : '准备上传中...',
        fileName: file.name,
      })

      try {
        const digests =
          assetType === 'package' ? await computeFileDigests(file) : { sha256: '', sha512: '' }

        setAssetUploadState({
          assetType,
          step: '生成上传凭证...',
          fileName: file.name,
        })

        const intent = await createDesktopUpdateReleaseAssetUploadIntent(selectedReleaseId, {
          asset_type: assetType,
          file_name: file.name,
          file_size: file.size,
          content_type:
            assetType === 'manifest'
              ? file.type || 'text/yaml'
              : file.type || 'application/octet-stream',
        })

        setAssetUploadState({
          assetType,
          step: '上传到对象存储...',
          fileName: intent.file_name,
        })

        await uploadFileToPresignedUrl(intent.presigned_url, file, intent.content_type)

        setAssetUploadState({
          assetType,
          step: autoGenerateManifest ? '回填版本并生成更新清单...' : '回填版本配置...',
          fileName: intent.file_name,
        })

        const response = await completeDesktopUpdateReleaseAssetUpload(selectedReleaseId, {
          asset_type: assetType,
          object_key: intent.object_key,
          file_name: intent.file_name,
          file_size: file.size,
          content_type: intent.content_type,
          checksum_sha256: digests.sha256,
          checksum_sha512: digests.sha512,
          auto_generate_manifest: autoGenerateManifest,
        })
        await syncAfterAssetAction(response)
      } catch (err) {
        show(err instanceof Error ? err.message : '上传更新资产失败', 'error')
      } finally {
        setAssetUploadState(null)
      }
    },
    [detail?.release, selectedRelease, selectedReleaseId, show, syncAfterAssetAction]
  )

  const handlePackageFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return
      await runAssetUpload('package', file, true)
    },
    [runAssetUpload]
  )

  const handleWebsiteInstallerFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return
      await runAssetUpload('website_installer', file, false)
    },
    [runAssetUpload]
  )

  const handleManifestFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return
      await runAssetUpload('manifest', file, false)
    },
    [runAssetUpload]
  )

  const handleBlockmapFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return
      await runAssetUpload('blockmap', file, false)
    },
    [runAssetUpload]
  )

  const handleGenerateManifest = async () => {
    if (!selectedReleaseId) return

    setAssetUploadState({
      assetType: 'manifest',
      step: '正在生成更新清单...',
      fileName: detail?.release.manifest_file || 'manifest',
    })
    try {
      const response = await generateDesktopUpdateReleaseManifest(selectedReleaseId)
      await syncAfterAssetAction(response)
    } catch (err) {
      show(err instanceof Error ? err.message : '生成更新清单失败', 'error')
    } finally {
      setAssetUploadState(null)
    }
  }

  const handleCopyManifestPreview = async () => {
    if (!currentManifestPreview?.content) return
    try {
      await navigator.clipboard.writeText(currentManifestPreview.content)
      show('更新清单 YAML 已复制')
    } catch (err) {
      show(err instanceof Error ? err.message : '复制更新清单失败', 'error')
    }
  }

  const handlePageChange = (page: number) => {
    setFilters((prev) => ({
      ...prev,
      page,
    }))
  }

  const handlePageSizeChange = (pageSize: number) => {
    setFilters((prev) => ({
      ...prev,
      page: 1,
      page_size: pageSize,
    }))
  }

  return (
    <AdminPage>
      {element}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-heading font-bold tracking-tight">桌面更新管理</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void refreshAllWithToast()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
          <Button onClick={openCreateDialog}>
            <Plus className="mr-2 h-4 w-4" />
            新建版本
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>版本总数</CardDescription>
            <CardTitle>{overview?.total_releases ?? '—'}</CardTitle>
          </CardHeader>
          <CardContent className="text-body text-muted-foreground">
            草稿 {overview?.draft_releases ?? 0} · 已发布 {overview?.published_releases ?? 0}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>24h 更新尝试</CardDescription>
            <CardTitle>{overview?.recent_24h_attempts ?? '—'}</CardTitle>
          </CardHeader>
          <CardContent className="text-body text-muted-foreground">
            失败 {overview?.recent_24h_failures ?? 0}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>24h 安装完成</CardDescription>
            <CardTitle>{overview?.recent_24h_installs ?? '—'}</CardTitle>
          </CardHeader>
          <CardContent className="text-body text-muted-foreground">可快速观察灰度效果</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>已废弃版本</CardDescription>
            <CardTitle>{overview?.deprecated_releases ?? '—'}</CardTitle>
          </CardHeader>
          <CardContent className="text-body text-muted-foreground">
            保持下载链路和策略清晰
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>渠道最新版本矩阵</CardTitle>
          <CardDescription>
            用于快速确认正式版、测试版、预发版在各平台上的当前主版本。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-3">
          {latestMatrixEntries.map((channelGroup) => (
            <div key={channelGroup.channel} className="rounded-lg border p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="text-body font-semibold">{channelGroup.label}</div>
                <Badge variant="outline">{channelGroup.items.length} 项</Badge>
              </div>
              <div className="space-y-2 text-body">
                {channelGroup.items.length === 0 ? (
                  <div className="text-muted-foreground">暂无已发布版本</div>
                ) : (
                  channelGroup.items.map((item) => (
                    <button
                      key={`${channelGroup.channel}-${item.platform}-${item.arch}`}
                      type="button"
                      className="w-full rounded-md bg-muted/40 px-3 py-2 text-left transition-colors hover:bg-muted"
                      onClick={() => setSelectedReleaseId(item.release_id)}
                    >
                      <div className="flex items-center justify-between">
                        <span>{platformArchLabel(item.platform, item.arch)}</span>
                        <Badge variant={item.mandatory ? 'destructive' : 'outline'}>
                          v{item.version}
                        </Badge>
                      </div>
                      <div className="mt-1 text-body text-muted-foreground">
                        灰度 {item.rollout_percentage}% · {formatDateTime(item.published_at)}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>版本列表</CardTitle>
            <CardDescription>
              按渠道、平台和状态筛选，点击任意版本查看详细发布与更新数据。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-5">
              <Input
                placeholder="搜索版本号 / 更新日志 / 下载地址"
                value={filters.keyword ?? ''}
                onChange={(event) => handleFilterChange('keyword', event.target.value)}
              />
              <Select
                value={filters.channel || '__all'}
                onValueChange={(value) =>
                  handleFilterChange('channel', value === '__all' ? '' : value)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="渠道" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">全部渠道</SelectItem>
                  {CHANNEL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={filters.platform || '__all'}
                onValueChange={(value) =>
                  handleFilterChange('platform', value === '__all' ? '' : value)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="平台" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">全部平台</SelectItem>
                  {PLATFORM_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={filters.arch || '__all'}
                onValueChange={(value) =>
                  handleFilterChange('arch', value === '__all' ? '' : value)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="架构" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">全部架构</SelectItem>
                  <SelectItem value="x64">x64</SelectItem>
                  <SelectItem value="arm64">arm64</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={filters.status || '__all'}
                onValueChange={(value) =>
                  handleFilterChange('status', value === '__all' ? '' : value)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">全部状态</SelectItem>
                  <SelectItem value="draft">草稿</SelectItem>
                  <SelectItem value="published">已发布</SelectItem>
                  <SelectItem value="deprecated">已废弃</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-body text-muted-foreground">
              <div>
                第 {pagination.page} / {pagination.total_pages} 页，共 {pagination.total} 个版本
              </div>
              <div className="flex items-center gap-2">
                <PageSizeSelect value={filters.page_size ?? 20} onChange={handlePageSizeChange} />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={listLoading || pagination.page <= 1}
                  onClick={() => handlePageChange(pagination.page - 1)}
                >
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={listLoading || pagination.page >= pagination.total_pages}
                  onClick={() => handlePageChange(pagination.page + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>

            <div className="overflow-x-auto rounded-lg border">
              <table className="min-w-full text-body">
                <thead className="bg-muted/50 text-left text-body uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">版本</th>
                    <th className="px-4 py-3">渠道</th>
                    <th className="px-4 py-3">状态</th>
                    <th className="px-4 py-3">灰度</th>
                    <th className="px-4 py-3">推送</th>
                    <th className="px-4 py-3">发布时间</th>
                    <th className="px-4 py-3">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {listLoading ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                        加载中...
                      </td>
                    </tr>
                  ) : releases.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                        暂无匹配版本
                      </td>
                    </tr>
                  ) : (
                    releases.map((item) => (
                      <tr
                        key={item.id}
                        className={`border-t transition-colors hover:bg-muted/40 ${
                          item.id === selectedReleaseId ? 'bg-muted/60' : ''
                        }`}
                      >
                        <td className="px-4 py-3">
                          <div className="font-medium">v{item.version}</div>
                          <div className="text-body text-muted-foreground">
                            {platformArchLabel(item.platform, item.arch)}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline">{channelLabel(item.channel)}</Badge>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={statusBadgeVariant(item.status)}>
                            {releaseStatusLabel(item.status)}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">{item.rollout_percentage}%</td>
                        <td className="px-4 py-3">
                          {item.sent_push_count}/{item.push_count}
                        </td>
                        <td className="px-4 py-3 text-body text-muted-foreground">
                          {formatDateTime(item.published_at)}
                        </td>
                        <td className="px-4 py-3">
                          <Button
                            variant={item.id === selectedReleaseId ? 'secondary' : 'ghost'}
                            size="sm"
                            onClick={() => setSelectedReleaseId(item.id)}
                          >
                            查看
                          </Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>版本详情</CardTitle>
            <CardDescription>发布策略、推送动作和客户端更新结果都汇总在这里。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {detailLoading ? (
              <div className="rounded-lg border border-dashed px-4 py-10 text-center text-muted-foreground">
                加载详情中...
              </div>
            ) : !detail ? (
              <div className="rounded-lg border border-dashed px-4 py-10 text-center text-muted-foreground">
                请选择左侧一个版本
              </div>
            ) : (
              <>
                <div className="rounded-lg border p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-title font-semibold">v{detail.release.version}</div>
                    <Badge variant={statusBadgeVariant(detail.release.status)}>
                      {releaseStatusLabel(detail.release.status)}
                    </Badge>
                    <Badge variant="outline">
                      {platformArchLabel(detail.release.platform, detail.release.arch)}
                    </Badge>
                    <Badge variant="outline">{channelLabel(detail.release.channel)}</Badge>
                    {detail.release.is_mandatory && <Badge variant="destructive">强制更新</Badge>}
                  </div>
                  <div className="mt-2 text-body text-muted-foreground">
                    发布人 {detail.release.created_by_name || '—'} · 发布时间{' '}
                    {formatDateTime(detail.release.published_at)}
                  </div>
                  <div className="mt-3 text-body">
                    <div className="font-medium">更新日志</div>
                    <div className="mt-1 whitespace-pre-wrap text-muted-foreground">
                      {detail.release.release_notes || '—'}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={openEditDialog}>
                    <Edit3 className="mr-2 h-4 w-4" />
                    编辑
                  </Button>
                  {detail.release.status === 'draft' ? (
                    <Button onClick={() => void handlePublish()}>
                      <Rocket className="mr-2 h-4 w-4" />
                      发布
                    </Button>
                  ) : (
                    <>
                      <Button onClick={() => void handlePush(false)}>
                        <Send className="mr-2 h-4 w-4" />
                        推送提醒
                      </Button>
                      <Button variant="secondary" onClick={() => void handlePush(true)}>
                        <ShieldAlert className="mr-2 h-4 w-4" />
                        静默下载
                      </Button>
                    </>
                  )}
                  {detail.release.rollout_percentage < 100 && detail.release.status !== 'draft' && (
                    <Button variant="outline" onClick={() => void handleRolloutToFull()}>
                      灰度到 100%
                    </Button>
                  )}
                  {detail.release.rollout_percentage > 0 &&
                    detail.release.status !== 'draft' &&
                    detail.release.status !== 'deprecated' && (
                      <Button variant="outline" onClick={() => void handleStopRollout()}>
                        停止扩散（灰度 0%）
                      </Button>
                    )}
                  {detail.release.status !== 'deprecated' && (
                    <Button variant="destructive" onClick={() => void handleDeprecate()}>
                      <Ban className="mr-2 h-4 w-4" />
                      废弃版本
                    </Button>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <MetricCard
                    title="总尝试"
                    value={detail.metrics.total_attempts}
                    hint="可用于观测总体触达"
                  />
                  <MetricCard
                    title="已安装"
                    value={detail.metrics.installed_count}
                    hint={`成功率 ${detail.metrics.success_rate}%`}
                  />
                  <MetricCard
                    title="下载中"
                    value={detail.metrics.downloading_count}
                    hint={`已下载 ${detail.metrics.downloaded_count}`}
                  />
                  <MetricCard
                    title="失败"
                    value={detail.metrics.failed_count}
                    hint={`24h 尝试 ${detail.metrics.recent_24h_attempts}`}
                  />
                </div>

                <div className="rounded-lg border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-medium">发布流程</div>
                      <div className="mt-1 text-body text-muted-foreground">
                        把发版拆成明确步骤，方便运营知道当前卡在哪一步、下一步该做什么。
                      </div>
                    </div>
                    <Badge variant="outline">
                      {releaseWorkflow?.nextAction || '等待加载版本状态'}
                    </Badge>
                  </div>

                  {releaseWorkflow ? (
                    <div className="mt-4 space-y-2">
                      {releaseWorkflow.steps.map((step, index) => (
                        <div
                          key={step.key}
                          className="flex items-start justify-between gap-3 rounded-md bg-muted/40 px-3 py-3"
                        >
                          <div className="flex items-start gap-3">
                            <div className="flex h-6 w-6 items-center justify-center rounded-full border text-body font-semibold">
                              {index + 1}
                            </div>
                            <div>
                              <div className="font-medium">{step.label}</div>
                              <div className="mt-1 text-body text-muted-foreground">
                                {step.description}
                              </div>
                            </div>
                          </div>
                          <Badge variant={workflowBadgeVariant(step.status)}>
                            {workflowStatusLabel(step.status)}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-4 rounded-md border border-dashed px-3 py-6 text-body text-muted-foreground">
                      正在整理当前版本的发布流程...
                    </div>
                  )}
                </div>

                <div className="rounded-lg border p-4 text-body">
                  <div className="mb-2 font-medium">发布配置</div>
                  <div className="space-y-1 text-muted-foreground">
                    <div>下载地址：{detail.release.file_url || '—'}</div>
                    <div>更新源目录：{detail.release.effective_feed_url || '—'}</div>
                    <div>更新清单文件：{detail.release.manifest_file}</div>
                    <div>更新清单地址：{detail.release.manifest_url || '—'}</div>
                    <div>安装包文件名：{detail.release.asset_name || '—'}</div>
                    <div>
                      更新源来源：
                      {detail.release.feed_url_derived ? '按安装包目录自动推导' : '后台显式配置'}
                    </div>
                    <div>文件大小：{formatFileSize(detail.release.file_size)}</div>
                    <div>SHA256：{summarizeHash(detail.release.checksum_sha256)}</div>
                    <div>SHA512：{summarizeHash(detail.release.checksum_sha512)}</div>
                    <div>优先级：{priorityLabel(detail.release.priority)}</div>
                    <div>最低兼容版本：{detail.release.min_compatible_version || '—'}</div>
                    <div>当前灰度：{detail.release.rollout_percentage}%</div>
                    <div>灰度白名单：{detail.release.rollout_target_users.length || 0} 人</div>
                    <div>最近推送：{formatDateTime(detail.release.last_push_at)}</div>
                  </div>
                  {detail.release.source_warnings.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {detail.release.source_warnings.map((warning) => (
                        <div
                          key={warning}
                          className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-body text-warning"
                        >
                          {warning}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="rounded-lg border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-medium">发布资产</div>
                      <div className="mt-1 text-body text-muted-foreground">
                        支持先建版本、后传安装包。上传安装包后会自动回填下载地址、文件大小、SHA256 /
                        SHA512，并可一键生成 Electron 更新清单。
                      </div>
                    </div>
                    <Badge variant={assetUploadState ? 'warning' : 'outline'}>
                      {assetUploadState
                        ? `${assetTypeLabel(assetUploadState.assetType)} · ${assetUploadState.step}`
                        : '托管上传'}
                    </Badge>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-md bg-muted/40 px-3 py-3 text-body">
                      <div className="text-body text-muted-foreground">自动更新安装包</div>
                      <div className="mt-1 font-medium">
                        {detail.release.asset_name || '尚未上传安装包'}
                      </div>
                      <div className="mt-1 break-all text-body text-muted-foreground">
                        {detail.release.file_url || '上传后会自动生成稳定下载地址'}
                      </div>
                      <div className="mt-2 text-body text-muted-foreground">
                        大小 {formatFileSize(detail.release.file_size)} · SHA256{' '}
                        {summarizeHash(detail.release.checksum_sha256)} · SHA512{' '}
                        {summarizeHash(detail.release.checksum_sha512)}
                      </div>
                    </div>
                    <div className="rounded-md bg-muted/40 px-3 py-3 text-body">
                      <div className="text-body text-muted-foreground">官网安装包</div>
                      <div className="mt-1 font-medium">
                        {detail.release.website_asset_name || '尚未上传官网安装包'}
                      </div>
                      <div className="mt-1 break-all text-body text-muted-foreground">
                        {detail.release.website_file_url ||
                          'macOS 正式版需上传 .dmg；Windows 可空并回退自动更新包'}
                      </div>
                      <div className="mt-2 text-body text-muted-foreground">
                        短链目标 {detail.release.download_file_url || '—'}
                      </div>
                    </div>
                    <div className="rounded-md bg-muted/40 px-3 py-3 text-body sm:col-span-2">
                      <div className="text-body text-muted-foreground">更新清单托管</div>
                      <div className="mt-1 font-medium">{detail.release.manifest_file}</div>
                      <div className="mt-1 break-all text-body text-muted-foreground">
                        {detail.release.manifest_url || '生成后会自动回填更新源目录'}
                      </div>
                      <div className="mt-2 text-body text-muted-foreground">
                        更新源 {detail.release.effective_feed_url || '—'} · 就绪状态{' '}
                        {readinessStatusLabel(currentReadiness?.status || '')}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                      disabled={Boolean(assetUploadState)}
                      onClick={() => packageFileInputRef.current?.click()}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      上传安装包并自动生成更新清单
                    </Button>
                    <Button
                      variant="outline"
                      disabled={Boolean(assetUploadState)}
                      onClick={() => websiteInstallerFileInputRef.current?.click()}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      上传官网安装包
                    </Button>
                    <Button
                      variant="outline"
                      disabled={Boolean(assetUploadState)}
                      onClick={() => manifestFileInputRef.current?.click()}
                    >
                      <Edit3 className="mr-2 h-4 w-4" />
                      上传自定义更新清单
                    </Button>
                    <Button
                      variant="outline"
                      disabled={Boolean(assetUploadState) || !detail.release.asset_name}
                      onClick={() => blockmapFileInputRef.current?.click()}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      上传差分索引
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={Boolean(assetUploadState) || !detail.release.checksum_sha512}
                      onClick={() => void handleGenerateManifest()}
                    >
                      <RefreshCw className="mr-2 h-4 w-4" />
                      重新生成更新清单
                    </Button>
                  </div>

                  <div className="mt-3 text-body text-muted-foreground">
                    {detail.release.checksum_sha512
                      ? `推荐流程：先上传自动更新安装包并生成清单，再上传官网安装包；差分索引可选。${packageUploadRule.description} ${websiteInstallerUploadRule.description}`
                      : `当前版本还没有 SHA512。先上传自动更新安装包，系统会自动计算并打开一键生成更新清单的能力。${packageUploadRule.description} ${websiteInstallerUploadRule.description}`}
                  </div>

                  {assetUploadState && (
                    <div className="mt-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-body text-warning">
                      正在处理 {assetUploadState.fileName}：{assetUploadState.step}
                    </div>
                  )}

                  <input
                    ref={packageFileInputRef}
                    hidden
                    type="file"
                    accept={packageUploadRule.accept}
                    onChange={(event) => void handlePackageFileChange(event)}
                  />
                  <input
                    ref={websiteInstallerFileInputRef}
                    hidden
                    type="file"
                    accept={websiteInstallerUploadRule.accept}
                    onChange={(event) => void handleWebsiteInstallerFileChange(event)}
                  />
                  <input
                    ref={manifestFileInputRef}
                    hidden
                    type="file"
                    accept=".yml,.yaml,text/yaml"
                    onChange={(event) => void handleManifestFileChange(event)}
                  />
                  <input
                    ref={blockmapFileInputRef}
                    hidden
                    type="file"
                    accept=".blockmap,application/octet-stream"
                    onChange={(event) => void handleBlockmapFileChange(event)}
                  />
                </div>

                <div className="rounded-lg border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-medium">更新清单预览</div>
                      <div className="mt-1 text-body text-muted-foreground">
                        这里展示系统按当前版本配置将要发布的确切 YAML，便于在生成前先审一遍。
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={manifestPreviewLoading}
                        onClick={() => void loadManifestPreview(detail.release.id)}
                      >
                        <RefreshCw
                          className={`mr-2 h-4 w-4 ${manifestPreviewLoading ? 'animate-spin' : ''}`}
                        />
                        {manifestPreviewLoading ? '刷新中...' : '刷新预览'}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!currentManifestPreview?.content}
                        onClick={() => void handleCopyManifestPreview()}
                      >
                        <Copy className="mr-2 h-4 w-4" />
                        复制 YAML
                      </Button>
                    </div>
                  </div>

                  {!currentManifestPreview ? (
                    <div className="mt-4 rounded-md border border-dashed px-3 py-6 text-body text-muted-foreground">
                      {manifestPreviewLoading
                        ? '正在生成更新清单预览...'
                        : '暂未加载更新清单预览。'}
                    </div>
                  ) : !currentManifestPreview.can_generate ? (
                    <div className="mt-4 space-y-2">
                      {currentManifestPreview.issues.map((issue) => (
                        <div
                          key={issue}
                          className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-body text-warning"
                        >
                          {issue}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-4 space-y-3">
                      <div className="rounded-md bg-muted/40 px-3 py-3 text-body text-muted-foreground">
                        <div>文件：{currentManifestPreview.manifest_file}</div>
                        <div className="mt-1 break-all">
                          地址：{currentManifestPreview.manifest_url || '—'}
                        </div>
                      </div>
                      <pre className="overflow-x-auto rounded-md bg-background px-4 py-4 text-body leading-6 text-foreground">
                        {currentManifestPreview.content}
                      </pre>
                    </div>
                  )}
                </div>

                <div className="rounded-lg border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-medium">发布就绪检查</div>
                      <div className="mt-1 text-body text-muted-foreground">
                        校验远端 manifest、安装包指向和资源可达性。发布、推送、灰度前都会走这一步。
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={readinessBadgeVariant(currentReadiness?.status || 'outline')}>
                        {readinessStatusLabel(currentReadiness?.status || '')}
                      </Badge>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={readinessLoading}
                        onClick={() => void loadReadiness(detail.release.id)}
                      >
                        <RefreshCw
                          className={`mr-2 h-4 w-4 ${readinessLoading ? 'animate-spin' : ''}`}
                        />
                        {readinessLoading ? '检查中...' : '立即检查'}
                      </Button>
                    </div>
                  </div>

                  {!currentReadiness ? (
                    <div className="mt-4 rounded-md border border-dashed px-3 py-6 text-body text-muted-foreground">
                      {readinessLoading
                        ? '正在获取当前版本的发布就绪状态...'
                        : '暂未拿到发布就绪结果，你可以手动重新检查。'}
                    </div>
                  ) : (
                    <>
                      <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        <div className="rounded-md bg-muted/40 px-3 py-3 text-body">
                          <div className="text-body text-muted-foreground">更新清单</div>
                          <div className="mt-1 font-medium">
                            HTTP {currentReadiness.manifest_http_status ?? '—'} · 版本{' '}
                            {currentReadiness.manifest_version || '—'}
                          </div>
                          <div className="mt-1 break-all text-body text-muted-foreground">
                            {currentReadiness.manifest_url}
                          </div>
                          <div className="mt-1 text-body text-muted-foreground">
                            文件 {currentReadiness.manifest_file} · 检查时间{' '}
                            {formatDateTime(currentReadiness.checked_at)}
                          </div>
                        </div>
                        <div className="rounded-md bg-muted/40 px-3 py-3 text-body">
                          <div className="text-body text-muted-foreground">安装包</div>
                          <div className="mt-1 font-medium">
                            HTTP {currentReadiness.asset.http_status ?? '—'} · 大小{' '}
                            {formatFileSize(currentReadiness.asset.size)}
                          </div>
                          <div className="mt-1 break-all text-body text-muted-foreground">
                            {currentReadiness.asset.resolved_url || '—'}
                          </div>
                          <div className="mt-1 text-body text-muted-foreground">
                            更新清单原始路径 {currentReadiness.asset.raw_url || '—'} · SHA512{' '}
                            {summarizeHash(currentReadiness.asset.sha512)}
                          </div>
                        </div>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2 text-body">
                        <Badge variant="outline">
                          阻塞 {currentReadiness.blocking_issue_count}
                        </Badge>
                        <Badge variant="outline">警告 {currentReadiness.warning_issue_count}</Badge>
                        <Badge variant="outline">提示 {currentReadiness.info_issue_count}</Badge>
                        {currentReadiness.staging_percentage !== null && (
                          <Badge variant="warning">
                            灰度比例 {currentReadiness.staging_percentage}%
                          </Badge>
                        )}
                      </div>

                      {currentReadiness.issues.length === 0 ? (
                        <div className="mt-3 flex items-start gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-3 text-body text-success">
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>远端 manifest 与安装包链路已通过检查，可以继续发布和灰度。</span>
                        </div>
                      ) : (
                        <div className="mt-3 space-y-2">
                          {currentReadiness.issues.map((issue) => (
                            <div
                              key={`${issue.code}-${issue.message}`}
                              className={`rounded-md border px-3 py-3 text-body ${readinessIssueTone(issue.severity)}`}
                            >
                              <div className="flex items-start gap-2">
                                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                                <div className="space-y-1">
                                  <div className="font-medium">
                                    {severityLabel(issue.severity)} · {issue.message}
                                  </div>
                                  {(issue.expected || issue.actual) && (
                                    <div className="space-y-1 break-all opacity-90">
                                      {issue.expected && <div>期望：{issue.expected}</div>}
                                      {issue.actual && <div>实际：{issue.actual}</div>}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>

                <div className="rounded-lg border p-4">
                  <div className="mb-2 font-medium">近 7 天活跃版本分布</div>
                  <div className="space-y-2 text-body">
                    {detail.active_version_distribution.length === 0 ? (
                      <div className="text-muted-foreground">暂无活跃版本数据</div>
                    ) : (
                      detail.active_version_distribution.map((item) => (
                        <div
                          key={item.from_version}
                          className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2"
                        >
                          <span>v{item.from_version || '未知版本'}</span>
                          <Badge variant="outline">{item.count} 台设备</Badge>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="rounded-lg border p-4">
                  <div className="mb-2 font-medium">最近推送记录</div>
                  <div className="space-y-2 text-body">
                    {detail.push_records.length === 0 ? (
                      <div className="text-muted-foreground">暂无推送记录</div>
                    ) : (
                      detail.push_records.map((record) => (
                        <div key={record.id} className="rounded-md bg-muted/40 px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <Badge
                              variant={
                                record.status === 'sent'
                                  ? 'success'
                                  : record.status === 'failed'
                                    ? 'destructive'
                                    : 'warning'
                              }
                            >
                              {pushStatusLabel(record.status)}
                            </Badge>
                            <span className="text-body text-muted-foreground">
                              {formatDateTime(record.pushed_at)}
                            </span>
                          </div>
                          <div className="mt-1 text-body text-muted-foreground">
                            灰度 {record.rollout_percentage}% ·{' '}
                            {record.silent ? '静默下载' : '弹窗提醒'} ·{' '}
                            {record.pushed_by_name || '系统'}
                          </div>
                          {record.error_message && (
                            <div className="mt-1 text-body text-destructive">
                              {record.error_message}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="rounded-lg border p-4">
                  <div className="mb-2 font-medium">最近客户端日志</div>
                  <div className="space-y-2 text-body">
                    {detail.recent_logs.length === 0 ? (
                      <div className="text-muted-foreground">暂无客户端更新日志</div>
                    ) : (
                      detail.recent_logs.map((log) => (
                        <div key={log.id} className="rounded-md bg-muted/40 px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <Badge
                                variant={
                                  log.status === 'installed'
                                    ? 'success'
                                    : log.status === 'failed'
                                      ? 'destructive'
                                      : 'outline'
                                }
                              >
                                {updateLogStatusLabel(log.status)}
                              </Badge>
                              <span className="text-body text-muted-foreground">
                                {triggerSourceLabel(log.trigger_source)}
                              </span>
                            </div>
                            <span className="text-body text-muted-foreground">
                              {formatDateTime(log.started_at)}
                            </span>
                          </div>
                          <div className="mt-1 text-body text-muted-foreground">
                            设备 {log.device_id || '—'} · {log.from_version} → {log.to_version} ·
                            进度 {Math.round(log.progress)}%
                          </div>
                          {log.error_message && (
                            <div className="mt-1 text-body text-destructive">
                              {log.error_message}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="flex max-h-[86vh] max-w-3xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>{dialogMode === 'create' ? '新建桌面版本' : '编辑桌面版本'}</DialogTitle>
            <DialogDescription>
              这里维护的是运营侧版本策略配置，发布后即可用于 Electron 更新提醒、灰度和统计观察。
            </DialogDescription>
          </DialogHeader>

          <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto pr-1 md:grid-cols-2">
            <Field label="版本号">
              <Input
                value={form.version}
                disabled={dialogMode === 'edit'}
                onChange={(event) => setForm((prev) => ({ ...prev, version: event.target.value }))}
              />
            </Field>
            <Field label="安装包地址（草稿可留空）">
              <Input
                placeholder="可先留空，创建后用“发布资产”面板上传"
                value={form.file_url}
                onChange={(event) => setForm((prev) => ({ ...prev, file_url: event.target.value }))}
              />
            </Field>
            <Field label="更新源目录（可选）">
              <Input
                placeholder="留空时按安装包目录自动推导"
                value={form.feed_url}
                onChange={(event) => setForm((prev) => ({ ...prev, feed_url: event.target.value }))}
              />
            </Field>
            <Field label="平台">
              <Select
                value={form.platform}
                disabled={dialogMode === 'edit'}
                onValueChange={(value: ReleaseFormState['platform']) =>
                  setForm((prev) => ({ ...prev, platform: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORM_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="架构">
              <Select
                value={form.arch}
                disabled={dialogMode === 'edit'}
                onValueChange={(value: ReleaseFormState['arch']) =>
                  setForm((prev) => ({ ...prev, arch: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="x64">x64</SelectItem>
                  <SelectItem value="arm64">arm64</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="渠道">
              <Select
                value={form.channel}
                disabled={dialogMode === 'edit'}
                onValueChange={(value: ReleaseFormState['channel']) =>
                  setForm((prev) => ({ ...prev, channel: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHANNEL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="文件大小（字节，可留空）">
              <Input
                type="number"
                placeholder="留空或填 0，后续上传安装包后自动回填"
                value={form.file_size}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, file_size: event.target.value }))
                }
              />
            </Field>
            <Field label="SHA256（可留空）">
              <Input
                placeholder="留空后可通过上传安装包自动计算"
                value={form.checksum_sha256}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, checksum_sha256: event.target.value }))
                }
              />
            </Field>
            <Field label="优先级">
              <Select
                value={form.priority}
                onValueChange={(value) => setForm((prev) => ({ ...prev, priority: value }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">低</SelectItem>
                  <SelectItem value="normal">普通</SelectItem>
                  <SelectItem value="high">高</SelectItem>
                  <SelectItem value="critical">紧急</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="灰度比例（0-100）">
              <Input
                type="number"
                min="0"
                max="100"
                value={form.rollout_percentage}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, rollout_percentage: event.target.value }))
                }
              />
            </Field>
            <Field label="最低兼容版本">
              <Input
                value={form.min_compatible_version}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, min_compatible_version: event.target.value }))
                }
              />
            </Field>
            <Field label="更新源预览" className="md:col-span-2">
              <div className="rounded-lg border bg-muted/20 px-3 py-3 text-body text-muted-foreground">
                <div>生效更新源：{effectiveFeedUrlPreview || '请输入安装包地址后自动生成'}</div>
                <div>更新清单文件：{manifestFilePreview}</div>
                <div>更新清单地址：{manifestUrlPreview || '—'}</div>
                <div>
                  当前策略：
                  {form.channel === 'stable'
                    ? '正式版使用 latest*.yml'
                    : `${channelLabel(form.channel)} 使用 ${form.channel}*.yml`}
                </div>
                <div>如果先创建草稿，后续可在详情页直接上传安装包并一键生成更新清单。</div>
              </div>
            </Field>
            <Field label="强制更新" className="md:col-span-2">
              <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-body">
                <input
                  type="checkbox"
                  checked={form.is_mandatory}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, is_mandatory: event.target.checked }))
                  }
                />
                <span>低版本必须升级后才能继续使用</span>
              </label>
            </Field>
            <Field label="灰度白名单（每行一个用户 ID）" className="md:col-span-2">
              <Textarea
                rows={2}
                value={form.rollout_target_users_text}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, rollout_target_users_text: event.target.value }))
                }
              />
            </Field>
            <Field label="中文更新日志" className="md:col-span-2">
              <Textarea
                rows={3}
                value={form.release_notes}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, release_notes: event.target.value }))
                }
              />
            </Field>
            <Field label="英文更新日志" className="md:col-span-2">
              <Textarea
                rows={2}
                value={form.release_notes_en}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, release_notes_en: event.target.value }))
                }
              />
            </Field>
          </div>

          <DialogFooter className="shrink-0 pt-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void handleSave()} disabled={isSaving}>
              {isSaving ? '保存中...' : dialogMode === 'create' ? '创建版本' : '保存修改'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}

function MetricCard({ title, value, hint }: { title: string; value: number; hint: string }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-body text-muted-foreground">{title}</div>
      <div className="mt-1 text-heading font-semibold">{value}</div>
      <div className="mt-2 text-body text-muted-foreground">{hint}</div>
    </div>
  )
}

function Field({
  label,
  children,
  className = '',
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      <div className="text-body font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  )
}
