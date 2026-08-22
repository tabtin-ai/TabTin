/**
 * MOTION token 契约 — 与 docs/agent-runtime/agent-motion-design.html 字面对齐。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { MOTION } from '../chatDesignTokens'

const globalsCss = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/styles/globals.css'),
  'utf8',
)

describe('MOTION tokens（agent-motion-design）', () => {
  it('时长与缓动字面值对齐正典', () => {
    expect(MOTION.micro).toBe('120ms')
    expect(MOTION.state).toBe('240ms')
    expect(MOTION.enter).toBe('320ms')
    expect(MOTION.grow).toBe('400ms')
    expect(MOTION.easeOut).toBe('cubic-bezier(.215,.61,.355,1)')
  })

  it('持续 / 一次性动效字面值对齐正典', () => {
    expect(MOTION.shimmer).toBe('1.6s linear infinite')
    expect(MOTION.caret).toBe('1s steps(2, start) infinite')
    expect(MOTION.breathe).toBe('1.8s ease-in-out infinite')
    expect(MOTION.breatheStagger).toBe('200ms')
    expect(MOTION.pop).toBe('180ms cubic-bezier(0.23, 1, 0.32, 1)')
    expect(MOTION.countUp).toBe('300ms')
  })

  it('globals.css 的 CSS 变量与 MOTION 单一契约一致', () => {
    const variables: Record<keyof typeof MOTION, string> = {
      micro: '--chat-motion-micro',
      state: '--chat-motion-state',
      enter: '--chat-motion-enter',
      grow: '--chat-motion-grow',
      easeOut: '--chat-motion-ease-out',
      shimmer: '--chat-motion-shimmer',
      caret: '--chat-motion-caret',
      breathe: '--chat-motion-breathe',
      breatheStagger: '--chat-motion-breathe-stagger',
      pop: '--chat-motion-pop',
      countUp: '--chat-motion-count-up',
    }

    for (const [token, variable] of Object.entries(variables) as Array<
      [keyof typeof MOTION, string]
    >) {
      expect(globalsCss).toContain(`${variable}: ${MOTION[token]};`)
    }
  })
})
