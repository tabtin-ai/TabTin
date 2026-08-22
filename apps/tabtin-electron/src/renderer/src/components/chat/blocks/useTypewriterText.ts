/**
 * useTypewriterText — 流式文本平滑揭示（typewriter reveal）共享 hook。
 *
 * 背景：LLM delta 按 chunk 到达（runtime store rAF flush 一帧一批，一批可能
 * 十几个字符），直接渲染整块文本会「一坨字闪出」——有闪现感和卡顿感。
 * 本 hook 把新到的积压（backlog = 全量长度 - 已揭示长度）摊到后续帧逐字揭示：
 *
 *   - 每帧揭示 max(1, backlog × 0.12) 个字符——积压越多流得越快，自适应
 *     追赶：生成快时不会越落越远，生成慢时保持逐字打字机节奏。
 *   - 已揭示长度的权威副本放 ref（state 只是渲染镜像），effect 自带
 *     cleanup 取消 rAF，StrictMode（dev）双挂载安全。
 *   - 挂载瞬间对齐当前全量（切回历史 session / 中途挂载不重播老文本）。
 *   - 历史内容初次挂载（`active=false`）直接返回全量；亲历流式后 finalize
 *     时若还有未揭示尾部，则继续按帧排空，避免结束瞬间整段增高。
 *   - **用户中断（`freeze=true`）**：停在当前已揭示长度，不再 drain backlog，
 *     也不 snap 到全量——避免「已中断」徽标已出却仍继续打出几个字。
 *   - 揭示边界不劈开 UTF-16 代理对（emoji 等）——高位代理落在边界时多带
 *     一个 code unit，避免瞬时渲染替换符。
 *
 * 消费方：ThinkingBlockView（思考预览）、TextBlockView（答案正文）。
 */

import { useEffect, useRef, useState } from 'react'

export function useTypewriterText(
  fullText: string,
  active: boolean,
  freeze = false,
): string {
  const fullLenRef = useRef(fullText.length)
  fullLenRef.current = fullText.length
  const [revealedLen, setRevealedLen] = useState(fullText.length)
  const revealedLenRef = useRef(fullText.length)
  const hasAnimatedRef = useRef(active)
  // freeze 时锁定揭示上限，避免 fullText 仍增长时把冻结点往后推。
  const freezeCapRef = useRef<number | null>(null)
  if (freeze) {
    if (freezeCapRef.current === null) {
      freezeCapRef.current = revealedLenRef.current
    }
  } else {
    freezeCapRef.current = null
  }

  useEffect(() => {
    if (freeze) return undefined

    const fullLen = fullText.length
    if (active) hasAnimatedRef.current = true
    const shouldDrainFinalBacklog =
      !active
      && hasAnimatedRef.current
      && revealedLenRef.current < fullLen
    if ((!active && !shouldDrainFinalBacklog) || revealedLenRef.current > fullLen) {
      // 历史初挂 / 文本重置（回退）直接对齐全量，不重播旧文本。
      if (revealedLenRef.current !== fullLen) {
        revealedLenRef.current = fullLen
        setRevealedLen(fullLen)
      }
      return undefined
    }
    if (revealedLenRef.current === fullLen) return undefined
    let rafId: number
    const step = () => {
      const full = fullLenRef.current
      const backlog = full - revealedLenRef.current
      if (backlog <= 0) return
      const advance = Math.max(1, Math.round(backlog * 0.12))
      revealedLenRef.current = Math.min(full, revealedLenRef.current + advance)
      setRevealedLen(revealedLenRef.current)
      if (revealedLenRef.current < full) {
        rafId = requestAnimationFrame(step)
      }
    }
    rafId = requestAnimationFrame(step)
    return () => cancelAnimationFrame(rafId)
  }, [fullText, active, freeze])

  const freezeCap = freezeCapRef.current
  const endCap = freeze && freezeCap !== null
    ? Math.min(fullText.length, freezeCap)
    : fullText.length

  const shouldRenderRevealedText =
    active
    || freeze
    || (hasAnimatedRef.current && revealedLen < endCap)
  if (!shouldRenderRevealedText) return fullText
  let end = Math.min(revealedLen, endCap)
  if (end > 0 && end < fullText.length) {
    const code = fullText.charCodeAt(end - 1)
    // 高位代理（0xD800-0xDBFF）不能落在切割边界——多带一个 code unit 补全代理对
    if (code >= 0xd800 && code <= 0xdbff) end += 1
  }
  return fullText.slice(0, end)
}
