/**
 * Platform Reach — 归一化领域类型
 *
 * 下游（TabData 落表、聊天引用）只认这里的 `NormalizedItem`，不关心数据来自
 * 哪个平台、走 network 拦截还是 DOM 抓取。接第二个平台不改下游，就靠这一层。
 */

/** 当前已实现的跨平台动词。新动词有真实适配器与 CLI 再加。 */
export type Verb = 'search' | 'read' | 'comments'

/** 平台鉴权级（对齐 OpenCLI 的五级鉴权心智，收敛成够用的四挡）。 */
export type AuthLevel = 'public' | 'cookie' | 'oauth' | 'multi-step'

/**
 * 本次取数时 TabWeb 分区是否已有该站会话 cookie（观测值）。
 * 与 `--use-login`（批量采集开关）无关：开关仍拒；有会话则标 logged-in。
 */
export type AuthContext = 'anonymous' | 'logged-in'

/** 动词风险级：写操作必经人确认。 */
export type RiskLevel = 'read' | 'write-approval'

export interface MediaRef {
  type: 'image' | 'video' | 'audio'
  url: string
  /** 视频封面 / 缩略图。 */
  poster?: string
  width?: number
  height?: number
  durationMs?: number
}

export interface NormalizedComment {
  id: string
  author?: { id?: string; name?: string }
  body: string
  likes?: number
  publishedAt?: string
  /** 楼中楼 / 嵌套回复。 */
  replies?: NormalizedComment[]
}

/**
 * 平台内容的归一化表示。所有适配器动词最终都吐这个形状。
 *
 * `url` 必须是**可回访的签名 URL**（小红书的 `xsec_token` 保留在这），
 * 否则下游拿到的链接点不开、也无法二次 read/comments。
 */
export interface NormalizedItem {
  platform: string
  id: string
  url: string
  title?: string
  author?: { id?: string; name?: string }
  body?: string
  /**
   * 归一化指标层——**薄契约**：只放大多数内容平台都有、语义一致、下游做
   * 跨平台横比时普遍需要的核心维度。轻易不加字段（新增即改契约、影响所有
   * 适配器与下游）。平台私有指标（B站投币/弹幕、播放量等）不进这里，走
   * `platformMetrics` 透传，避免 schema 稀疏膨胀 + 死约定。
   */
  metrics?: {
    likes?: number
    collects?: number
    comments?: number
    shares?: number
  }
  /**
   * 原始指标透传层——**开放袋子**：原样携带平台返回的私有指标（保留平台
   * 自己的字段名，如 bilibili 的 `view/coin/danmaku/favorite`）。下游要深挖
   * 平台特性从这里取；加平台 / 加指标都不改 schema，不用就不读，没有死字段。
   * 只放标量指标（数值），不放 id / url / 文本。
   */
  platformMetrics?: Record<string, number>
  media?: MediaRef[]
  comments?: NormalizedComment[]
  tags?: string[]
  publishedAt?: string
  /** ISO8601，取数时刻。 */
  fetchedAt: string
  authContext: AuthContext
}

/** 创建一个带 `fetchedAt` 的归一化条目，省去每个适配器重复写时间戳。 */
export function makeItem(
  base: Omit<NormalizedItem, 'fetchedAt'> & { fetchedAt?: string },
): NormalizedItem {
  return { ...base, fetchedAt: base.fetchedAt ?? new Date().toISOString() }
}
