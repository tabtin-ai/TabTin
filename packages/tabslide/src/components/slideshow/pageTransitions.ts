import type React from 'react'
import type { TurningMode } from '../../types/slides'
import { TRANSITION_DURATION } from './constants'

export const RANDOM_MODES: TurningMode[] = [
  'fade',
  'slideX',
  'slideY',
  'slideX3D',
  'slideY3D',
  'rotate',
  'scaleY',
  'scaleX',
  'scale',
  'scaleReverse',
]

const T_EASE = `${TRANSITION_DURATION}ms cubic-bezier(0.4, 0, 0.2, 1)`

export function getTransitionStyle(
  mode: TurningMode,
  direction: 'next' | 'prev',
  phase: 'enter' | 'leave',
): React.CSSProperties {
  const isEnter = phase === 'enter'
  const isNext = direction === 'next'
  const base: React.CSSProperties = {
    transition: `all ${T_EASE}`,
    position: 'absolute',
    ...(isEnter ? {} : { pointerEvents: 'none' as const }),
  }

  switch (mode) {
    case 'fade':
      return {
        ...base,
        opacity: isEnter ? 1 : 0,
        animation: `${isEnter ? 'tabslide-fadeIn' : 'tabslide-fadeOut'} ${T_EASE} forwards`,
      }

    case 'slideX': {
      const offset = isNext ? '100%' : '-100%'
      return {
        ...base,
        animation: isEnter
          ? `tabslide-slideIn ${T_EASE} forwards`
          : `tabslide-slideOut ${T_EASE} forwards`,
        ['--slide-from' as string]: isEnter ? offset : '0%',
        ['--slide-to' as string]: isEnter ? '0%' : isNext ? '-100%' : '100%',
      }
    }

    case 'slideY': {
      const offset = isNext ? '100%' : '-100%'
      return {
        ...base,
        animation: isEnter
          ? `tabslide-slideInY ${T_EASE} forwards`
          : `tabslide-slideOutY ${T_EASE} forwards`,
        ['--slide-from' as string]: isEnter ? offset : '0%',
        ['--slide-to' as string]: isEnter ? '0%' : isNext ? '-100%' : '100%',
      }
    }

    case 'slideX3D':
      return {
        ...base,
        animation: `${isEnter ? 'tabslide-flipInX' : 'tabslide-flipOutX'} ${T_EASE} forwards`,
        backfaceVisibility: 'hidden',
      }

    case 'slideY3D':
      return {
        ...base,
        animation: `${isEnter ? 'tabslide-flipInY' : 'tabslide-flipOutY'} ${T_EASE} forwards`,
        backfaceVisibility: 'hidden',
      }

    case 'rotate':
      return {
        ...base,
        animation: `${isEnter ? 'tabslide-rotateIn' : 'tabslide-rotateOut'} ${T_EASE} forwards`,
        transformOrigin: 'center center',
      }

    case 'scaleX':
      return {
        ...base,
        animation: `${isEnter ? 'tabslide-scaleXIn' : 'tabslide-scaleXOut'} ${T_EASE} forwards`,
        transformOrigin: isNext ? 'left center' : 'right center',
      }

    case 'scaleY':
      return {
        ...base,
        animation: `${isEnter ? 'tabslide-scaleYIn' : 'tabslide-scaleYOut'} ${T_EASE} forwards`,
        transformOrigin: isNext ? 'center top' : 'center bottom',
      }

    case 'scale':
      return {
        ...base,
        animation: `${isEnter ? 'tabslide-zoomIn' : 'tabslide-zoomOut'} ${T_EASE} forwards`,
      }

    case 'scaleReverse':
      return {
        ...base,
        animation: `${isEnter ? 'tabslide-shrinkIn' : 'tabslide-shrinkOut'} ${T_EASE} forwards`,
      }

    default:
      return base
  }
}

// 注入全局 keyframes（只注入一次）
if (typeof document !== 'undefined') {
  const STYLE_ID = 'tabslide-transition-keyframes'
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = `
      @keyframes tabslide-fadeIn { from { opacity: 0; } to { opacity: 1; } }
      @keyframes tabslide-fadeOut { from { opacity: 1; } to { opacity: 0; } }

      @keyframes tabslide-fadeMoveIn {
        from { opacity: 0; transform: translate(var(--ts-x, 0%), var(--ts-y, 0%)); }
        to { opacity: 1; transform: translate(0%, 0%); }
      }
      @keyframes tabslide-fadeMoveOut {
        from { opacity: 1; transform: translate(0%, 0%); }
        to { opacity: 0; transform: translate(var(--ts-x, 0%), var(--ts-y, 0%)); }
      }

      @keyframes tabslide-slideIn { from { transform: translateX(var(--slide-from, 100%)) scale(var(--s, 1)); } to { transform: translateX(var(--slide-to, 0%)) scale(var(--s, 1)); } }
      @keyframes tabslide-slideOut { from { transform: translateX(var(--slide-from, 0%)) scale(var(--s, 1)); } to { transform: translateX(var(--slide-to, -100%)) scale(var(--s, 1)); } }

      @keyframes tabslide-slideInY { from { transform: translateY(var(--slide-from, 100%)) scale(var(--s, 1)); } to { transform: translateY(var(--slide-to, 0%)) scale(var(--s, 1)); } }
      @keyframes tabslide-slideOutY { from { transform: translateY(var(--slide-from, 0%)) scale(var(--s, 1)); } to { transform: translateY(var(--slide-to, -100%)) scale(var(--s, 1)); } }

      @keyframes tabslide-slideMoveIn {
        from { opacity: 0; transform: translate(var(--ts-x, 0%), var(--ts-y, 0%)); }
        to { opacity: 1; transform: translate(0%, 0%); }
      }
      @keyframes tabslide-slideMoveOut {
        from { opacity: 1; transform: translate(0%, 0%); }
        to { opacity: 0; transform: translate(var(--ts-x, 0%), var(--ts-y, 0%)); }
      }

      @keyframes tabslide-flipInX { from { transform: rotateY(90deg); opacity: 0; } to { transform: rotateY(0deg); opacity: 1; } }
      @keyframes tabslide-flipOutX { from { transform: rotateY(0deg); opacity: 1; } to { transform: rotateY(-90deg); opacity: 0; } }

      @keyframes tabslide-flipInY { from { transform: rotateX(-90deg); opacity: 0; } to { transform: rotateX(0deg); opacity: 1; } }
      @keyframes tabslide-flipOutY { from { transform: rotateX(0deg); opacity: 1; } to { transform: rotateX(90deg); opacity: 0; } }

      @keyframes tabslide-rotateIn { from { transform: rotate(-180deg) scale(0.5); opacity: 0; } to { transform: rotate(0deg) scale(1); opacity: 1; } }
      @keyframes tabslide-rotateOut { from { transform: rotate(0deg) scale(1); opacity: 1; } to { transform: rotate(180deg) scale(0.5); opacity: 0; } }

      @keyframes tabslide-scaleXIn { from { transform: scaleX(0); } to { transform: scaleX(1); } }
      @keyframes tabslide-scaleXOut { from { transform: scaleX(1); } to { transform: scaleX(0); } }

      @keyframes tabslide-scaleYIn { from { transform: scaleY(0); } to { transform: scaleY(1); } }
      @keyframes tabslide-scaleYOut { from { transform: scaleY(1); } to { transform: scaleY(0); } }

      @keyframes tabslide-zoomIn { from { transform: scale(0.3); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      @keyframes tabslide-zoomOut { from { transform: scale(1); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }

      @keyframes tabslide-zoomMoveIn {
        from {
          opacity: 0;
          transform: translate(var(--ts-x, 0%), var(--ts-y, 0%)) scale(var(--ts-scale-from, 0.3));
        }
        to {
          opacity: 1;
          transform: translate(0%, 0%) scale(1);
        }
      }
      @keyframes tabslide-zoomMoveOut {
        from {
          opacity: 1;
          transform: translate(0%, 0%) scale(1);
        }
        to {
          opacity: 0;
          transform: translate(var(--ts-x, 0%), var(--ts-y, 0%)) scale(var(--ts-scale-to, 1.5));
        }
      }

      @keyframes tabslide-shrinkIn { from { transform: scale(1.5); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      @keyframes tabslide-shrinkOut { from { transform: scale(1); opacity: 1; } to { transform: scale(0.3); opacity: 0; } }

      @keyframes tabslide-lightSpeedIn {
        from {
          opacity: 0;
          transform: translateX(var(--ts-x, 100%)) skewX(var(--ts-skew-from, -24deg));
        }
        70% {
          opacity: 1;
          transform: translateX(0%) skewX(var(--ts-skew-mid, 10deg));
        }
        100% {
          opacity: 1;
          transform: translateX(0%) skewX(0deg);
        }
      }

      @keyframes tabslide-rotateMoveIn {
        from {
          opacity: 0;
          transform: rotate(var(--ts-rotate-from, -180deg)) scale(0.5);
        }
        to {
          opacity: 1;
          transform: rotate(var(--ts-rotate-to, 0deg)) scale(1);
        }
      }

      @keyframes tabslide-rotateMoveOut {
        from {
          opacity: 1;
          transform: rotate(var(--ts-rotate-from, 0deg)) scale(1);
        }
        to {
          opacity: 0;
          transform: rotate(var(--ts-rotate-to, 180deg)) scale(0.5);
        }
      }

      @keyframes tabslide-bounceIn {
        0% { opacity: 0; transform: scale(0.6); }
        55% { opacity: 1; transform: scale(1.08); }
        75% { transform: scale(0.96); }
        100% { transform: scale(1); }
      }

      @keyframes tabslide-bounceOut {
        0% { opacity: 1; transform: scale(1); }
        25% { transform: scale(1.06); }
        100% { opacity: 0; transform: scale(0.45); }
      }

      @keyframes tabslide-bounceMoveIn {
        0% {
          opacity: 0;
          transform: translate(var(--ts-x, 0%), var(--ts-y, 0%)) scale(0.6);
        }
        55% {
          opacity: 1;
          transform: translate(var(--ts-over-x, 0%), var(--ts-over-y, 0%)) scale(1.08);
        }
        75% {
          transform: translate(var(--ts-settle-x, 0%), var(--ts-settle-y, 0%)) scale(0.97);
        }
        100% {
          transform: translate(0%, 0%) scale(1);
        }
      }

      @keyframes tabslide-bounceMoveOut {
        0% {
          opacity: 1;
          transform: translate(0%, 0%) scale(1);
        }
        25% {
          transform: translate(var(--ts-over-x, 0%), var(--ts-over-y, 0%)) scale(1.05);
        }
        100% {
          opacity: 0;
          transform: translate(var(--ts-x, 0%), var(--ts-y, 0%)) scale(0.45);
        }
      }

      @keyframes tabslide-attentionPulse {
        0% { transform: scale(1); }
        30% { transform: scale(1.06); }
        60% { transform: scale(0.97); }
        100% { transform: scale(1); }
      }

      @keyframes tabslide-attentionBounce {
        0%, 20%, 53%, 80%, 100% { transform: translateY(0); }
        40%, 43% { transform: translateY(-14px); }
        70% { transform: translateY(-7px); }
        90% { transform: translateY(-3px); }
      }

      @keyframes tabslide-attentionShakeX {
        0%, 100% { transform: translateX(0); }
        20% { transform: translateX(-4px); }
        40% { transform: translateX(4px); }
        60% { transform: translateX(-3px); }
        80% { transform: translateX(3px); }
      }

      @keyframes tabslide-attentionShakeY {
        0%, 100% { transform: translateY(0); }
        20% { transform: translateY(-4px); }
        40% { transform: translateY(4px); }
        60% { transform: translateY(-3px); }
        80% { transform: translateY(3px); }
      }

      @keyframes tabslide-attentionWobble {
        0% { transform: translateX(0); }
        15% { transform: translateX(-7%) rotate(-4deg); }
        30% { transform: translateX(5%) rotate(3deg); }
        45% { transform: translateX(-4%) rotate(-2deg); }
        60% { transform: translateX(3%) rotate(1deg); }
        75% { transform: translateX(-1%) rotate(-0.5deg); }
        100% { transform: translateX(0); }
      }

      @keyframes tabslide-attentionSwing {
        20% { transform: rotate(15deg); }
        40% { transform: rotate(-10deg); }
        60% { transform: rotate(5deg); }
        80% { transform: rotate(-5deg); }
        100% { transform: rotate(0deg); }
      }

      @keyframes tabslide-attentionHeadShake {
        0% { transform: translateX(0); }
        12% { transform: translateX(-6px) rotateY(-7deg); }
        37% { transform: translateX(5px) rotateY(5deg); }
        62% { transform: translateX(-3px) rotateY(-3deg); }
        87% { transform: translateX(2px) rotateY(2deg); }
        100% { transform: translateX(0); }
      }

      @keyframes tabslide-attentionJello {
        0%, 100% { transform: skewX(0deg) skewY(0deg); }
        22% { transform: skewX(-12deg) skewY(-12deg); }
        33% { transform: skewX(6deg) skewY(6deg); }
        44% { transform: skewX(-3deg) skewY(-3deg); }
        55% { transform: skewX(1.5deg) skewY(1.5deg); }
      }

      @keyframes tabslide-attentionRubberBand {
        0% { transform: scale(1); }
        30% { transform: scaleX(1.2) scaleY(0.78); }
        40% { transform: scaleX(0.8) scaleY(1.2); }
        55% { transform: scaleX(1.05) scaleY(0.94); }
        65% { transform: scaleX(0.95) scaleY(1.05); }
        75% { transform: scaleX(1.02) scaleY(0.98); }
        100% { transform: scale(1); }
      }

      @keyframes tabslide-attentionTada {
        0% { transform: scale(1); }
        10%, 20% { transform: scale(0.95) rotate(-3deg); }
        30%, 50%, 70%, 90% { transform: scale(1.04) rotate(3deg); }
        40%, 60%, 80% { transform: scale(1.04) rotate(-3deg); }
        100% { transform: scale(1) rotate(0deg); }
      }

      @keyframes tabslide-attentionFlash {
        0%, 50%, 100% { opacity: 1; }
        25%, 75% { opacity: 0; }
      }

      @keyframes tabslide-attentionHeartBeat {
        0% { transform: scale(1); }
        14% { transform: scale(1.25); }
        28% { transform: scale(1); }
        42% { transform: scale(1.25); }
        70% { transform: scale(1); }
      }

      @keyframes tabslide-attentionFlip {
        0% { transform: perspective(500px) rotateY(0deg); }
        50% { transform: perspective(500px) rotateY(180deg); }
        100% { transform: perspective(500px) rotateY(360deg); }
      }

      @keyframes tabslide-hintFade {
        0% { opacity: 0; transform: translateX(-50%) translateY(8px); }
        8% { opacity: 1; transform: translateX(-50%) translateY(0); }
        75% { opacity: 1; }
        100% { opacity: 0; pointer-events: none; }
      }
    `
    document.head.appendChild(style)
  }
}
