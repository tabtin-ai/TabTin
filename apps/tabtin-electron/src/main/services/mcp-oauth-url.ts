/** 厂商授权页 URL（避免把普通 https 文档链接误当成授权入口）。 */
const OAUTH_AUTHORIZE_URL_RE =
  /https?:\/\/[^\s"'<>]+(?:\/oauth2?\/authorize|\/oauth\/authorize|\boauth2\/v\d+\/auth\b)[^\s"'<>]*/i

function extractAuthorizeUrl(line: string): string | undefined {
  const specific = line.match(OAUTH_AUTHORIZE_URL_RE)
  if (specific?.[0]) return specific[0].replace(/[),.;]+$/g, '')
  // 提示行后的下一行常常是裸授权 URL（无 /oauth/authorize 字样的厂商极少，仍兜底 http(s)）
  return undefined
}

/** 从 mcp-remote stderr 流式解析授权 URL（无 Electron 依赖，便于单测）。 */
export function createOAuthAuthorizeUrlParser(onUrl: (url: string) => void): (line: string) => void {
  let expectUrl = false
  let emitted = false
  const emit = (url: string) => {
    if (emitted) return
    emitted = true
    onUrl(url)
  }
  return (line: string) => {
    if (emitted) return
    // 任意行若已带授权 URL（含与提示同一行），直接打开，避免只 set flag 却漏解析。
    const inline = extractAuthorizeUrl(line)
    if (inline) {
      emit(inline)
      return
    }
    if (/Please authorize this client by visiting:/i.test(line)) {
      expectUrl = true
      // 同句尾部若拼了 URL（无 oauth/authorize 形态），再兜底抓第一个 http(s)
      const loose = line.match(/https?:\/\/\S+/)
      if (loose?.[0]) {
        emit(loose[0].replace(/[),.;]+$/g, ''))
      }
      return
    }
    if (!expectUrl) return
    const match = line.match(/https?:\/\/\S+/)
    if (!match?.[0]) return
    emit(match[0].replace(/[),.;]+$/g, ''))
  }
}
