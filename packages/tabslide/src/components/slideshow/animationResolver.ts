import type React from 'react'
import type { PPTAnimation } from '../../types/slides'

const WARNED_UNSUPPORTED_EFFECTS = new Set<string>()

export interface ResolvedElementAnimation {
  animationName: string
  timingFunction?: string
  transformOrigin?: string
  vars?: Record<string, string>
}

export function assignCssVars(
  style: React.CSSProperties,
  vars?: Record<string, string>,
): React.CSSProperties {
  if (!vars) return style
  const merged: React.CSSProperties = { ...style }
  for (const [key, value] of Object.entries(vars)) {
    ;(merged as Record<string, string | number>)[key] = value
  }
  return merged
}

// up/down 方向语义遵循 Animate.css / PPTX 标准：
// "up" 入场 = 元素从下方滑入（translateY 正值→0），即"向上飞入"描述运动方向而非起始位置；
// "down" 入场 = 元素从上方滑入（translateY 负值→0）。退出方向取反。
function resolveDirectionalOffset(
  effect: string,
  distance: string,
  type: 'in' | 'out',
): { x: string; y: string } {
  if (effect.includes('left')) return { x: `-${distance}`, y: '0%' }
  if (effect.includes('right')) return { x: distance, y: '0%' }
  if (effect.includes('up')) return { x: '0%', y: type === 'in' ? distance : `-${distance}` }
  if (effect.includes('down')) return { x: '0%', y: type === 'in' ? `-${distance}` : distance }
  return { x: '0%', y: '0%' }
}

function signFromPercent(value: string): -1 | 0 | 1 {
  if (value.startsWith('-')) return -1
  if (value === '0%' || value === '0px') return 0
  return 1
}

function resolveBounceVars(offset: { x: string; y: string }): Record<string, string> {
  const signX = signFromPercent(offset.x)
  const signY = signFromPercent(offset.y)
  const overX = signX === 0 ? '0%' : signX > 0 ? '-8%' : '8%'
  const overY = signY === 0 ? '0%' : signY > 0 ? '-8%' : '8%'
  const settleX = signX === 0 ? '0%' : signX > 0 ? '3%' : '-3%'
  const settleY = signY === 0 ? '0%' : signY > 0 ? '3%' : '-3%'
  return {
    '--ts-x': offset.x,
    '--ts-y': offset.y,
    '--ts-over-x': overX,
    '--ts-over-y': overY,
    '--ts-settle-x': settleX,
    '--ts-settle-y': settleY,
  }
}

function resolveAttentionAnimation(effect: string): ResolvedElementAnimation {
  switch (effect) {
    case 'pulse':
      return { animationName: 'tabslide-attentionPulse' }
    case 'bounce':
      return { animationName: 'tabslide-attentionBounce' }
    case 'shakex':
      return { animationName: 'tabslide-attentionShakeX' }
    case 'shakey':
      return { animationName: 'tabslide-attentionShakeY' }
    case 'wobble':
      return { animationName: 'tabslide-attentionWobble' }
    case 'swing':
      return { animationName: 'tabslide-attentionSwing', transformOrigin: 'top center' }
    case 'headshake':
      return { animationName: 'tabslide-attentionHeadShake' }
    case 'jello':
      return { animationName: 'tabslide-attentionJello' }
    case 'rubberband':
      return { animationName: 'tabslide-attentionRubberBand' }
    case 'tada':
      return { animationName: 'tabslide-attentionTada' }
    case 'flash':
      return { animationName: 'tabslide-attentionFlash' }
    case 'heartbeat':
      return { animationName: 'tabslide-attentionHeartBeat' }
    case 'flip':
      return { animationName: 'tabslide-attentionFlip' }
    default:
      return { animationName: 'tabslide-attentionPulse' }
  }
}

const KNOWN_ATTENTION_EFFECTS = new Set([
  'pulse',
  'bounce',
  'shakex',
  'shakey',
  'wobble',
  'swing',
  'headshake',
  'jello',
  'rubberband',
  'tada',
  'flash',
  'heartbeat',
  'flip',
])

function warnUnsupportedAnimationEffect(animation: PPTAnimation): void {
  const rawEffect = typeof animation.effect === 'string' ? animation.effect.trim() : ''
  if (!rawEffect) return

  const warnKey = `${animation.type}:${rawEffect.toLowerCase()}`
  if (WARNED_UNSUPPORTED_EFFECTS.has(warnKey)) return
  WARNED_UNSUPPORTED_EFFECTS.add(warnKey)

  const fallbackEffect =
    animation.type === 'out'
      ? 'fadeOut'
      : animation.type === 'attention'
        ? 'pulse'
        : 'fadeIn'

  console.warn(
    `[slideshow] 未支持动画 effect "${rawEffect}" (type=${animation.type})，已回退为 ${fallbackEffect}`,
  )
}

function resolveRotateInAnimation(effect: string): ResolvedElementAnimation {
  if (effect === 'rotateindownleft') {
    return {
      animationName: 'tabslide-rotateMoveIn',
      transformOrigin: 'left bottom',
      vars: { '--ts-rotate-from': '-90deg', '--ts-rotate-to': '0deg' },
    }
  }
  if (effect === 'rotateindownright') {
    return {
      animationName: 'tabslide-rotateMoveIn',
      transformOrigin: 'right bottom',
      vars: { '--ts-rotate-from': '90deg', '--ts-rotate-to': '0deg' },
    }
  }
  if (effect === 'rotateinupleft') {
    return {
      animationName: 'tabslide-rotateMoveIn',
      transformOrigin: 'left top',
      vars: { '--ts-rotate-from': '90deg', '--ts-rotate-to': '0deg' },
    }
  }
  if (effect === 'rotateinupright') {
    return {
      animationName: 'tabslide-rotateMoveIn',
      transformOrigin: 'right top',
      vars: { '--ts-rotate-from': '-90deg', '--ts-rotate-to': '0deg' },
    }
  }
  return {
    animationName: 'tabslide-rotateMoveIn',
    transformOrigin: 'center center',
    vars: { '--ts-rotate-from': '-180deg', '--ts-rotate-to': '0deg' },
  }
}

export function resolveElementAnimation(
  animation: PPTAnimation,
): ResolvedElementAnimation {
  if (!animation.effect) {
    return {
      animationName: animation.type === 'out' ? 'tabslide-fadeMoveOut' : 'tabslide-fadeMoveIn',
      vars: { '--ts-x': '0%', '--ts-y': '0%' },
    }
  }
  const effect = animation.effect.toLowerCase()
  const type = animation.type

  if (type === 'attention') {
    if (!KNOWN_ATTENTION_EFFECTS.has(effect)) {
      warnUnsupportedAnimationEffect(animation)
    }
    return resolveAttentionAnimation(effect)
  }

  if (effect.startsWith('fade')) {
    const offset = resolveDirectionalOffset(effect, '24%', type)
    return {
      animationName: type === 'out' ? 'tabslide-fadeMoveOut' : 'tabslide-fadeMoveIn',
      vars: { '--ts-x': offset.x, '--ts-y': offset.y },
    }
  }

  if (effect.startsWith('slide')) {
    const offset = resolveDirectionalOffset(effect, '100%', type)
    return {
      animationName: type === 'out' ? 'tabslide-slideMoveOut' : 'tabslide-slideMoveIn',
      vars: { '--ts-x': offset.x, '--ts-y': offset.y },
      timingFunction: 'cubic-bezier(0.215, 0.61, 0.355, 1)',
    }
  }

  if (effect.startsWith('zoom') || effect.startsWith('scale') || effect.startsWith('shrink')) {
    const offset = resolveDirectionalOffset(effect, '30%', type)
    return {
      animationName: type === 'out' ? 'tabslide-zoomMoveOut' : 'tabslide-zoomMoveIn',
      vars: {
        '--ts-x': offset.x,
        '--ts-y': offset.y,
        '--ts-scale-from': effect.startsWith('shrink') ? '1.3' : '0.3',
        '--ts-scale-to': effect.startsWith('shrink') ? '0.3' : '1.5',
      },
    }
  }

  if (effect.startsWith('backin')) {
    const offset = resolveDirectionalOffset(effect, '36%', 'in')
    return {
      animationName: 'tabslide-zoomMoveIn',
      vars: {
        '--ts-x': offset.x,
        '--ts-y': offset.y,
        '--ts-scale-from': '0.72',
      },
      timingFunction: 'cubic-bezier(0.2, 0.7, 0.3, 1)',
    }
  }

  if (effect.startsWith('lightspeedin')) {
    const fromRight = effect.endsWith('right')
    return {
      animationName: 'tabslide-lightSpeedIn',
      vars: {
        '--ts-x': fromRight ? '100%' : '-100%',
        '--ts-skew-from': fromRight ? '-24deg' : '24deg',
        '--ts-skew-mid': fromRight ? '10deg' : '-10deg',
      },
      timingFunction: 'cubic-bezier(0.215, 0.61, 0.355, 1)',
    }
  }

  if (effect.startsWith('bounce')) {
    const offset = resolveDirectionalOffset(effect, '120%', type)
    return {
      animationName: type === 'out' ? 'tabslide-bounceMoveOut' : 'tabslide-bounceMoveIn',
      vars: resolveBounceVars(offset),
      timingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    }
  }

  if (effect.startsWith('rotate')) {
    return type === 'out'
      ? {
          animationName: 'tabslide-rotateMoveOut',
          transformOrigin: 'center center',
          vars: { '--ts-rotate-from': '0deg', '--ts-rotate-to': '180deg' },
        }
      : resolveRotateInAnimation(effect)
  }

  if (effect.includes('flip')) {
    if (effect.includes('y')) {
      return { animationName: type === 'out' ? 'tabslide-flipOutY' : 'tabslide-flipInY' }
    }
    return { animationName: type === 'out' ? 'tabslide-flipOutX' : 'tabslide-flipInX' }
  }

  warnUnsupportedAnimationEffect(animation)
  return {
    animationName: type === 'out' ? 'tabslide-fadeMoveOut' : 'tabslide-fadeMoveIn',
    vars: { '--ts-x': '0%', '--ts-y': '0%' },
  }
}

export function pickPrimaryAnimation(animations?: PPTAnimation[]): PPTAnimation | null {
  if (!animations || animations.length === 0) return null
  const primaryCandidates = animations.filter((anim) => anim.type === 'out' || anim.type === 'in')
  if (primaryCandidates.length === 0) return null
  const sorted = [...primaryCandidates].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'out' ? -1 : 1
    }
    return b.duration - a.duration
  })
  return sorted[0] ?? null
}

export function pickAttentionAnimation(animations?: PPTAnimation[]): PPTAnimation | null {
  if (!animations || animations.length === 0) return null
  const attentionCandidates = animations.filter((anim) => anim.type === 'attention')
  if (attentionCandidates.length === 0) return null
  const sorted = [...attentionCandidates].sort((a, b) => b.duration - a.duration)
  return sorted[0] ?? null
}
