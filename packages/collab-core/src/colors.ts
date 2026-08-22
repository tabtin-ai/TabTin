export const COLLAB_PALETTE = [
  '#E53935', // 红
  '#1E88E5', // 蓝
  '#43A047', // 绿
  '#FB8C00', // 橙
  '#8E24AA', // 紫
  '#00ACC1', // 青
  '#F4511E', // 深橙
  '#3949AB', // 靛蓝
  '#7CB342', // 浅绿
  '#C0CA33', // 黄绿
  '#D81B60', // 粉红
  '#039BE5', // 浅蓝
  '#00897B', // 青绿
  '#6D4C41', // 棕
  '#546E7A', // 蓝灰
  '#757575', // 灰
]

export function getUserColor(userId: string, palette: string[] = COLLAB_PALETTE): string {
  let hash = 0
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return palette[Math.abs(hash) % palette.length]
}
