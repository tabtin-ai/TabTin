/**
 * @tabtin/markdown-resource-autolink — chat MarkdownRenderer 用的 remark plugin
 *
 * 把 Agent 流式输出 / 用户粘贴的**裸资源链接与裸路径**升级为可点击 link 节点：
 *
 *   "看这个文件 /Users/developer/sandbox/log.json 里的统计"
 *     → "看这个文件 [/Users/developer/sandbox/log.json](tabtin://resource/file/...) 里的统计"
 *
 *   "Windows 路径 C:\\projects\\report.html 也支持"
 *     → "Windows 路径 [C:\\projects\\report.html](tabtin://resource/file/...) 也支持"
 *
 *   "打开 tabtin://resource/table/tbl_1?hint=tabdata"
 *     → "打开 [tabtin://resource/table/tbl_1?...](tabtin://resource/table/tbl_1?...)"
 *
 * 设计取舍（参照专题 RFC §3.5 / W0 N1-9）：
 *   - 只识别**绝对路径**（^/ 或 ^[A-Z]:\\）。相对路径在渲染层无 baseDir 上下文，
 *     交给 D5 行业格式 `file://` 显式表达，本插件不猜
 *   - http(s) URL 由 remark-gfm 初步识别；本插件修正裸链接边界，并补 GFM
 *     不识别的 TabTin 自有资源协议
 *   - 升级目标用 `tabtin://resource/file/<encoded>` 形态，让下游 Router 走
 *     自有格式 type=file 派发；与 iOS 已自约定的 `tabtin://resource/<type>/<id>`
 *     形态对齐（详见 RFC §10.1）
 *   - 路径里允许 ASCII / Unicode 文本字符，但不允许空格 — Agent 想要含空格
 *     路径必须用 markdown 链接 `[文本](file:///...)` 形态显式表达
 *   - 结尾常见标点（,.;:)]}>）不计入路径——避免把句号 / 逗号吞进路径破坏链接
 *
 * 对接：在 `apps/tabtin-electron/src/renderer/src/components/chat/MarkdownRenderer.tsx`
 * 的 `remarkPlugins` 数组追加本插件，必须在 `remark-gfm` 之后（顺序：先 gfm
 * 拆 url，再本插件拆裸路径），保证两者识别集合不重叠也不打架。
 */

import { visit, SKIP } from 'unist-util-visit'
import type { Plugin } from 'unified'
import type { Root, Text, Link, Parent, PhrasingContent } from 'mdast'

/**
 * 绝对路径识别正则。
 *
 *   - POSIX:  `/Users/x/file.md` / `/tmp/out.json` / `/home/u/项目报告.md`
 *   - Windows:`C:\\projects\\report.html` / `D:\\日志\\2026.txt`
 *
 * 不允许的字符：空格、`|<>?*"` 这种 Windows 非法 path 字符；末尾标点。
 *
 * 全局匹配 + 必须在词边界（前为 ^ 或非路径字符 `[\s(\[<«]`），避免在
 * `URL/Users/...` 这种本来就是 URL 的串内乱拆。
 */
/**
 * 路径前的"开始边界"字符集（lookbehind）：行首 / 空白 / 西文 + 中文常见前置标点。
 * 中文段：`「『（〔【〖〘〚` + `\u3000-\u303f`（CJK 标点段，含 、。「」『』等）
 */
const PATH_BOUNDARY_BEFORE = '[\\s(\\[<«「『（〔【〖〘〚\\u3000-\\u303f]'

/**
 * 路径后的"结束边界"字符集（lookahead）：行尾 / 空白 / 西文标点 + 中文标点。
 * 与 BEFORE 对应保持对称——任何中文标点后都视为路径结束。
 */
const PATH_BOUNDARY_AFTER = '$|[\\s)\\]}>»」』）〕】〗〙〛.,;:!?\\u3000-\\u303f\\uff00-\\uffef]'

/**
 * 路径体不允许的字符：
 *   - 空格 / 控制字符 / 换行（`\s`）
 *   - Windows 非法 path 字符（`|<>?*"`）
 *   - 闭合括号系列（`)]}>»」』）〕】〗〙〛`）— 让括号包裹的路径在右括号处结束
 *   - 中文标点段（`\u3000-\u303f`、`\uff00-\uffef`）— 避免把中文逗号 / 句号
 *     吞进路径
 *
 * 路径体仍允许 `.,;:!?` —— `.` 是 `report.html` 必需，西文标点由 lookahead
 * 在贪婪边界处自然让位（path 后随空格 / EOF / 标点都视为结束）。
 */
const PATH_BODY_DENY = '\\s|<>?*"\\n)\\]}>»」』）〕】〗〙〛\\u3000-\\u303f\\uff00-\\uffef'

const ABS_PATH_GLOBAL = new RegExp(
  `(?:^|(?<=${PATH_BOUNDARY_BEFORE}))((?:\\/[^${PATH_BODY_DENY}]+|[A-Za-z]:\\\\[^${PATH_BODY_DENY}]+))(?=${PATH_BOUNDARY_AFTER})`,
  'gu',
)

/** GFM 不识别的 TabTin 自有资源协议；尾随句读不属于链接。 */
const TABTIN_RESOURCE_GLOBAL = /(?:tabtin|tabtin-preprod|tabtin-dev):\/\/resource\/[^\s<>"'`]+/gu
const TABTIN_RESOURCE_TRAILING = /[.,;:!?)\]}'"，。！？、；：）】]+$/u

/**
 * GFM autolink literal 会把紧邻 URL 的中文句读和说明一并放进 link 节点。
 * 裸 URL 中未编码的非 ASCII 标点存在语法歧义，统一视为自然语言边界；确需
 * 标点作为 URL path 时，使用显式 Markdown、尖括号或百分号编码表达。
 */
const HTTP_URL_START_GLOBAL = /https?:\/\//giu
const HTTP_URL_FORBIDDEN_CHAR = /[\s<>"'`]/u
const UNICODE_PUNCTUATION = /\p{P}/u

function isBareHttpTerminator(char: string): boolean {
  const codePoint = char.codePointAt(0)
  return HTTP_URL_FORBIDDEN_CHAR.test(char)
    || (codePoint !== undefined && codePoint > 0x7f && UNICODE_PUNCTUATION.test(char))
}

function findBareHttpEnd(value: string, start: number): number {
  let cursor = start
  for (const char of value.slice(start)) {
    if (isBareHttpTerminator(char)) break
    cursor += char.length
  }
  return cursor
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** 仅接受源码中真正的裸 URL；显式 Markdown / 尖括号链接保持作者定义。 */
function getGfmBareHttpText(node: Link, source: string): string | null {
  if (node.children.length !== 1 || node.children[0]?.type !== 'text') return null
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (typeof start !== 'number' || typeof end !== 'number') return null

  const text = node.children[0].value
  const rawSource = source.slice(start, end)
  if (rawSource !== text || !/^https?:\/\//i.test(rawSource)) return null
  return text
}

function splitBareHttpText(value: string): PhrasingContent[] {
  const nodes: PhrasingContent[] = []
  let cursor = 0
  let matched = false
  let match: RegExpExecArray | null
  HTTP_URL_START_GLOBAL.lastIndex = 0

  while ((match = HTTP_URL_START_GLOBAL.exec(value)) !== null) {
    const start = match.index
    const end = findBareHttpEnd(value, start + match[0].length)
    const url = value.slice(start, end)
    HTTP_URL_START_GLOBAL.lastIndex = end
    if (!isHttpUrl(url)) continue
    matched = true
    if (start > cursor) {
      nodes.push({ type: 'text', value: value.slice(cursor, start) } as Text)
    }
    nodes.push({
      type: 'link',
      url,
      title: null,
      children: [{ type: 'text', value: url } as Text],
    } as Link)
    cursor = end
  }

  if (!matched) return []
  if (cursor < value.length) {
    nodes.push({ type: 'text', value: value.slice(cursor) } as Text)
  }
  return nodes
}

interface AutolinkOptions {
  /**
   * 自定义 URI builder（测试覆盖 / 跨端兼容用）；默认走
   * `tabtin://resource/file/<encodeURIComponent(rawPath)>`。
   */
  buildUri?: (rawPath: string) => string
}

/**
 * 默认 URI builder：升级裸路径为 D5 自有格式 `tabtin://resource/file/<id>`。
 *
 * 与 W2 `packages/resource-router` parser 字符级对齐：parse 后还原 pointer.id =
 * 原始路径（urldecode）；scheme='tabtin' / type='file' / hint=null。
 */
function defaultBuildUri(rawPath: string): string {
  return `tabtin://resource/file/${encodeURIComponent(rawPath)}`
}

/**
 * remark plugin 主入口。Plugin<[]> 表示无配置；Plugin<[AutolinkOptions]>
 * 用于带配置形态。
 */
export const remarkAutolinkResource: Plugin<[AutolinkOptions?], Root> = (
  options = {},
) => {
  const buildUri = options.buildUri ?? defaultBuildUri

  return (tree: Root, file) => {
    const source = typeof file.value === 'string' ? file.value : ''
    if (source) {
      visit(tree, 'link', (node, index, parent) => {
        if (!parent || index === undefined) return
        const value = getGfmBareHttpText(node, source)
        if (!value) return

        const replacement = splitBareHttpText(value)
        if (replacement.length === 0) return
        const first = replacement[0]
        const changed = replacement.length !== 1
          || first?.type !== 'link'
          || first.url !== node.url
        if (!changed) return

        const parentNode = parent as Parent
        parentNode.children.splice(index, 1, ...replacement)
        return [SKIP, index + replacement.length]
      })
    }

    visit(tree, 'text', (node, index, parent) => {
      // ── 守门 ────────────────────────────────────────────────────
      if (!parent || index === undefined) return
      // 已在 link 节点内的 text 不再展开（避免 [文本](url) 内的路径再被升级）
      if (parent.type === 'link') return

      const value = node.value
      if (typeof value !== 'string' || value.length === 0) return

      // ── 扫描所有匹配点 ───────────────────────────────────────────
      const matches: Array<{ start: number; end: number; raw: string; url: string }> = []
      let m: RegExpExecArray | null
      TABTIN_RESOURCE_GLOBAL.lastIndex = 0
      while ((m = TABTIN_RESOURCE_GLOBAL.exec(value)) !== null) {
        const candidate = m[0]
        const trailing = candidate.match(TABTIN_RESOURCE_TRAILING)?.[0] ?? ''
        const raw = trailing ? candidate.slice(0, candidate.length - trailing.length) : candidate
        if (!raw) continue
        matches.push({
          start: m.index,
          end: m.index + raw.length,
          raw,
          url: raw,
        })
      }
      // RegExp.exec 在 global 模式下需要重置 lastIndex 防止跨节点泄漏
      ABS_PATH_GLOBAL.lastIndex = 0
      while ((m = ABS_PATH_GLOBAL.exec(value)) !== null) {
        const raw = m[1]
        if (!raw) continue
        // 算出 raw 在 value 里的起止 — 因为我们用了 lookbehind/non-capturing
        // group，m.index 已经指向 raw 起点（lookbehind 不计入 match）
        const start = m.index
        const end = start + raw.length
        // 二重校验：起点必须紧贴 lookbehind 之后
        matches.push({ start, end, raw, url: buildUri(raw) })
      }
      if (matches.length === 0) return
      matches.sort((a, b) => a.start - b.start)

      // ── 切片重组 ────────────────────────────────────────────────
      // 把 text 节点拆成 [text, link, text, link, ..., text]
      const newNodes: PhrasingContent[] = []
      let cursor = 0
      for (const { start, end, raw, url } of matches) {
        if (start < cursor) continue
        if (start > cursor) {
          newNodes.push({ type: 'text', value: value.slice(cursor, start) } as Text)
        }
        const linkNode: Link = {
          type: 'link',
          url,
          title: null,
          children: [{ type: 'text', value: raw } as Text],
        }
        newNodes.push(linkNode)
        cursor = end
      }
      if (cursor < value.length) {
        newNodes.push({ type: 'text', value: value.slice(cursor) } as Text)
      }

      // 替换原 text 节点
      const parentNode = parent as Parent
      parentNode.children.splice(index, 1, ...newNodes)
      // 跳过新插入的链接子树（visit 不会再下到 link.children 里重复匹配）
      return [SKIP, index + newNodes.length]
    })
  }
}

export default remarkAutolinkResource
