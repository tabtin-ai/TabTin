/**
 * 形状配置系统
 *
 * 设计来自 PPTist（src/configs/shapes.ts），核心创新是 pathFormula：
 *
 * 传统方式：形状有固定的 SVG path，缩放时用 viewBox 拉伸。
 *   问题：圆角矩形缩放后圆角会变形（圆角跟着拉伸了）
 *
 * pathFormula 方式：形状有一个计算函数，根据当前 width/height 重新生成 path。
 *   优点：圆角矩形缩放后，圆角保持固定像素大小
 *
 * keypoints：某些形状有用户可拖拽的控制点。
 *   例如圆角矩形的圆角半径，箭头的箭头宽度。
 *   keypoints 数组的值（0-1 百分比）传给 pathFormula 计算。
 */

// ── 路径计算公式 ──────────────────────────────────────────────

export interface ShapePathFormula {
  /** 是否有可编辑的控制点 */
  editable: boolean
  /** 控制点默认值（百分比数组，0-1） */
  defaultValue: number[]
  /** 控制点取值范围 [[min, max], ...] */
  range: [number, number][]
  /**
   * 控制点的参考方向
   *
   * 'left' | 'right' | 'top' | 'bottom' | 'topLeft' | 'topRight' | 'bottomRight' | 'bottomLeft'
   * 决定拖拽控制点时的移动方向
   */
  relative: string[]
  /**
   * 路径计算函数
   *
   * @param width  - 形状当前宽度 (px)
   * @param height - 形状当前高度 (px)
   * @param values - 控制点当前值（百分比），由 keypoints 传入
   * @returns SVG path 的 d 属性字符串
   */
  formula: (width: number, height: number, values?: number[]) => string
}

export type RoundRectCornerRatios = [number, number, number, number]

const ROUND_RECT_DEFAULT_RATIO = 0.1

const clampRoundRectRatio = (value: unknown, fallback: number): number => {
  const next = Number(value)
  if (!Number.isFinite(next)) return fallback
  return Math.max(0, Math.min(0.5, next))
}

/**
 * 规范化 roundRect 的圆角关键点（左上/右上/右下/左下）。
 * 兼容历史数据：
 * - [r] => 四角相同
 * - [a,b] => [a,b,a,b]
 * - [a,b,c] => [a,b,c,b]
 */
export function normalizeRoundRectKeypoints(
  values?: number[],
  fallback = ROUND_RECT_DEFAULT_RATIO,
): RoundRectCornerRatios {
  const safeFallback = Math.max(0, Math.min(0.5, Number.isFinite(fallback) ? fallback : ROUND_RECT_DEFAULT_RATIO))
  if (!Array.isArray(values) || values.length === 0) {
    return [safeFallback, safeFallback, safeFallback, safeFallback]
  }

  const first = clampRoundRectRatio(values[0], safeFallback)
  if (values.length === 1) {
    return [first, first, first, first]
  }

  const second = clampRoundRectRatio(values[1], first)
  if (values.length === 2) {
    return [first, second, first, second]
  }

  const third = clampRoundRectRatio(values[2], first)
  if (values.length === 3) {
    return [first, second, third, second]
  }

  const fourth = clampRoundRectRatio(values[3], first)
  return [first, second, third, fourth]
}

export function isUniformRoundRectKeypoints(values?: number[], tolerance = 1e-4): boolean {
  const [tl, tr, br, bl] = normalizeRoundRectKeypoints(values)
  return Math.abs(tl - tr) <= tolerance
    && Math.abs(tl - br) <= tolerance
    && Math.abs(tl - bl) <= tolerance
}

/**
 * 所有形状路径公式注册表
 *
 * key 对应 PPTShapeElement.pathFormula 字段
 */
export const ShapePathFormulas: Record<string, ShapePathFormula> = {
  /**
   * 矩形
   */
  rect: {
    editable: false,
    defaultValue: [],
    range: [],
    relative: [],
    formula: (w: number, h: number) => {
      return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`
    },
  },

  /**
   * 椭圆
   *
   * 使用四段三次贝塞尔曲线近似，精度极高（kappa ≈ 0.5522847498）
   */
  ellipse: {
    editable: false,
    defaultValue: [],
    range: [],
    relative: [],
    formula: (w: number, h: number) => {
      const rx = w / 2
      const ry = h / 2
      const cx = rx
      const cy = ry
      const k = 0.5522847498
      const kx = rx * k
      const ky = ry * k
      return [
        `M ${cx} 0`,
        `C ${cx + kx} 0 ${w} ${cy - ky} ${w} ${cy}`,
        `C ${w} ${cy + ky} ${cx + kx} ${h} ${cx} ${h}`,
        `C ${cx - kx} ${h} 0 ${cy + ky} 0 ${cy}`,
        `C 0 ${cy - ky} ${cx - kx} 0 ${cx} 0`,
        `Z`,
      ].join(' ')
    },
  },

  /**
   * 圆角矩形
   *
   * 控制点：四个角半径（左上/右上/右下/左下，相对于短边的比例）
   * 默认 0.1 = 四角均为短边 10%
   */
  roundRect: {
    editable: true,
    defaultValue: [0.1, 0.1, 0.1, 0.1],
    range: [[0, 0.5], [0, 0.5], [0, 0.5], [0, 0.5]],
    relative: ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'],
    formula: (w: number, h: number, v?: number[]) => {
      const [tl, tr, br, bl] = normalizeRoundRectKeypoints(v)
      const shortSide = Math.min(w, h)
      const rtl = shortSide * tl
      const rtr = shortSide * tr
      const rbr = shortSide * br
      const rbl = shortSide * bl
      return [
        `M ${rtl} 0`,
        `L ${w - rtr} 0`,
        `Q ${w} 0 ${w} ${rtr}`,
        `L ${w} ${h - rbr}`,
        `Q ${w} ${h} ${w - rbr} ${h}`,
        `L ${rbl} ${h}`,
        `Q 0 ${h} 0 ${h - rbl}`,
        `L 0 ${rtl}`,
        `Q 0 0 ${rtl} 0`,
        'Z',
      ].join(' ')
    },
  },

  /**
   * 单圆角矩形（左上角）
   */
  roundRectSingle: {
    editable: true,
    defaultValue: [0.2],
    range: [[0, 0.5]],
    relative: ['left'],
    formula: (w: number, h: number, v?: number[]) => {
      const r = Math.min(w, h) * (v?.[0] ?? 0.2)
      return `M ${r} 0 L ${w} 0 L ${w} ${h} L 0 ${h} L 0 ${r} Q 0 0 ${r} 0 Z`
    },
  },

  /**
   * 剪切矩形（左上右下倒角）
   */
  cutRect: {
    editable: true,
    defaultValue: [0.1],
    range: [[0, 0.5]],
    relative: ['left'],
    formula: (w: number, h: number, v?: number[]) => {
      const c = Math.min(w, h) * (v?.[0] ?? 0.1)
      return `M ${c} 0 L ${w} 0 L ${w} ${h - c} L ${w - c} ${h} L 0 ${h} L 0 ${c} Z`
    },
  },

  /**
   * 等腰三角形
   */
  triangle: {
    editable: true,
    defaultValue: [0.5],
    range: [[0, 1]],
    relative: ['left'],
    formula: (w: number, h: number, v?: number[]) => {
      const topX = w * (v?.[0] ?? 0.5)
      return `M ${topX} 0 L ${w} ${h} L 0 ${h} Z`
    },
  },

  /**
   * 平行四边形
   */
  parallelogram: {
    editable: true,
    defaultValue: [0.25],
    range: [[0, 0.5]],
    relative: ['left'],
    formula: (w: number, h: number, v?: number[]) => {
      const offset = w * (v?.[0] ?? 0.25)
      return `M ${offset} 0 L ${w} 0 L ${w - offset} ${h} L 0 ${h} Z`
    },
  },

  /**
   * 梯形
   */
  trapezoid: {
    editable: true,
    defaultValue: [0.2],
    range: [[0, 0.5]],
    relative: ['left'],
    formula: (w: number, h: number, v?: number[]) => {
      const offset = w * (v?.[0] ?? 0.2)
      return `M ${offset} 0 L ${w - offset} 0 L ${w} ${h} L 0 ${h} Z`
    },
  },

  /**
   * 菱形
   */
  diamond: {
    editable: false,
    defaultValue: [],
    range: [],
    relative: [],
    formula: (w: number, h: number) => {
      return `M ${w / 2} 0 L ${w} ${h / 2} L ${w / 2} ${h} L 0 ${h / 2} Z`
    },
  },

  /**
   * 五边形
   */
  pentagon: {
    editable: false,
    defaultValue: [],
    range: [],
    relative: [],
    formula: (w: number, h: number) => {
      const cx = w / 2
      const cy = h / 2
      const rx = w / 2
      const ry = h / 2
      const points = Array.from({ length: 5 }, (_, i) => {
        const angle = ((i * 72 - 90) * Math.PI) / 180
        return [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]
      })
      return `M ${points.map((p) => `${p[0]} ${p[1]}`).join(' L ')} Z`
    },
  },

  /**
   * 六边形
   */
  hexagon: {
    editable: false,
    defaultValue: [],
    range: [],
    relative: [],
    formula: (w: number, h: number) => {
      const cx = w / 2
      const cy = h / 2
      const rx = w / 2
      const ry = h / 2
      const points = Array.from({ length: 6 }, (_, i) => {
        const angle = ((i * 60 - 90) * Math.PI) / 180
        return [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]
      })
      return `M ${points.map((p) => `${p[0]} ${p[1]}`).join(' L ')} Z`
    },
  },

  /**
   * 八边形
   */
  octagon: {
    editable: false,
    defaultValue: [],
    range: [],
    relative: [],
    formula: (w: number, h: number) => {
      const cut = Math.min(w, h) * 0.3
      return [
        `M ${cut} 0`,
        `L ${w - cut} 0`,
        `L ${w} ${cut}`,
        `L ${w} ${h - cut}`,
        `L ${w - cut} ${h}`,
        `L ${cut} ${h}`,
        `L 0 ${h - cut}`,
        `L 0 ${cut}`,
        `Z`,
      ].join(' ')
    },
  },

  /**
   * 右箭头
   */
  rightArrow: {
    editable: true,
    defaultValue: [0.5, 0.3],
    range: [
      [0, 1],
      [0, 0.5],
    ],
    relative: ['left', 'top'],
    formula: (w: number, h: number, v?: number[]) => {
      const bodyWidth = w * (v?.[0] ?? 0.5)
      const arrowInset = h * (v?.[1] ?? 0.3)
      return `M 0 ${arrowInset} L ${bodyWidth} ${arrowInset} L ${bodyWidth} 0 L ${w} ${h / 2} L ${bodyWidth} ${h} L ${bodyWidth} ${h - arrowInset} L 0 ${h - arrowInset} Z`
    },
  },

  /**
   * 左箭头
   */
  leftArrow: {
    editable: true,
    defaultValue: [0.5, 0.3],
    range: [
      [0, 1],
      [0, 0.5],
    ],
    relative: ['right', 'top'],
    formula: (w: number, h: number, v?: number[]) => {
      const bodyStart = w * (1 - (v?.[0] ?? 0.5))
      const arrowInset = h * (v?.[1] ?? 0.3)
      return `M ${w} ${arrowInset} L ${bodyStart} ${arrowInset} L ${bodyStart} 0 L 0 ${h / 2} L ${bodyStart} ${h} L ${bodyStart} ${h - arrowInset} L ${w} ${h - arrowInset} Z`
    },
  },

  /**
   * 星形（五角星）
   */
  star5: {
    editable: true,
    defaultValue: [0.4],
    range: [[0.1, 0.9]],
    relative: ['top'],
    formula: (w: number, h: number, v?: number[]) => {
      const cx = w / 2
      const cy = h / 2
      const outerRx = w / 2
      const outerRy = h / 2
      const ratio = v?.[0] ?? 0.4
      const innerRx = outerRx * ratio
      const innerRy = outerRy * ratio
      const points: string[] = []
      for (let i = 0; i < 5; i++) {
        const outerAngle = ((i * 72 - 90) * Math.PI) / 180
        points.push(`${cx + outerRx * Math.cos(outerAngle)} ${cy + outerRy * Math.sin(outerAngle)}`)
        const innerAngle = (((i * 72 + 36) - 90) * Math.PI) / 180
        points.push(`${cx + innerRx * Math.cos(innerAngle)} ${cy + innerRy * Math.sin(innerAngle)}`)
      }
      return `M ${points.join(' L ')} Z`
    },
  },

  /**
   * 六角星
   */
  star6: {
    editable: true,
    defaultValue: [0.4],
    range: [[0.1, 0.9]],
    relative: ['top'],
    formula: (w: number, h: number, v?: number[]) => {
      const cx = w / 2
      const cy = h / 2
      const outerRx = w / 2
      const outerRy = h / 2
      const ratio = v?.[0] ?? 0.4
      const innerRx = outerRx * ratio
      const innerRy = outerRy * ratio
      const points: string[] = []
      for (let i = 0; i < 6; i++) {
        const outerAngle = ((i * 60 - 90) * Math.PI) / 180
        points.push(`${cx + outerRx * Math.cos(outerAngle)} ${cy + outerRy * Math.sin(outerAngle)}`)
        const innerAngle = (((i * 60 + 30) - 90) * Math.PI) / 180
        points.push(`${cx + innerRx * Math.cos(innerAngle)} ${cy + innerRy * Math.sin(innerAngle)}`)
      }
      return `M ${points.join(' L ')} Z`
    },
  },

  /**
   * 十字形（plus / cross 统一为同一个公式）
   */
  cross: {
    editable: true,
    defaultValue: [0.3],
    range: [[0.1, 0.5]],
    relative: ['left'],
    formula: (w: number, h: number, v?: number[]) => {
      const ratio = v?.[0] ?? 0.3
      const armX = w * ratio
      const armY = h * ratio
      const cx = w / 2
      const cy = h / 2
      return [
        `M ${cx - armX} 0`,
        `L ${cx + armX} 0`,
        `L ${cx + armX} ${cy - armY}`,
        `L ${w} ${cy - armY}`,
        `L ${w} ${cy + armY}`,
        `L ${cx + armX} ${cy + armY}`,
        `L ${cx + armX} ${h}`,
        `L ${cx - armX} ${h}`,
        `L ${cx - armX} ${cy + armY}`,
        `L 0 ${cy + armY}`,
        `L 0 ${cy - armY}`,
        `L ${cx - armX} ${cy - armY}`,
        `Z`,
      ].join(' ')
    },
  },

  /**
   * 四角星
   */
  star4: {
    editable: true,
    defaultValue: [0.4],
    range: [[0.1, 0.9]],
    relative: ['top'],
    formula: (w: number, h: number, v?: number[]) => {
      const cx = w / 2
      const cy = h / 2
      const outerRx = w / 2
      const outerRy = h / 2
      const ratio = v?.[0] ?? 0.4
      const innerRx = outerRx * ratio
      const innerRy = outerRy * ratio
      const points: string[] = []
      for (let i = 0; i < 4; i++) {
        const outerAngle = ((i * 90 - 90) * Math.PI) / 180
        points.push(`${cx + outerRx * Math.cos(outerAngle)} ${cy + outerRy * Math.sin(outerAngle)}`)
        const innerAngle = (((i * 90 + 45) - 90) * Math.PI) / 180
        points.push(`${cx + innerRx * Math.cos(innerAngle)} ${cy + innerRy * Math.sin(innerAngle)}`)
      }
      return `M ${points.join(' L ')} Z`
    },
  },

  /**
   * 上箭头
   */
  upArrow: {
    editable: true,
    defaultValue: [0.5, 0.3],
    range: [
      [0, 1],
      [0, 0.5],
    ],
    relative: ['top', 'left'],
    formula: (w: number, h: number, v?: number[]) => {
      const bodyHeight = h * (v?.[0] ?? 0.5)
      const arrowInset = w * (v?.[1] ?? 0.3)
      return [
        `M ${w / 2} 0`,
        `L ${w} ${h - bodyHeight}`,
        `L ${w - arrowInset} ${h - bodyHeight}`,
        `L ${w - arrowInset} ${h}`,
        `L ${arrowInset} ${h}`,
        `L ${arrowInset} ${h - bodyHeight}`,
        `L 0 ${h - bodyHeight}`,
        `Z`,
      ].join(' ')
    },
  },

  /**
   * 下箭头
   */
  downArrow: {
    editable: true,
    defaultValue: [0.5, 0.3],
    range: [
      [0, 1],
      [0, 0.5],
    ],
    relative: ['bottom', 'left'],
    formula: (w: number, h: number, v?: number[]) => {
      const bodyHeight = h * (v?.[0] ?? 0.5)
      const arrowInset = w * (v?.[1] ?? 0.3)
      return [
        `M ${arrowInset} 0`,
        `L ${w - arrowInset} 0`,
        `L ${w - arrowInset} ${bodyHeight}`,
        `L ${w} ${bodyHeight}`,
        `L ${w / 2} ${h}`,
        `L 0 ${bodyHeight}`,
        `L ${arrowInset} ${bodyHeight}`,
        `Z`,
      ].join(' ')
    },
  },

  /**
   * 左右双向箭头
   */
  leftRightArrow: {
    editable: true,
    defaultValue: [0.2, 0.3],
    range: [
      [0, 0.5],
      [0, 0.5],
    ],
    relative: ['left', 'top'],
    formula: (w: number, h: number, v?: number[]) => {
      const arrowW = w * (v?.[0] ?? 0.2)
      const inset = h * (v?.[1] ?? 0.3)
      return [
        `M 0 ${h / 2}`,
        `L ${arrowW} 0`,
        `L ${arrowW} ${inset}`,
        `L ${w - arrowW} ${inset}`,
        `L ${w - arrowW} 0`,
        `L ${w} ${h / 2}`,
        `L ${w - arrowW} ${h}`,
        `L ${w - arrowW} ${h - inset}`,
        `L ${arrowW} ${h - inset}`,
        `L ${arrowW} ${h}`,
        `Z`,
      ].join(' ')
    },
  },

  /**
   * 上下双向箭头
   */
  upDownArrow: {
    editable: true,
    defaultValue: [0.2, 0.3],
    range: [
      [0, 0.5],
      [0, 0.5],
    ],
    relative: ['top', 'left'],
    formula: (w: number, h: number, v?: number[]) => {
      const arrowH = h * (v?.[0] ?? 0.2)
      const inset = w * (v?.[1] ?? 0.3)
      return [
        `M ${w / 2} 0`,
        `L ${w} ${arrowH}`,
        `L ${w - inset} ${arrowH}`,
        `L ${w - inset} ${h - arrowH}`,
        `L ${w} ${h - arrowH}`,
        `L ${w / 2} ${h}`,
        `L 0 ${h - arrowH}`,
        `L ${inset} ${h - arrowH}`,
        `L ${inset} ${arrowH}`,
        `L 0 ${arrowH}`,
        `Z`,
      ].join(' ')
    },
  },

  /**
   * 缺口右箭头
   */
  notchedRightArrow: {
    editable: true,
    defaultValue: [0.5, 0.3],
    range: [
      [0, 1],
      [0, 0.5],
    ],
    relative: ['left', 'top'],
    formula: (w: number, h: number, v?: number[]) => {
      const bodyWidth = w * (v?.[0] ?? 0.5)
      const arrowInset = h * (v?.[1] ?? 0.3)
      const notch = (h / 2 - arrowInset) * 0.6
      return [
        `M 0 ${arrowInset}`,
        `L ${bodyWidth} ${arrowInset}`,
        `L ${bodyWidth} 0`,
        `L ${w} ${h / 2}`,
        `L ${bodyWidth} ${h}`,
        `L ${bodyWidth} ${h - arrowInset}`,
        `L 0 ${h - arrowInset}`,
        `L ${notch} ${h / 2}`,
        `Z`,
      ].join(' ')
    },
  },

  /**
   * 直角三角形
   */
  rtTriangle: {
    editable: false,
    defaultValue: [],
    range: [],
    relative: [],
    formula: (w: number, h: number) => {
      return `M 0 ${h} L ${w} ${h} L 0 0 Z`
    },
  },

  /**
   * 心形
   *
   * 使用贝塞尔曲线近似经典心形轮廓
   */
  heart: {
    editable: false,
    defaultValue: [],
    range: [],
    relative: [],
    formula: (w: number, h: number) => {
      const cx = w / 2
      return [
        `M ${cx} ${h * 0.25}`,
        `C ${cx} ${h * 0.1} ${w * 0.25} 0 ${w * 0.1} 0`,
        `C 0 0 0 ${h * 0.15} 0 ${h * 0.3}`,
        `C 0 ${h * 0.55} ${cx} ${h * 0.7} ${cx} ${h}`,
        `C ${cx} ${h * 0.7} ${w} ${h * 0.55} ${w} ${h * 0.3}`,
        `C ${w} ${h * 0.15} ${w} 0 ${w * 0.9} 0`,
        `C ${w * 0.75} 0 ${cx} ${h * 0.1} ${cx} ${h * 0.25}`,
        `Z`,
      ].join(' ')
    },
  },

  /**
   * 闪电
   */
  lightningBolt: {
    editable: false,
    defaultValue: [],
    range: [],
    relative: [],
    formula: (w: number, h: number) => {
      return [
        `M ${w * 0.37} 0`,
        `L ${w * 0.63} 0`,
        `L ${w * 0.52} ${h * 0.35}`,
        `L ${w * 0.75} ${h * 0.35}`,
        `L ${w * 0.3} ${h}`,
        `L ${w * 0.42} ${h * 0.5}`,
        `L ${w * 0.2} ${h * 0.5}`,
        `Z`,
      ].join(' ')
    },
  },

  /**
   * 云形
   *
   * 使用多段贝塞尔曲线近似
   */
  cloud: {
    editable: false,
    defaultValue: [],
    range: [],
    relative: [],
    formula: (w: number, h: number) => {
      return [
        `M ${w * 0.25} ${h * 0.7}`,
        `C ${w * 0.05} ${h * 0.7} 0 ${h * 0.55} ${w * 0.08} ${h * 0.4}`,
        `C ${w * 0.02} ${h * 0.25} ${w * 0.15} ${h * 0.1} ${w * 0.3} ${h * 0.15}`,
        `C ${w * 0.35} ${h * 0.02} ${w * 0.5} 0 ${w * 0.6} ${h * 0.08}`,
        `C ${w * 0.7} 0 ${w * 0.85} ${h * 0.05} ${w * 0.88} ${h * 0.22}`,
        `C ${w} ${h * 0.25} ${w} ${h * 0.45} ${w * 0.9} ${h * 0.55}`,
        `C ${w * 0.98} ${h * 0.65} ${w * 0.9} ${h * 0.8} ${w * 0.75} ${h * 0.8}`,
        `L ${w * 0.25} ${h * 0.8}`,
        `C ${w * 0.1} ${h * 0.8} ${w * 0.05} ${h * 0.78} ${w * 0.25} ${h * 0.7}`,
        `Z`,
      ].join(' ')
    },
  },

  /**
   * 尖括号/V 形标
   */
  chevron: {
    editable: true,
    defaultValue: [0.25],
    range: [[0.05, 0.5]],
    relative: ['left'],
    formula: (w: number, h: number, v?: number[]) => {
      const indent = w * (v?.[0] ?? 0.25)
      return [
        `M 0 0`,
        `L ${w - indent} 0`,
        `L ${w} ${h / 2}`,
        `L ${w - indent} ${h}`,
        `L 0 ${h}`,
        `L ${indent} ${h / 2}`,
        `Z`,
      ].join(' ')
    },
  },

  /**
   * 标注框 1（矩形 + 底部指示线）
   */
  callout1: {
    editable: false,
    defaultValue: [],
    range: [],
    relative: [],
    formula: (w: number, h: number) => {
      const boxH = h * 0.7
      return [
        `M 0 0 L ${w} 0 L ${w} ${boxH} L 0 ${boxH} Z`,
        `M ${w * 0.2} ${boxH} L ${w * 0.15} ${h} L ${w * 0.35} ${boxH} Z`,
      ].join(' ')
    },
  },

  /**
   * 标注框 2（圆角矩形 + 底部指示线）
   */
  callout2: {
    editable: false,
    defaultValue: [],
    range: [],
    relative: [],
    formula: (w: number, h: number) => {
      const boxH = h * 0.7
      const r = Math.min(w, boxH) * 0.08
      return [
        `M ${r} 0 L ${w - r} 0 Q ${w} 0 ${w} ${r} L ${w} ${boxH - r} Q ${w} ${boxH} ${w - r} ${boxH} L ${w * 0.35} ${boxH}`,
        `L ${w * 0.15} ${h} L ${w * 0.2} ${boxH}`,
        `L ${r} ${boxH} Q 0 ${boxH} 0 ${boxH - r} L 0 ${r} Q 0 0 ${r} 0 Z`,
      ].join(' ')
    },
  },
}

// ── 形状预设 ──────────────────────────────────────────────────

export interface ShapePreset {
  /** 形状名称 */
  name: string
  /** 默认 viewBox [width, height] */
  viewBox: [number, number]
  /** 默认 SVG path（无 pathFormula 时使用） */
  path: string
  /** 路径公式名称（对应 ShapePathFormulas 的 key） */
  pathFormula?: string
  /** 默认控制点值 */
  keypoints?: number[]
  /** 是否固定宽高比 */
  fixedRatio?: boolean
  /** 特殊形状（导出时降级为图片） */
  special?: boolean
  /** PPTX 形状类型映射 */
  pptxShapeType?: string
}

/**
 * 预设形状库（按分类组织）
 *
 * 参考 PPTist 的 100+ 形状，先提供最常用的基础集合。
 * 后续可从 PPTist 的 shapes.ts 逐步扩充。
 */
export const SHAPE_PRESETS: Record<string, ShapePreset[]> = {
  '矩形': [
    {
      name: '矩形',
      viewBox: [200, 150],
      path: 'M 0 0 L 200 0 L 200 150 L 0 150 Z',
      pptxShapeType: 'rect',
    },
    {
      name: '圆角矩形',
      viewBox: [200, 150],
      path: 'M 15 0 L 185 0 Q 200 0 200 15 L 200 135 Q 200 150 185 150 L 15 150 Q 0 150 0 135 L 0 15 Q 0 0 15 0 Z',
      pathFormula: 'roundRect',
      keypoints: [0.1, 0.1, 0.1, 0.1],
      pptxShapeType: 'roundRect',
    },
    {
      name: '单圆角矩形',
      viewBox: [200, 150],
      path: 'M 30 0 L 200 0 L 200 150 L 0 150 L 0 30 Q 0 0 30 0 Z',
      pathFormula: 'roundRect',
      keypoints: [0.2, 0, 0, 0],
      pptxShapeType: 'round1Rect',
    },
    {
      name: '剪切矩形',
      viewBox: [200, 150],
      path: 'M 15 0 L 200 0 L 200 135 L 185 150 L 0 150 L 0 15 Z',
      pathFormula: 'cutRect',
      keypoints: [0.1],
      pptxShapeType: 'snip2DiagRect',
    },
  ],

  '基础形状': [
    {
      name: '椭圆',
      viewBox: [200, 150],
      path: 'M 100 0 A 100 75 0 1 1 100 150 A 100 75 0 1 1 100 0 Z',
      pathFormula: 'ellipse',
      fixedRatio: false,
      pptxShapeType: 'ellipse',
    },
    {
      name: '圆形',
      viewBox: [200, 200],
      path: 'M 100 0 A 100 100 0 1 1 100 200 A 100 100 0 1 1 100 0 Z',
      pathFormula: 'ellipse',
      fixedRatio: true,
      pptxShapeType: 'ellipse',
    },
    {
      name: '三角形',
      viewBox: [200, 200],
      path: 'M 100 0 L 200 200 L 0 200 Z',
      pathFormula: 'triangle',
      keypoints: [0.5],
      pptxShapeType: 'triangle',
    },
    {
      name: '菱形',
      viewBox: [200, 200],
      path: 'M 100 0 L 200 100 L 100 200 L 0 100 Z',
      pathFormula: 'diamond',
      pptxShapeType: 'diamond',
    },
    {
      name: '平行四边形',
      viewBox: [200, 150],
      path: 'M 50 0 L 200 0 L 150 150 L 0 150 Z',
      pathFormula: 'parallelogram',
      keypoints: [0.25],
      pptxShapeType: 'parallelogram',
    },
    {
      name: '梯形',
      viewBox: [200, 150],
      path: 'M 40 0 L 160 0 L 200 150 L 0 150 Z',
      pathFormula: 'trapezoid',
      keypoints: [0.2],
      pptxShapeType: 'trapezoid',
    },
    {
      name: '五边形',
      viewBox: [200, 200],
      path: '',
      pathFormula: 'pentagon',
      pptxShapeType: 'pentagon',
    },
    {
      name: '六边形',
      viewBox: [200, 200],
      path: '',
      pathFormula: 'hexagon',
      pptxShapeType: 'hexagon',
    },
    {
      name: '八边形',
      viewBox: [200, 200],
      path: '',
      pathFormula: 'octagon',
      pptxShapeType: 'octagon',
    },
    {
      name: '十字形',
      viewBox: [200, 200],
      path: '',
      pathFormula: 'cross',
      keypoints: [0.3],
      pptxShapeType: 'plus',
    },
  ],

  '基础形状 2': [
    {
      name: '直角三角形',
      viewBox: [200, 200],
      path: '',
      pathFormula: 'rtTriangle',
      pptxShapeType: 'rtTriangle',
    },
    {
      name: '心形',
      viewBox: [200, 200],
      path: '',
      pathFormula: 'heart',
      fixedRatio: true,
      pptxShapeType: 'heart',
    },
    {
      name: '闪电',
      viewBox: [150, 250],
      path: '',
      pathFormula: 'lightningBolt',
      pptxShapeType: 'lightningBolt',
    },
    {
      name: '云形',
      viewBox: [250, 180],
      path: '',
      pathFormula: 'cloud',
      pptxShapeType: 'cloud',
    },
    {
      name: 'V 形标',
      viewBox: [200, 150],
      path: '',
      pathFormula: 'chevron',
      keypoints: [0.25],
      pptxShapeType: 'chevron',
    },
    {
      name: '标注框',
      viewBox: [200, 180],
      path: '',
      pathFormula: 'callout1',
      pptxShapeType: 'callout1',
    },
    {
      name: '圆角标注框',
      viewBox: [200, 180],
      path: '',
      pathFormula: 'callout2',
      pptxShapeType: 'callout2',
    },
  ],

  '箭头': [
    {
      name: '右箭头',
      viewBox: [200, 150],
      path: '',
      pathFormula: 'rightArrow',
      keypoints: [0.5, 0.3],
      pptxShapeType: 'rightArrow',
    },
    {
      name: '左箭头',
      viewBox: [200, 150],
      path: '',
      pathFormula: 'leftArrow',
      keypoints: [0.5, 0.3],
      pptxShapeType: 'leftArrow',
    },
    {
      name: '上箭头',
      viewBox: [150, 200],
      path: '',
      pathFormula: 'upArrow',
      keypoints: [0.5, 0.3],
      pptxShapeType: 'upArrow',
    },
    {
      name: '下箭头',
      viewBox: [150, 200],
      path: '',
      pathFormula: 'downArrow',
      keypoints: [0.5, 0.3],
      pptxShapeType: 'downArrow',
    },
    {
      name: '左右双向箭头',
      viewBox: [250, 150],
      path: '',
      pathFormula: 'leftRightArrow',
      keypoints: [0.2, 0.3],
      pptxShapeType: 'leftRightArrow',
    },
    {
      name: '上下双向箭头',
      viewBox: [150, 250],
      path: '',
      pathFormula: 'upDownArrow',
      keypoints: [0.2, 0.3],
      pptxShapeType: 'upDownArrow',
    },
    {
      name: '缺口右箭头',
      viewBox: [200, 150],
      path: '',
      pathFormula: 'notchedRightArrow',
      keypoints: [0.5, 0.3],
      pptxShapeType: 'notchedRightArrow',
    },
  ],

  '星形': [
    {
      name: '五角星',
      viewBox: [200, 200],
      path: '',
      pathFormula: 'star5',
      keypoints: [0.4],
      fixedRatio: true,
      pptxShapeType: 'star5',
    },
    {
      name: '四角星',
      viewBox: [200, 200],
      path: '',
      pathFormula: 'star4',
      keypoints: [0.4],
      fixedRatio: true,
      pptxShapeType: 'star4',
    },
    {
      name: '六角星',
      viewBox: [200, 200],
      path: '',
      pathFormula: 'star6',
      keypoints: [0.4],
      fixedRatio: true,
      pptxShapeType: 'star6',
    },
  ],
}

// ── 工具函数 ──────────────────────────────────────────────────

/**
 * 获取形状的实际 path
 *
 * 如果形状有 pathFormula，用公式计算；否则返回预存的 path。
 */
export function getShapePath(
  pathFormula: string | undefined,
  path: string | undefined,
  width: number,
  height: number,
  keypoints?: number[],
): string {
  if (pathFormula && ShapePathFormulas[pathFormula]) {
    return ShapePathFormulas[pathFormula].formula(width, height, keypoints)
  }
  return path || `M 0 0 L ${width} 0 L ${width} ${height} L 0 ${height} Z`
}

/**
 * 获取所有形状预设的平铺列表
 */
export function getAllShapePresets(): ShapePreset[] {
  return Object.values(SHAPE_PRESETS).flat()
}

/**
 * 根据 pptxShapeType 查找预设
 */
export function findShapeByPptxType(pptxShapeType: string): ShapePreset | undefined {
  return getAllShapePresets().find((s) => s.pptxShapeType === pptxShapeType)
}
