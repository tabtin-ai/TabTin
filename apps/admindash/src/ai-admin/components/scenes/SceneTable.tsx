import { Checkbox } from '@/components/ui/checkbox'
import type { SceneItem } from '../../api/scenes'

export const DOMAIN_LABELS: Record<string, string> = {
  chat: '文本',
  embedding: 'Embedding',
  vision: '视觉',
  asr: '语音识别',
  tts: '语音合成',
  image_gen: '图片生成',
  video_gen: '视频生成',
  audio_gen: '音频生成',
}

const DOMAIN_COLORS: Record<string, string> = {
  chat: 'bg-blue-100 text-blue-800',
  embedding: 'bg-purple-100 text-purple-800',
  vision: 'bg-green-100 text-green-800',
  asr: 'bg-yellow-100 text-yellow-800',
  tts: 'bg-pink-100 text-pink-800',
  image_gen: 'bg-orange-100 text-orange-800',
  video_gen: 'bg-red-100 text-red-800',
  audio_gen: 'bg-indigo-100 text-indigo-800',
}

function formatTimeAgo(isoStr: string | null): string {
  if (!isoStr) return '未更新'
  const diff = Date.now() - new Date(isoStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

interface SceneTableProps {
  scenes: SceneItem[]
  selectedSceneKeys: Set<string>
  onEditBinding: (scene: SceneItem) => void
  onViewDetail: (scene: SceneItem) => void
  onToggleSelection: (scene: SceneItem) => void
  onToggleVisibleSelection: (checked: boolean) => void
}

export function SceneTable({
  scenes,
  selectedSceneKeys,
  onEditBinding,
  onViewDetail,
  onToggleSelection,
  onToggleVisibleSelection,
}: SceneTableProps) {
  const selectableScenes = scenes.filter((scene) => !scene.is_system)
  const selectedVisibleCount = selectableScenes.filter((scene) =>
    selectedSceneKeys.has(scene.scene_key)
  ).length
  const allVisibleSelected =
    selectableScenes.length > 0 && selectedVisibleCount === selectableScenes.length
  const headerChecked =
    selectedVisibleCount > 0 && !allVisibleSelected ? 'indeterminate' : allVisibleSelected

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-body">
        <thead>
          <tr className="border-b bg-muted/40">
            <th className="w-10 px-3 py-3 text-center font-medium">
              <Checkbox
                aria-label="选择当前筛选结果"
                checked={headerChecked}
                onCheckedChange={(checked) => onToggleVisibleSelection(checked === true)}
                disabled={selectableScenes.length === 0}
              />
            </th>
            <th className="px-4 py-3 text-left font-medium">场景</th>
            <th className="px-4 py-3 text-left font-medium">能力</th>
            <th className="px-4 py-3 text-left font-medium">主模型</th>
            <th className="px-4 py-3 text-left font-medium">备用模型</th>
            <th className="px-4 py-3 text-center font-medium">绑定状态</th>
            <th className="px-4 py-3 text-center font-medium">校验</th>
            <th className="px-4 py-3 text-left font-medium">更新时间</th>
            <th className="px-4 py-3 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {scenes.map((scene) => (
            <tr
              key={scene.scene_key}
              className="border-b hover:bg-muted/20 transition-colors cursor-pointer"
              tabIndex={0}
              onClick={() => onViewDetail(scene)}
              onKeyDown={(event) => {
                const target = event.target
                if (
                  target instanceof HTMLElement &&
                  target.closest('button,a,input,select,textarea,[role="button"],[role="link"]')
                ) {
                  return
                }
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onViewDetail(scene)
                }
              }}
            >
              <td className="px-3 py-3 text-center">
                <span title={scene.is_system ? '系统场景不支持模型绑定' : undefined}>
                  <Checkbox
                    aria-label={`选择场景 ${scene.display_name}`}
                    checked={selectedSceneKeys.has(scene.scene_key)}
                    onClick={(event) => event.stopPropagation()}
                    onCheckedChange={() => onToggleSelection(scene)}
                    disabled={scene.is_system}
                  />
                </span>
              </td>
              <td className="px-4 py-3">
                <div className="font-medium">{scene.display_name}</div>
                <code className="rounded bg-muted px-1.5 py-0.5 text-caption font-mono">
                  {scene.scene_key}
                </code>
              </td>
              <td className="px-4 py-3">
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-caption font-medium ${DOMAIN_COLORS[scene.capability_domain] || 'bg-gray-100 text-gray-800'}`}
                  title={scene.capability_domain}
                >
                  {DOMAIN_LABELS[scene.capability_domain] || scene.capability_domain}
                </span>
              </td>
              <td className="px-4 py-3 text-body">
                {scene.binding?.primary_model ? (
                  <div>
                    <div className="font-medium">{scene.binding.primary_model.display_name}</div>
                    <code className="text-[11px] text-muted-foreground">
                      {scene.binding.primary_model.model_name}
                    </code>
                  </div>
                ) : (
                  <span className="text-red-600">未绑定</span>
                )}
              </td>
              <td className="px-4 py-3 text-body">
                {scene.binding?.fallback_models?.length
                  ? `${scene.binding.fallback_models.length} 个`
                  : '无'}
              </td>
              <td className="px-4 py-3 text-center">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-caption font-medium ${
                    scene.binding ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'
                  }`}
                >
                  {scene.binding ? '已绑定' : '未绑定'}
                </span>
              </td>
              <td className="px-4 py-3 text-center">
                {scene.capability_validation === 'satisfied' ? (
                  <span className="text-green-600" title="校验通过">
                    通过
                  </span>
                ) : (
                  <span className="text-red-500" title="校验异常">
                    异常
                  </span>
                )}
              </td>
              <td className="px-4 py-3 text-body text-muted-foreground">
                {scene.binding ? formatTimeAgo(scene.binding.updated_at) : '未绑定'}
              </td>
              <td className="px-4 py-3 text-right">
                <button
                  type="button"
                  className="rounded px-2 py-1 text-caption font-medium text-primary hover:bg-primary/10 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation()
                    onViewDetail(scene)
                  }}
                >
                  详情
                </button>
                <button
                  type="button"
                  className="rounded px-2 py-1 text-caption font-medium text-blue-700 hover:bg-blue-50 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation()
                    onEditBinding(scene)
                  }}
                >
                  绑定
                </button>
              </td>
            </tr>
          ))}
          {scenes.length === 0 && (
            <tr>
              <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                暂无匹配场景
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
