import type { MultimodalDomain, MultimodalOverview as MultimodalOverviewData } from '../../api/multimodal'

const DOMAIN_LABELS: Record<MultimodalDomain, string> = {
  vision: 'Vision (VLM)',
  asr: 'ASR (语音识别)',
  tts: 'TTS (语音合成)',
  image_gen: '图片生成',
  video_gen: '视频生成',
  audio_gen: '音频生成',
}

const DOMAIN_DESCRIPTIONS: Record<MultimodalDomain, string> = {
  vision: 'vision_parse_document',
  asr: 'asr_recognize_flash / asr_transcribe_standard / asr_realtime_stream',
  tts: 'tts_synthesize_http / tts_synthesize_stream',
  image_gen: 'media_image_generate',
  video_gen: 'media_video_generate',
  audio_gen: 'media_bgm_generate',
}

interface MultimodalOverviewProps {
  overview: MultimodalOverviewData | null
  loading: boolean
}

/**
 * 多模态总览 Banner — 6 个 domain 卡片（顶部摘要，所有 Tab 共享）。
 */
export function MultimodalOverview({ overview, loading }: MultimodalOverviewProps) {
  if (loading) {
    return <div className="py-8 text-center text-muted-foreground">加载中...</div>
  }

  if (!overview) {
    return (
      <div className="rounded-lg border bg-muted/20 px-4 py-6 text-center text-body text-muted-foreground">
        加载概览数据失败。
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {(Object.keys(DOMAIN_LABELS) as MultimodalDomain[]).map((d) => {
        const data = overview[d]
        return (
          <div key={d} className="rounded-lg border p-3 space-y-2">
            <div>
              <div className="text-subtitle font-semibold">{DOMAIN_LABELS[d]}</div>
              <div className="text-caption text-muted-foreground font-mono truncate" title={DOMAIN_DESCRIPTIONS[d]}>
                {DOMAIN_DESCRIPTIONS[d]}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-title font-bold">{data?.active_scenes ?? 0}</div>
                <div className="text-caption text-muted-foreground">Scene</div>
              </div>
              <div>
                <div className="text-title font-bold">{data?.active_bindings ?? 0}</div>
                <div className="text-caption text-muted-foreground">已绑定</div>
              </div>
              <div>
                <div className="text-title font-bold">{data?.healthy_models ?? 0}</div>
                <div className="text-caption text-muted-foreground">可用模型</div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
