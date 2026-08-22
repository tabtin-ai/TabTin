/**
 * 路径段安全化 —— 用于将外部输入（spaceId 等）转为安全的目录名
 *
 * 移除 NUL 字节、路径分隔符（/\）、目录遍历（..）、前导点；
 * 超过 MAX_SEGMENT_LENGTH 截断；
 * 空值或清洗后为空时回退到 'default'。
 */
const MAX_SEGMENT_LENGTH = 128

export function sanitizePathSegment(segment: string): string {
  let s = segment.trim()
  s = s.replace(/\0/g, '')
  s = s.replace(/[/\\]/g, '_')
  s = s.replace(/\.\./g, '_')
  s = s.replace(/^\.+/, '')
  if (s.length > MAX_SEGMENT_LENGTH) {
    s = s.slice(0, MAX_SEGMENT_LENGTH)
  }
  return s || 'default'
}
