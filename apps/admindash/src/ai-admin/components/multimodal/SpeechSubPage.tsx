import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { multimodalApi } from '../../api/multimodal'
import type { MultimodalSceneItem, MultimodalVoice, SpeechSubPageData } from '../../api/multimodal'

function SceneRow({ scene }: { scene: MultimodalSceneItem }) {
  const ok = scene.capability_validation === 'satisfied' && scene.binding !== null
  return (
    <tr className="border-b hover:bg-muted/20">
      <td className="px-4 py-3">
        <code className="rounded bg-muted px-1.5 py-0.5 text-caption font-mono">
          {scene.scene_key}
        </code>
        {scene.is_system && (
          <span className="ml-1 inline-flex items-center rounded-full bg-gray-200 px-1.5 py-0.5 text-caption text-gray-700">
            system
          </span>
        )}
      </td>
      <td className="px-4 py-3" title={scene.description}>
        {scene.display_name}
      </td>
      <td className="px-4 py-3">
        {scene.binding ? (
          <div>
            <div className="font-medium">{scene.binding.primary_model.display_name}</div>
            <div className="text-caption text-muted-foreground font-mono">
              {scene.binding.primary_model.model_name} ·{' '}
              {scene.binding.primary_model.provider_display_name ||
                scene.binding.primary_model.provider_name}
            </div>
          </div>
        ) : (
          <span className="text-red-500">未绑定</span>
        )}
      </td>
      <td className="px-4 py-3 text-center">
        {ok ? (
          <span className="text-green-600" title="校验通过">
            ✓
          </span>
        ) : (
          <span
            className="text-red-600"
            title={scene.capability_issues.join(', ') || 'binding 未配置'}
          >
            ✗
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        <Link
          to={`/ai/scenes?scene_key=${encodeURIComponent(scene.scene_key)}`}
          className="rounded px-2 py-1 text-caption font-medium text-primary hover:bg-primary/10"
        >
          编辑绑定
        </Link>
      </td>
    </tr>
  )
}

function ActiveProvidersBadges({
  providerIds,
  models,
  emptyHint,
}: {
  providerIds: string[]
  models: Array<{
    id: string
    display_name: string
    model_name: string
    provider_name: string
    provider_display_name: string
  }>
  emptyHint: string
}) {
  if (providerIds.length === 0) {
    return <div className="text-caption text-muted-foreground">{emptyHint}</div>
  }
  // active_provider_ids 实际是 binding 中正在使用的 model id；本面板按 model id
  // 反查 model 元数据，展示"哪些 model 当前真在被 binding 引用"，让运营一眼看到
  // 在跑哪些 provider/model（替代了"链接到 /ai/providers"的间接跳转）。
  const known = new Map(models.map((m) => [m.id, m]))
  return (
    <div className="flex flex-wrap gap-2">
      {providerIds.map((id) => {
        const m = known.get(id)
        return (
          <span
            key={id}
            className="inline-flex items-center gap-1 rounded-md border bg-blue-50 px-2 py-1 text-caption"
            title={
              m
                ? `${m.model_name} · ${m.provider_display_name || m.provider_name}`
                : `model_id=${id}`
            }
          >
            {m ? (
              <>
                <span className="font-medium">{m.display_name}</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">
                  {m.provider_display_name || m.provider_name}
                </span>
              </>
            ) : (
              <span className="font-mono text-muted-foreground">{id.slice(0, 8)}…</span>
            )}
          </span>
        )
      })}
    </div>
  )
}

function VoicesPanel({ voices, sceneKey }: { voices: MultimodalVoice[]; sceneKey: string }) {
  if (voices.length === 0) {
    return (
      <div className="text-caption text-muted-foreground">
        scene <code>{sceneKey}</code> 当前 primary_model 未声明 available_voices。 请运营在{' '}
        <Link to="/ai/models" className="text-primary hover:underline">
          /ai/models
        </Link>{' '}
        把音色加到 capabilities_config.speech.available_voices。
      </div>
    )
  }
  return (
    <div className="flex flex-wrap gap-2">
      {voices.map((v) => (
        <span
          key={`${sceneKey}:${v.voice_id}`}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-caption"
          title={`${v.display_name} (${v.voice_id})`}
        >
          <span className="font-medium">{v.display_name}</span>
          {v.gender && <span className="text-muted-foreground">· {v.gender}</span>}
          {v.language && <span className="text-muted-foreground">· {v.language}</span>}
        </span>
      ))}
    </div>
  )
}

/**
 * Tab 1：Speech (TTS/ASR) — 宪法 §1.6 Speech 子 Tab。
 *
 * 包含：
 *   - TTS：tts_synthesize_http / tts_synthesize_stream binding + 默认音色
 *   - ASR：asr_recognize_flash / asr_transcribe_standard / asr_realtime_stream binding
 *   - ASR provider 列表 → 链接到 /ai/providers?domain=asr
 */
export function SpeechSubPage() {
  const [data, setData] = useState<SpeechSubPageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    multimodalApi
      .speech()
      .then((d) => setData(d))
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="py-8 text-center text-muted-foreground">加载中...</div>
  }
  if (error) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-body text-red-900">
        加载失败：{error}
      </div>
    )
  }
  if (!data) return null

  const ttsScenes = data.tts.scenes
  const asrScenes = data.asr.scenes
  const ttsVoiceScene = ttsScenes.find((s) => s.available_voices.length > 0) || ttsScenes[0]

  return (
    <div className="space-y-6">
      {/* TTS 区块 */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-subtitle font-semibold">TTS（语音合成）</h3>
            <p className="text-caption text-muted-foreground">
              {ttsScenes.length} 个 scene · {data.tts.available_models.length} 个可用模型
            </p>
          </div>
          <Link to="/ai/providers?domain=tts" className="text-caption text-primary hover:underline">
            管理 TTS Provider →
          </Link>
        </div>

        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-body">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="px-4 py-3 text-left font-medium">Scene</th>
                <th className="px-4 py-3 text-left font-medium">显示名</th>
                <th className="px-4 py-3 text-left font-medium">Primary Model</th>
                <th className="px-4 py-3 text-center font-medium">校验</th>
                <th className="px-4 py-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {ttsScenes.map((s) => (
                <SceneRow key={s.scene_key} scene={s} />
              ))}
              {ttsScenes.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    没有 TTS scene。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="rounded-lg border p-3 space-y-2">
          <div className="text-body font-medium">
            正在使用的 TTS Model（来自 SceneBinding.primary_model）
          </div>
          <ActiveProvidersBadges
            providerIds={data.tts.active_provider_ids}
            models={data.tts.available_models}
            emptyHint="尚无任何 TTS scene 绑定 primary_model。请到 /ai/scenes 配置。"
          />
        </div>

        {ttsVoiceScene && (
          <div className="rounded-lg border p-3 space-y-2">
            <div className="text-body font-medium">
              默认音色（来源：{ttsVoiceScene.binding?.primary_model.display_name || '未绑定'}）
            </div>
            <VoicesPanel
              voices={ttsVoiceScene.available_voices}
              sceneKey={ttsVoiceScene.scene_key}
            />
          </div>
        )}
      </section>

      {/* ASR 区块 */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-subtitle font-semibold">ASR（语音识别）</h3>
            <p className="text-caption text-muted-foreground">
              {asrScenes.length} 个 scene · {data.asr.available_models.length} 个可用模型
            </p>
          </div>
          <Link to="/ai/providers?domain=asr" className="text-caption text-primary hover:underline">
            管理 ASR Provider →
          </Link>
        </div>

        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-body">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="px-4 py-3 text-left font-medium">Scene</th>
                <th className="px-4 py-3 text-left font-medium">显示名</th>
                <th className="px-4 py-3 text-left font-medium">Primary Model</th>
                <th className="px-4 py-3 text-center font-medium">校验</th>
                <th className="px-4 py-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {asrScenes.map((s) => (
                <SceneRow key={s.scene_key} scene={s} />
              ))}
              {asrScenes.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    没有 ASR scene。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="rounded-lg border p-3 space-y-2">
          <div className="text-body font-medium">
            正在使用的 ASR Model（来自 SceneBinding.primary_model）
          </div>
          <ActiveProvidersBadges
            providerIds={data.asr.active_provider_ids}
            models={data.asr.available_models}
            emptyHint="尚无任何 ASR scene 绑定 primary_model。请到 /ai/scenes 配置。"
          />
        </div>
      </section>
    </div>
  )
}
