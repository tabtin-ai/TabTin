import React from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  FileClock,
  MessageSquareText,
  Package,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { RollbackPreviewResult } from '../../../../services/chatExtraApi'
import type { EditResendImpactDerived } from './deriveRewindPreviewUi'
import { ResourceRestorePlanSection } from './RewindResourceSections'

type Translate = ReturnType<typeof useTranslation<'chat'>>['t']

const FILE_PREVIEW_REASON_COPY: Record<string, { key: string; defaultValue: string }> = {
  device_offline: { key: 'rewind.editResendFilePreviewDeviceOffline', defaultValue: '控制工作区文件的设备当前离线，无法确认文件版本。' },
  control_device_offline: { key: 'rewind.editResendFilePreviewDeviceOffline', defaultValue: '控制工作区文件的设备当前离线，无法确认文件版本。' },
  timeout: { key: 'rewind.editResendFilePreviewTimeout', defaultValue: '检查工作区文件版本超时，设备可能暂时不可用。' },
  device_timeout: { key: 'rewind.editResendFilePreviewTimeout', defaultValue: '检查工作区文件版本超时，设备可能暂时不可用。' },
  no_file_history: { key: 'rewind.editResendFilePreviewNoHistory', defaultValue: '当前设备没有这轮对话的文件版本记录。' },
  execution_context_missing: { key: 'rewind.editResendFilePreviewContextMissing', defaultValue: '这个对话没有可用的工作区执行现场，无法检查文件版本。' },
  no_control_device: { key: 'rewind.editResendFilePreviewNoDevice', defaultValue: '当前工作区没有绑定可读取文件版本的桌面设备。' },
  not_electron_host: { key: 'rewind.editResendFilePreviewUnsupportedDevice', defaultValue: '当前绑定设备不支持文件版本预览。' },
  device_fingerprint_missing: { key: 'rewind.editResendFilePreviewDeviceIncomplete', defaultValue: '桌面设备的连接信息不完整，暂时无法检查文件版本。' },
  preview_not_delivered: { key: 'rewind.editResendFilePreviewNotDelivered', defaultValue: '文件版本检查未送达桌面设备。' },
  preview_timeout: { key: 'rewind.editResendFilePreviewDeviceTimeout', defaultValue: '桌面设备没有及时返回文件版本信息。' },
  preview_failed: { key: 'rewind.editResendFilePreviewReadFailed', defaultValue: '文件所在设备未能读取这轮对话的版本记录。' },
  daemon_preview_failed: { key: 'rewind.editResendFilePreviewReadFailed', defaultValue: '文件所在设备未能读取这轮对话的版本记录。' },
  invalid_preview_result: { key: 'rewind.editResendFilePreviewInvalid', defaultValue: '设备返回的文件版本信息无法识别。' },
  path_guard_denied: { key: 'rewind.editResendFilePreviewProtectedPath', defaultValue: '部分文件位于受保护区域，无法安全回退。' },
  file_snapshot_missing: { key: 'rewind.editResendFilePreviewSnapshotMissing', defaultValue: '这轮对话对应的文件快照已不存在。' },
  unrestorable_files: { key: 'rewind.editResendFilePreviewKnownGap', defaultValue: '检测到没有可恢复版本的文件，无法完整恢复工作区。' },
  file_history_ipc_unavailable: { key: 'rewind.editResendFileHistoryUnavailable', defaultValue: '当前客户端无法读取本机文件版本记录。' },
  local_file_preview_failed: { key: 'rewind.editResendLocalFilePreviewFailed', defaultValue: '当前客户端读取本机文件版本记录失败。' },
  file_preview_contract_unknown: { key: 'rewind.editResendFilePreviewContractUnknown', defaultValue: '当前服务没有返回可确认的文件版本状态。' },
  rollback_preview_revision_missing: { key: 'rewind.editResendPreviewRevisionMissing', defaultValue: '当前预览缺少对话与资源版本校验，请重新检查后再发送。' },
  file_preview_revision_missing: { key: 'rewind.editResendFilePreviewRevisionMissing', defaultValue: '当前预览缺少文件版本校验，请重新检查后再发送。' },
}

function getFilePreviewReason(reason: string | null, t: Translate): string | null {
  if (!reason) return null
  const normalizedReason = reason.trim().toLowerCase()
  const copy = FILE_PREVIEW_REASON_COPY[normalizedReason]
  if (copy) return t(copy.key, { defaultValue: copy.defaultValue })
  return t('rewind.editResendFilePreviewFailedReason', {
    reason,
    defaultValue: '文件版本检查未完成（{{reason}}）。',
  })
}

const FILE_GAP_REASON_COPY: Record<string, { key: string; defaultValue: string }> = {
  missing_metadata: { key: 'rewind.editResendFileGapMissingMetadata', defaultValue: '缺少版本记录' },
  unsupported: { key: 'rewind.editResendFileGapUnsupported', defaultValue: '不支持自动恢复' },
  backup_failed: { key: 'rewind.editResendFileGapBackupFailed', defaultValue: '创建备份时失败' },
  backup_missing: { key: 'rewind.editResendFileGapBackupMissing', defaultValue: '备份已不存在' },
  current_non_file: { key: 'rewind.editResendFileGapCurrentNonFile', defaultValue: '当前路径已不是普通文件' },
  probe_failed: { key: 'rewind.editResendFileGapProbeFailed', defaultValue: '无法读取当前文件状态' },
  path_guard_denied: { key: 'rewind.editResendFileGapProtectedPath', defaultValue: '路径受保护' },
}

function getFileGapReason(reason: string, t: Translate): string {
  const copy = FILE_GAP_REASON_COPY[reason]
  return copy
    ? t(copy.key, { defaultValue: copy.defaultValue })
    : t('rewind.editResendFileGapUnknown', { reason, defaultValue: '无法恢复（{{reason}}）' })
}

function getResourceWarning(resources: EditResendImpactDerived['resources'], t: Translate): string | null {
  if (resources.status === 'partial') {
    return t('rewind.editResendResourcePartial', {
      count: resources.affectedCount - resources.restorableCount,
      defaultValue: '{{count}} 个资源没有可恢复版本；继续后它们将保持当前状态。',
    })
  }
  if (resources.status !== 'unavailable') return null
  return t('rewind.editResendResourcePreviewUnavailable', {
    reason: resources.reason ?? '未知原因',
    defaultValue: '资源影响检查未完成（{{reason}}）。为避免对话与资源不一致，请重新检查或取消。',
  })
}

const FileImpactDescription: React.FC<{
  files: EditResendImpactDerived['files']
  t: Translate
}> = ({ files, t }) => {
  if (files.status === 'unavailable') {
    const reason = getFilePreviewReason(files.reason, t)
    return (
      <div role="alert" className="space-y-1">
        {reason && <p>{reason}</p>}
        {(files.unrestorableFiles?.length ?? 0) > 0 && (
          <ul className="space-y-0.5 pl-4 text-caption" aria-label={t('rewind.editResendUnrestorableFiles', { defaultValue: '无法恢复的文件' })}>
            {(files.unrestorableFiles ?? []).slice(0, 5).map(file => (
              <li key={`${file.path}:${file.reason}`} className="list-disc break-all">
                <span className="font-medium text-foreground">{file.path}</span>
                {' — '}{getFileGapReason(file.reason, t)}
              </li>
            ))}
            {(files.unrestorableFiles?.length ?? 0) > 5 && (
              <li className="list-none">
                {t('rewind.editResendMoreUnrestorableFiles', {
                  count: (files.unrestorableFiles?.length ?? 0) - 5,
                  defaultValue: '另有 {{count}} 个文件无法恢复。',
                })}
              </li>
            )}
          </ul>
        )}
        <p>{files.canContinueConversationOnly
          ? t('rewind.editResendFilesUnavailableCanSkip', {
              defaultValue: '无法确认工作区文件会回到哪个版本。你可以重新检查，或明确选择只重写对话；文件将保持当前状态。',
            })
          : t('rewind.editResendFilesUnavailable', {
              defaultValue: '无法确认工作区文件会回到哪个版本。为避免文件与对话不一致，请重新检查或取消。',
            })}</p>
      </div>
    )
  }
  if (files.status === 'not_applicable') {
    return t('rewind.editResendFilesNoImpact', {
      defaultValue: '未发现需要恢复的工作区文件版本，文件不会变更。',
    })
  }
  if (files.affectedCount == null) {
    return t('rewind.editResendFilesWillRestore', {
      defaultValue: '相关工作区文件将恢复到这轮 Agent 工作开始前的可用版本。',
    })
  }
  return t('rewind.editResendFilesWillRestoreCount', {
    count: files.affectedCount,
    defaultValue: '将把 {{count}} 个工作区文件恢复到这轮 Agent 工作开始前的版本。',
  })
}

const ResourceImpactDescription: React.FC<{
  resources: EditResendImpactDerived['resources']
  t: Translate
}> = ({ resources, t }) => {
  if (resources.status === 'not_applicable') {
    return t('rewind.editResendResourcesNoImpact', {
      defaultValue: '未发现需要恢复的文档、表格等资源，资源不会变更。',
    })
  }
  if (resources.status === 'will_restore') {
    return t('rewind.editResendResourcesWillRestore', {
      count: resources.restorableCount,
      defaultValue: '将恢复 {{count}} 个资源到本轮对话之前的可用版本。',
    })
  }
  return getResourceWarning(resources, t)
}

const ImpactRow: React.FC<{
  icon: React.ReactNode
  title: string
  children: React.ReactNode
  warning?: boolean
}> = ({ icon, title, children, warning = false }) => (
  <li className={warning
    ? 'flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/5 p-3'
    : 'flex items-start gap-2.5 rounded-lg border border-border bg-muted/20 p-3'}
  >
    <span className={warning ? 'mt-0.5 shrink-0 text-warning' : 'mt-0.5 shrink-0 text-muted-foreground'}>{icon}</span>
    <div className="min-w-0">
      <p className="text-body font-medium text-foreground">{title}</p>
      <div className={warning ? 'mt-0.5 text-body text-warning' : 'mt-0.5 text-body text-muted-foreground'}>{children}</div>
    </div>
  </li>
)

function getFileImpactIcon(status: EditResendImpactDerived['files']['status']): React.ReactNode {
  if (status === 'unavailable') return <AlertTriangle className="h-4 w-4" aria-hidden />
  if (status === 'will_restore') return <FileClock className="h-4 w-4" aria-hidden />
  return <CheckCircle2 className="h-4 w-4" aria-hidden />
}

function getResourceImpactIcon(status: EditResendImpactDerived['resources']['status']): React.ReactNode {
  if (status === 'partial' || status === 'unavailable') return <AlertTriangle className="h-4 w-4" aria-hidden />
  if (status === 'will_restore') return <Package className="h-4 w-4" aria-hidden />
  return <CheckCircle2 className="h-4 w-4" aria-hidden />
}

interface RewindEditResendImpactListProps {
  preview: RollbackPreviewResult
  impact: EditResendImpactDerived
  excludedResources: Set<string>
  onToggleResource: (key: string) => void
  t: Translate
}

export const RewindEditResendImpactList: React.FC<RewindEditResendImpactListProps> = ({
  preview,
  impact,
  excludedResources,
  onToggleResource,
  t,
}) => {
  const resourcePlan = preview.resource_restore_plan ?? []
  const fileWarning = impact.files.status === 'unavailable'
  const resourceWarning = impact.resources.status === 'partial' || impact.resources.status === 'unavailable'

  return (
    <div className="max-h-[48vh] space-y-3 overflow-y-auto pr-1">
      <ul className="space-y-2" aria-label={t('rewind.editResendImpactTitle', { defaultValue: '本次重写的影响' })}>
        <ImpactRow
          icon={<MessageSquareText className="h-4 w-4" aria-hidden />}
          title={t('rewind.editResendConversationTitle', { defaultValue: '对话' })}
        >
          {t('rewind.editResendConversationImpact', {
            count: preview.messages_to_remove,
            defaultValue: '将撤销从这条消息开始的 {{count}} 条消息，并重新生成后续对话。',
          })}
        </ImpactRow>
        <ImpactRow icon={getFileImpactIcon(impact.files.status)} title={t('rewind.editResendFilesTitle', { defaultValue: '工作区文件' })} warning={fileWarning}>
          <FileImpactDescription files={impact.files} t={t} />
        </ImpactRow>
        <ImpactRow icon={getResourceImpactIcon(impact.resources.status)} title={t('rewind.editResendResourcesTitle', { defaultValue: '文档、表格等资源' })} warning={resourceWarning}>
          <ResourceImpactDescription resources={impact.resources} t={t} />
        </ImpactRow>
      </ul>

      {resourcePlan.length > 0 && (
        <ResourceRestorePlanSection
          resourceRestorePlan={resourcePlan}
          excludedResources={excludedResources}
          onToggleResource={onToggleResource}
          t={t}
        />
      )}
      {(preview.unrestorable_items?.length ?? 0) > 0 && (
        <div className="space-y-1 text-caption text-warning" role="note">
          {(preview.unrestorable_items ?? []).map(item => <p key={item}>{item}</p>)}
        </div>
      )}
    </div>
  )
}
