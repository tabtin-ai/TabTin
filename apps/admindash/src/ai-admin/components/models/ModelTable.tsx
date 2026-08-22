/**
 * `ModelTable` — `/ai/models` 列表表格（宪法 07 §1.3.2）。
 *
 * 每列对照宪法：
 *
 * | 列              | 字段                                    |
 * |-----------------|------------------------------------------|
 * | display_name    | display_name                             |
 * | model_name      | model_name (mono code)                   |
 * | Provider        | provider.display_name (链接到 ProvidersPage) |
 * | Domain          | capability_domain (badge)                |
 * | Capabilities    | <CapabilityBadges />                      |
 * | Context         | context_window_tokens / max_in / max_out |
 * | 计费            | input/output / per_request / per_second  |
 * | 关联 Scenes 数  | related_scenes_count                     |
 * | Wave Status     | wave_status (badge: ready/w2/w3)         |
 * | 操作            | 编辑/探测/估算/profile/删除              |
 *
 * 行内 action 5 个按钮（编辑 / 探测 / token 估算 / 看 capability profile / 删除）
 * 通过 props 注入回调，本组件不直接管对话框生命周期——让 page 集中持有 modal 状态。
 */

import type { LlmAdminModel, WaveStatus } from '@/types/llm-admin'
import { Link } from 'react-router-dom'
import { CapabilityBadges } from './CapabilityBadges'

interface ModelTableProps {
  models: LlmAdminModel[]
  onDetail: (model: LlmAdminModel) => void
  onEdit: (model: LlmAdminModel) => void
  onProbe: (model: LlmAdminModel) => void
  onEstimate: (model: LlmAdminModel) => void
  onProfile: (model: LlmAdminModel) => void
  onDelete: (model: LlmAdminModel) => void
}

const WAVE_STATUS_LABEL: Record<WaveStatus, { label: string; cls: string }> = {
  ready: { label: '可用', cls: 'bg-green-100 text-green-800' },
  w2_pending: { label: '待配置', cls: 'bg-yellow-100 text-yellow-800' },
  w3_pending: { label: '待验证', cls: 'bg-orange-100 text-orange-800' },
}

const DOMAIN_LABELS: Record<string, string> = {
  chat: '文本',
  embedding: 'Embedding',
  vision: '视觉',
  asr: '语音',
  tts: '语音',
  image_gen: '图片',
  video_gen: '视频',
  audio_gen: '音频',
}

const DOMAIN_BADGE_CLS: Record<string, string> = {
  chat: 'bg-blue-100 text-blue-800',
  embedding: 'bg-emerald-100 text-emerald-800',
  vision: 'bg-purple-100 text-purple-800',
  asr: 'bg-cyan-100 text-cyan-800',
  tts: 'bg-pink-100 text-pink-800',
  image_gen: 'bg-amber-100 text-amber-800',
  video_gen: 'bg-rose-100 text-rose-800',
  audio_gen: 'bg-indigo-100 text-indigo-800',
}

export function ModelTable({
  models,
  onDetail,
  onEdit,
  onProbe,
  onEstimate,
  onProfile,
  onDelete,
}: ModelTableProps) {
  if (models.length === 0) {
    return (
      <div className="rounded-lg border bg-muted/20 py-12 text-center text-muted-foreground">
        暂无匹配模型
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-body">
        <thead>
          <tr className="border-b bg-muted/40 text-caption">
            <th className="px-3 py-2.5 text-left font-medium">模型</th>
            <th className="px-3 py-2.5 text-left font-medium">Provider</th>
            <th className="px-3 py-2.5 text-left font-medium">能力</th>
            <th className="px-3 py-2.5 text-center font-medium">状态</th>
            <th className="px-3 py-2.5 text-center font-medium">场景数</th>
            <th className="px-3 py-2.5 text-center font-medium">最近检查</th>
            <th className="px-3 py-2.5 text-left font-medium">更新时间</th>
            <th className="px-3 py-2.5 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => {
            const waveSpec = WAVE_STATUS_LABEL[m.wave_status] || WAVE_STATUS_LABEL.ready
            const domainCls = DOMAIN_BADGE_CLS[m.capability_domain] || 'bg-muted text-foreground'
            return (
              <tr key={m.id} className="border-b hover:bg-muted/20 transition-colors">
                <td className="px-3 py-2.5" title={m.description || undefined}>
                  <button
                    type="button"
                    className="text-left font-medium hover:text-primary"
                    onClick={() => onDetail(m)}
                  >
                    {m.display_name}
                  </button>
                  <div className="mt-1">
                    <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono text-muted-foreground">
                      {m.model_name}
                    </code>
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <Link
                    to={`/ai/providers?provider_id=${m.provider_id}`}
                    className="text-blue-600 hover:underline"
                  >
                    {m.provider_display_name || m.provider_name}
                  </Link>
                  <div className="text-[11px] text-muted-foreground">{m.provider_scope}</div>
                </td>
                <td className="px-3 py-2.5">
                  <div className="mb-1">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-caption font-medium ${domainCls}`}
                      title={m.capability_domain}
                    >
                      {DOMAIN_LABELS[m.capability_domain] ?? m.capability_domain}
                    </span>
                  </div>
                  <CapabilityBadges capabilitiesConfig={m.capabilities_config || {}} />
                </td>
                <td className="px-3 py-2.5 text-center">
                  <div className="flex flex-col items-center gap-1">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-caption font-medium ${waveSpec.cls}`}
                    >
                      {waveSpec.label}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {m.provider_id ? 'Provider 已绑定' : 'Provider 未绑定'}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2.5 text-center">
                  {m.related_scenes_count > 0 ? (
                    <Link
                      to={`/ai/scenes?model_id=${m.id}`}
                      className="text-blue-600 hover:underline text-caption"
                      title="查看哪些 Scene 在用此模型"
                    >
                      {m.related_scenes_count} 个
                    </Link>
                  ) : (
                    <span className="text-caption text-muted-foreground">0 个</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-center text-caption text-muted-foreground">—</td>
                <td className="px-3 py-2.5 text-caption text-muted-foreground">
                  {new Date(m.updated_at).toLocaleString('zh-CN')}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <div className="inline-flex flex-wrap justify-end gap-1">
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-caption font-medium text-primary hover:bg-primary/10 transition-colors"
                      onClick={() => onDetail(m)}
                    >
                      详情
                    </button>
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-caption font-medium text-blue-700 hover:bg-blue-50 transition-colors"
                      onClick={() => onEdit(m)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-caption font-medium text-purple-700 hover:bg-purple-50 transition-colors"
                      onClick={() => onProbe(m)}
                      title="对模型发起一次健康探测"
                    >
                      探测
                    </button>
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-caption font-medium text-cyan-700 hover:bg-cyan-50 transition-colors"
                      onClick={() => onEstimate(m)}
                      title="按一组 messages 估算 token 数和成本"
                    >
                      估算
                    </button>
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-caption font-medium text-emerald-700 hover:bg-emerald-50 transition-colors"
                      onClick={() => onProfile(m)}
                      title="查看 capability_config 完整声明"
                    >
                      能力
                    </button>
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-caption font-medium text-red-700 hover:bg-red-50 transition-colors"
                      onClick={() => onDelete(m)}
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
