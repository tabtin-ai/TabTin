/**
 * 动画配置
 *
 * 参考 PPTist（src/configs/animation.ts），提供完整的动画效果库。
 *
 * PPTist 使用 animate.css 作为动画实现基础。
 * 我们可以用 CSS animations + Framer Motion 实现相同效果。
 *
 * 每个动画效果定义为一个名称 + CSS class/keyframes 映射。
 * 实际渲染时，组件根据 effect 名称应用对应的动画。
 */

import type { AnimationType } from '../types/slides'

export interface AnimationEffect {
  /** 动画效果名称（作为唯一标识） */
  name: string
  /** 显示名称（中文） */
  label: string
  /** 对应的 CSS animation-name（animate.css 风格） */
  animationName: string
}

export interface AnimationGroup {
  /** 稳定的分组标识，用于 i18n 翻译键（如 'fade'/'zoom'/'bounce'） */
  groupKey: string
  /** 分组名称（中文，降级显示用） */
  groupName: string
  /** 分组内的动画效果 */
  effects: AnimationEffect[]
}

// ══════════════════════════════════════════════════════════════
// 入场动画
// ══════════════════════════════════════════════════════════════

export const ENTER_ANIMATIONS: AnimationGroup[] = [
  {
    groupKey: 'fade',
    groupName: '淡入',
    effects: [
      { name: 'fadeIn', label: '淡入', animationName: 'fadeIn' },
      { name: 'fadeInDown', label: '向下淡入', animationName: 'fadeInDown' },
      { name: 'fadeInUp', label: '向上淡入', animationName: 'fadeInUp' },
      { name: 'fadeInLeft', label: '向右淡入', animationName: 'fadeInLeft' },
      { name: 'fadeInRight', label: '向左淡入', animationName: 'fadeInRight' },
    ],
  },
  {
    groupKey: 'zoom',
    groupName: '缩放',
    effects: [
      { name: 'zoomIn', label: '放大', animationName: 'zoomIn' },
      { name: 'zoomInDown', label: '向下放大', animationName: 'zoomInDown' },
      { name: 'zoomInUp', label: '向上放大', animationName: 'zoomInUp' },
      { name: 'zoomInLeft', label: '从左放大', animationName: 'zoomInLeft' },
      { name: 'zoomInRight', label: '从右放大', animationName: 'zoomInRight' },
    ],
  },
  {
    groupKey: 'bounce',
    groupName: '弹跳',
    effects: [
      { name: 'bounceIn', label: '弹入', animationName: 'bounceIn' },
      { name: 'bounceInDown', label: '向下弹入', animationName: 'bounceInDown' },
      { name: 'bounceInUp', label: '向上弹入', animationName: 'bounceInUp' },
      { name: 'bounceInLeft', label: '从左弹入', animationName: 'bounceInLeft' },
      { name: 'bounceInRight', label: '从右弹入', animationName: 'bounceInRight' },
    ],
  },
  {
    groupKey: 'slide',
    groupName: '滑入',
    effects: [
      { name: 'slideInDown', label: '向下滑入', animationName: 'slideInDown' },
      { name: 'slideInUp', label: '向上滑入', animationName: 'slideInUp' },
      { name: 'slideInLeft', label: '从左滑入', animationName: 'slideInLeft' },
      { name: 'slideInRight', label: '从右滑入', animationName: 'slideInRight' },
    ],
  },
  {
    groupKey: 'rotate',
    groupName: '旋转',
    effects: [
      { name: 'rotateIn', label: '旋转进入', animationName: 'rotateIn' },
      { name: 'rotateInDownLeft', label: '左下旋入', animationName: 'rotateInDownLeft' },
      { name: 'rotateInDownRight', label: '右下旋入', animationName: 'rotateInDownRight' },
      { name: 'rotateInUpLeft', label: '左上旋入', animationName: 'rotateInUpLeft' },
      { name: 'rotateInUpRight', label: '右上旋入', animationName: 'rotateInUpRight' },
    ],
  },
  {
    groupKey: 'flip',
    groupName: '翻转',
    effects: [
      { name: 'flipInX', label: '水平翻入', animationName: 'flipInX' },
      { name: 'flipInY', label: '垂直翻入', animationName: 'flipInY' },
    ],
  },
  {
    groupKey: 'other',
    groupName: '其他',
    effects: [
      { name: 'backInDown', label: '后方向下进入', animationName: 'backInDown' },
      { name: 'backInUp', label: '后方向上进入', animationName: 'backInUp' },
      { name: 'backInLeft', label: '后方从左进入', animationName: 'backInLeft' },
      { name: 'backInRight', label: '后方从右进入', animationName: 'backInRight' },
      { name: 'lightSpeedInRight', label: '光速从右进入', animationName: 'lightSpeedInRight' },
      { name: 'lightSpeedInLeft', label: '光速从左进入', animationName: 'lightSpeedInLeft' },
    ],
  },
]

// ══════════════════════════════════════════════════════════════
// 退场动画
// ══════════════════════════════════════════════════════════════

export const EXIT_ANIMATIONS: AnimationGroup[] = [
  {
    groupKey: 'fade',
    groupName: '淡出',
    effects: [
      { name: 'fadeOut', label: '淡出', animationName: 'fadeOut' },
      { name: 'fadeOutDown', label: '向下淡出', animationName: 'fadeOutDown' },
      { name: 'fadeOutUp', label: '向上淡出', animationName: 'fadeOutUp' },
      { name: 'fadeOutLeft', label: '向左淡出', animationName: 'fadeOutLeft' },
      { name: 'fadeOutRight', label: '向右淡出', animationName: 'fadeOutRight' },
    ],
  },
  {
    groupKey: 'zoom',
    groupName: '缩放',
    effects: [
      { name: 'zoomOut', label: '缩小', animationName: 'zoomOut' },
      { name: 'zoomOutDown', label: '向下缩小', animationName: 'zoomOutDown' },
      { name: 'zoomOutUp', label: '向上缩小', animationName: 'zoomOutUp' },
      { name: 'zoomOutLeft', label: '向左缩小', animationName: 'zoomOutLeft' },
      { name: 'zoomOutRight', label: '向右缩小', animationName: 'zoomOutRight' },
    ],
  },
  {
    groupKey: 'bounce',
    groupName: '弹出',
    effects: [
      { name: 'bounceOut', label: '弹出', animationName: 'bounceOut' },
      { name: 'bounceOutDown', label: '向下弹出', animationName: 'bounceOutDown' },
      { name: 'bounceOutUp', label: '向上弹出', animationName: 'bounceOutUp' },
      { name: 'bounceOutLeft', label: '向左弹出', animationName: 'bounceOutLeft' },
      { name: 'bounceOutRight', label: '向右弹出', animationName: 'bounceOutRight' },
    ],
  },
  {
    groupKey: 'slide',
    groupName: '滑出',
    effects: [
      { name: 'slideOutDown', label: '向下滑出', animationName: 'slideOutDown' },
      { name: 'slideOutUp', label: '向上滑出', animationName: 'slideOutUp' },
      { name: 'slideOutLeft', label: '向左滑出', animationName: 'slideOutLeft' },
      { name: 'slideOutRight', label: '向右滑出', animationName: 'slideOutRight' },
    ],
  },
]

// ══════════════════════════════════════════════════════════════
// 强调动画
// ══════════════════════════════════════════════════════════════

export const ATTENTION_ANIMATIONS: AnimationGroup[] = [
  {
    groupKey: 'shake',
    groupName: '震动',
    effects: [
      { name: 'bounce', label: '弹跳', animationName: 'bounce' },
      { name: 'shakeX', label: '左右震动', animationName: 'shakeX' },
      { name: 'shakeY', label: '上下震动', animationName: 'shakeY' },
      { name: 'wobble', label: '摇摆', animationName: 'wobble' },
      { name: 'swing', label: '摆动', animationName: 'swing' },
      { name: 'headShake', label: '摇头', animationName: 'headShake' },
      { name: 'jello', label: '果冻', animationName: 'jello' },
      { name: 'rubberBand', label: '橡皮筋', animationName: 'rubberBand' },
      { name: 'tada', label: 'Tada', animationName: 'tada' },
    ],
  },
  {
    groupKey: 'other',
    groupName: '其他',
    effects: [
      { name: 'flash', label: '闪烁', animationName: 'flash' },
      { name: 'pulse', label: '脉冲', animationName: 'pulse' },
      { name: 'heartBeat', label: '心跳', animationName: 'heartBeat' },
      { name: 'flip', label: '翻转', animationName: 'flip' },
    ],
  },
]

// ══════════════════════════════════════════════════════════════
// 翻页动画
// ══════════════════════════════════════════════════════════════

export interface TurningAnimation {
  name: string
  label: string
}

export const TURNING_ANIMATIONS: TurningAnimation[] = [
  { name: 'no', label: '无' },
  { name: 'fade', label: '淡入淡出' },
  { name: 'slideX', label: '左右推移' },
  { name: 'slideY', label: '上下推移' },
  { name: 'slideX3D', label: '左右推移 (3D)' },
  { name: 'slideY3D', label: '上下推移 (3D)' },
  { name: 'rotate', label: '旋转' },
  { name: 'scaleY', label: '纵向展开' },
  { name: 'scaleX', label: '横向展开' },
  { name: 'scale', label: '放大' },
  { name: 'scaleReverse', label: '缩小' },
  { name: 'random', label: '随机' },
]

// ══════════════════════════════════════════════════════════════
// 工具函数
// ══════════════════════════════════════════════════════════════

/** 根据动画类型获取动画列表 */
export function getAnimationsByType(type: AnimationType): AnimationGroup[] {
  switch (type) {
    case 'in':
      return ENTER_ANIMATIONS
    case 'out':
      return EXIT_ANIMATIONS
    case 'attention':
      return ATTENTION_ANIMATIONS
  }
}

/** 查找动画效果定义 */
export function findAnimationEffect(name: string): AnimationEffect | undefined {
  const allGroups = [...ENTER_ANIMATIONS, ...EXIT_ANIMATIONS, ...ATTENTION_ANIMATIONS]
  for (const group of allGroups) {
    const found = group.effects.find((e) => e.name === name)
    if (found) return found
  }
  return undefined
}

/** 获取所有动画效果的平铺列表 */
export function getAllAnimationEffects(): AnimationEffect[] {
  const allGroups = [...ENTER_ANIMATIONS, ...EXIT_ANIMATIONS, ...ATTENTION_ANIMATIONS]
  return allGroups.flatMap((g) => g.effects)
}
