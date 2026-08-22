/**
 * CDPOperationHelper
 *
 * Bridges crawl-integration's CDP Input domain capabilities into browser-core.
 * Handles operations that require real browser input events (drag, keyboard, mouse)
 * rather than JavaScript injection used by DOMOperationHelper.
 *
 * All CDP operations go through BrowserContext.sendCDP() — no direct webContents access.
 */

import type { BrowserContext } from '../context/BrowserContext'
import { SHADOW_DOM_HELPERS_SNIPPET, DEEP_SELECTOR_SEPARATOR, isDeepSelector } from '../page-scripts/shadow-dom'
import { animateCursorTo, pulseCursor, glideCursorTo } from './AgentCursor'
import { splitKeyCombo, normalizeModifier, buildKeyDescriptor } from './keyboard-utils'

export type CDPActionType =
  | 'click'
  | 'drag'
  | 'type'
  | 'keyPress'
  | 'keyDown'
  | 'keyUp'
  | 'hover'
  | 'upload'
  | 'select'
  | 'dblclick'

export interface CDPActionOptions {
  action: CDPActionType
  selector?: string
  value?: string
  toSelector?: string
  fromX?: number
  fromY?: number
  toX?: number
  toY?: number
  x?: number
  y?: number
  key?: string
  files?: string[]
  delay?: number
  steps?: number
  timeout?: number
}

export interface CDPOperationResult {
  success: boolean
  error?: string
  code?: string
  actualValue?: string
  checked?: boolean
  controlValue?: string
}

interface CheckableControlState {
  kind: 'checkbox' | 'radio'
  checked: boolean
  controlValue: string
}

type ControlInspection =
  | { status: 'ok'; state: CheckableControlState | null }
  | { status: 'failed'; error: string }

const CDP_ACTION_TYPES: ReadonlySet<string> = new Set([
  'click', 'drag', 'type', 'keyPress', 'keyDown', 'keyUp',
  'hover', 'upload', 'select', 'dblclick',
])

// ：selector 可能匹配多个元素（observe 弱 selector 历史遗留 / 泛化 CSS）。逐个查
// box model 找第一个可见者，每个候选一次 CDP round-trip，设上限防病态页（数百匹配）拖时。
const VISIBLE_MATCH_SCAN_LIMIT = 20
const CONTROL_INSPECTION_TIMEOUT_MS = 1000

async function withOperationTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function isCDPAction(actionType: string): boolean {
  return CDP_ACTION_TYPES.has(actionType)
}

/** 单码点 ASCII 可打印字符（不含控制符）；中文等走 Input.insertText。 */
function isAsciiPrintableChar(ch: string): boolean {
  return ch.length === 1 && ch >= ' ' && ch <= '~'
}

export function isCoordinateClick(action: any): boolean {
  return action.type === 'click' && (action.x != null || action.y != null) && !action.selector
}

export class CDPOperationHelper {
  private pressedModifiers = new Set<string>()

  async runAction(ctx: BrowserContext, options: CDPActionOptions): Promise<CDPOperationResult> {
    const { action } = options

    try {
      await this.ensureCDPReady(ctx)

      switch (action) {
        case 'click':
          return await this.executeClick(ctx, options)
        case 'drag':
          return await this.executeDrag(ctx, options)
        case 'type':
          return await this.executeType(ctx, options)
        case 'keyPress':
          return await this.executeKeyPress(ctx, options)
        case 'keyDown':
          return await this.executeKeyDown(ctx, options)
        case 'keyUp':
          return await this.executeKeyUp(ctx, options)
        case 'hover':
          return await this.executeHover(ctx, options)
        case 'upload':
          return await this.executeUpload(ctx, options)
        case 'select':
          return await this.executeSelect(ctx, options)
        case 'dblclick':
          return await this.executeDblClick(ctx, options)
        default:
          return { success: false, error: `Unsupported CDP action: ${action}`, code: 'unsupported_operation' }
      }
    } catch (err: any) {
      return {
        success: false,
        error: err?.message || String(err),
        code: 'cdp_error',
      }
    }
  }

  /** 列出 selector 的全部匹配 nodeId（CSS 走 querySelectorAll，xpath 走 performSearch），上限 VISIBLE_MATCH_SCAN_LIMIT。 */
  private async queryMatchingNodeIds(ctx: BrowserContext, selector: string): Promise<number[]> {
    if (isDeepSelector(selector)) {
      let objectId: string | undefined
      try {
        const evalResp = await ctx.sendCDP<any>('Runtime.evaluate', {
          expression: `(function(){ ${SHADOW_DOM_HELPERS_SNIPPET}; return __tabtinDeepQuery(${JSON.stringify(selector)}); })()`,
          returnByValue: false,
        })
        objectId = evalResp?.result?.objectId
        if (!objectId) return []
        const reqResp = await ctx.sendCDP<any>('DOM.requestNode', { objectId })
        const nodeId = reqResp?.nodeId
        return nodeId ? [nodeId] : []
      } finally {
        if (objectId) {
          await ctx.sendCDP('Runtime.releaseObject', { objectId }).catch(() => {})
        }
      }
    }

    if (selector.startsWith('xpath=') || selector.startsWith('/')) {
      const xpath = selector.startsWith('xpath=') ? selector.slice(6) : selector
      // Chrome 要求先把文档节点推送到前端，getSearchResults 返回的 nodeId 才能继续用于
      // getBoxModel / scrollIntoViewIfNeeded；否则真实页面会报 Could not find node with given id。
      await ctx.sendCDP('DOM.getDocument', { depth: 0 })
      const searchResp = await ctx.sendCDP<any>('DOM.performSearch', { query: xpath })
      try {
        if (!searchResp.resultCount) return []
        const results = await ctx.sendCDP<any>('DOM.getSearchResults', {
          searchId: searchResp.searchId,
          fromIndex: 0,
          toIndex: Math.min(searchResp.resultCount, VISIBLE_MATCH_SCAN_LIMIT),
        })
        return results.nodeIds ?? []
      } finally {
        await ctx.sendCDP('DOM.discardSearchResults', { searchId: searchResp.searchId }).catch(() => {})
      }
    }

    const docResp = await ctx.sendCDP<any>('DOM.getDocument', { depth: 0 })
    const queryResp = await ctx.sendCDP<any>('DOM.querySelectorAll', {
      nodeId: docResp.root.nodeId,
      selector,
    })
    return (queryResp.nodeIds ?? []).slice(0, VISIBLE_MATCH_SCAN_LIMIT)
  }

  /**
   * 对已确认有 layout 的 node：滚进视口、刷新 box、算出点击中心。
   * 任一步拿不到盒子则返回 null（调用方试下一候选）。
   */
  private async centerAfterScroll(
    ctx: BrowserContext,
    nodeId: number,
  ): Promise<{ cx: number; cy: number; nodeId: number; backendNodeId: number; objectId: string } | null> {
    await ctx.sendCDP('DOM.scrollIntoViewIfNeeded', { nodeId }).catch(() => {})
    const boxResp = await ctx.sendCDP<any>('DOM.getBoxModel', { nodeId }).catch(() => null)
    if (!boxResp?.model) return null

    // 原生 radio / checkbox 的 content quad 在 Chromium 中可能退化成零尺寸，
    // 但可见的系统控件仍占据 border quad。统一点 border 中心，缺失时才回退 content，
    // 避免事件成功发出却落在控件外侧。
    const quad = Array.isArray(boxResp.model.border) && boxResp.model.border.length === 8
      ? boxResp.model.border
      : boxResp.model.content
    const cx = (quad[0] + quad[2] + quad[4] + quad[6]) / 4
    const cy = (quad[1] + quad[3] + quad[5] + quad[7]) / 4

    const descResp = await ctx.sendCDP<any>('DOM.describeNode', { nodeId })
    const backendNodeId = descResp.node.backendNodeId

    const resolveResp = await ctx.sendCDP<any>('DOM.resolveNode', { nodeId })
    const objectId = resolveResp.object.objectId

    return { cx, cy, nodeId, backendNodeId, objectId }
  }

  /**
   * CDP getBoxModel / scrollIntoViewIfNeeded 对屏外分页等节点可能始终失败。
   * 改走 webContents.executeJavaScript（与 SoM / Agent eval 同通道）：
   * 页面内 scrollIntoView + getBoundingClientRect 出坐标即可点。
   * 不依赖 Runtime.evaluate（ensureCDPReady 原先只 DOM.enable，Runtime 域未开时整段静默失败）。
   */
  private async resolveElementCenterViaJs(
    ctx: BrowserContext,
    selector: string,
  ): Promise<{ cx: number; cy: number; nodeId: number; backendNodeId: number; objectId: string } | null> {
    type JsBox = { ok: boolean; cx: number; cy: number; w: number; h: number }
    let box: JsBox | null = null
    try {
      box = await ctx.executeScript<JsBox>(`(() => {
        ${SHADOW_DOM_HELPERS_SNIPPET}
        const sel = ${JSON.stringify(selector)};
        const list = [];
        if (sel.includes(${JSON.stringify(DEEP_SELECTOR_SEPARATOR)})) {
          const el = __tabtinDeepQuery(sel);
          if (el) list.push(el);
        } else if (sel.startsWith('xpath=') || sel.startsWith('/')) {
          const xpath = sel.startsWith('xpath=') ? sel.slice(6) : sel;
          const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          if (node && node.nodeType === 1) list.push(node);
        } else {
          try { list.push(...document.querySelectorAll(sel)); } catch (e) { /* invalid selector */ }
        }
        for (const el of list) {
          try {
            el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
          } catch (e) {
            try { el.scrollIntoView(true); } catch (_) { /* ignore */ }
          }
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if ((r.width <= 0 && r.height <= 0) || style.display === 'none' || style.visibility === 'hidden') continue;
          if (parseFloat(style.opacity || '1') === 0) continue;
          return {
            ok: true,
            cx: r.left + r.width / 2,
            cy: r.top + r.height / 2,
            w: r.width,
            h: r.height,
          };
        }
        return { ok: false, cx: 0, cy: 0, w: 0, h: 0 };
      })()`)
    } catch {
      return null
    }
    if (!box?.ok || (box.w <= 0 && box.h <= 0)) return null

    // JS 已滚进视口后，再试一次 CDP 取句柄（upload 等需要 backendNodeId）
    try {
      const nodeIds = await this.queryMatchingNodeIds(ctx, selector)
      for (const nodeId of nodeIds) {
        if (!nodeId) continue
        const centered = await this.centerAfterScroll(ctx, nodeId)
        if (centered) return centered
      }
    } catch {
      // 句柄仍不可用时，点击只依赖坐标
    }

    return {
      cx: box.cx,
      cy: box.cy,
      nodeId: -1,
      backendNodeId: -1,
      objectId: '',
    }
  }

  private async resolveElementCenter(
    ctx: BrowserContext,
    selector: string,
    timeout = 5000,
  ): Promise<{ cx: number; cy: number; nodeId: number; backendNodeId: number; objectId: string }> {
    const deadline = Date.now() + timeout
    // ：扫描全部匹配取第一个可点者（避免弱 CSS 死磕首个隐藏节点）。
    // ① 无滚动 probe → ② CDP scroll + 取盒 → ③ 页面 JS scrollIntoView + getBoundingClientRect
    // （屏外分页上 CDP getBoxModel 即使 scroll 后仍可能失败；③ 与 eval 同路径）。
    let lastMatchCount = 0

    while (Date.now() < deadline) {
      try {
        const nodeIds = await this.queryMatchingNodeIds(ctx, selector)
        lastMatchCount = nodeIds.length

        // Pass 1：不滚动，命中已有 layout 的候选
        for (const nodeId of nodeIds) {
          if (!nodeId) continue
          const probe = await ctx.sendCDP<any>('DOM.getBoxModel', { nodeId }).catch(() => null)
          if (!probe?.model) continue
          const centered = await this.centerAfterScroll(ctx, nodeId)
          if (centered) return centered
        }

        // Pass 2：CDP scroll + 取盒
        for (const nodeId of nodeIds) {
          if (!nodeId) continue
          const centered = await this.centerAfterScroll(ctx, nodeId)
          if (centered) return centered
        }

        // Pass 3：页面 JS 定位（CDP box model 对屏外节点失灵时的兜底）
        const viaJs = await this.resolveElementCenterViaJs(ctx, selector)
        if (viaJs) return viaJs
      } catch {
        // CDP 瞬时错误（导航中 / 节点树重建）：吞掉，下一轮重扫
      }
      await this.sleep(100)
    }
    // 区分两类失败：无匹配 → not found；有匹配但全不可见 → not visible。
    // 两种消息都保持能被 isStaleLocatorError 识别（触发语义重定位）。
    if (lastMatchCount > 0) {
      throw new Error(`Element not found or not visible: ${selector} (${lastMatchCount} matches, none visible)`)
    }
    throw new Error(`Element not found or not visible: ${selector}`)
  }

  private async executeClick(ctx: BrowserContext, opts: CDPActionOptions): Promise<CDPOperationResult> {
    const hasCoordinate = opts.x != null || opts.y != null
    if (opts.selector && hasCoordinate) {
      return {
        success: false,
        error: 'click 不能同时使用 selector/ref 与 x/y 坐标',
        code: 'invalid_params',
      }
    }

    let cx: number, cy: number
    let objectId: string | undefined
    if (opts.x != null && opts.y != null) {
      cx = opts.x
      cy = opts.y
    } else if (opts.selector) {
      const el = await this.resolveElementCenter(ctx, opts.selector, opts.timeout)
      cx = el.cx
      cy = el.cy
      objectId = el.objectId || undefined
    } else {
      // 报错必须给出 ref 用法：dogfood（36kr）里 Agent 传 {"element":"文字"} 落到这里后，
      // 旧文案只提 selector/坐标，把它推去猜 CSS selector 和拼 URL。ref 是 observe → act
      // 的 canonical 引用（BR-27），要放在第一位。
      return {
        success: false,
        error: 'click requires "ref" (observed_elements[].ref, e.g. {"type":"click","ref":"e12"}), "selector", or x/y coordinates',
        code: 'invalid_params',
      }
    }

    // 状态读取绑定到 resolveElementCenter 实际选中的同一个 CDP object，不能再用
    // document.querySelector 重新取 selector 首项，否则多匹配时可能“点第二个、验第一个”。
    let before: CheckableControlState | null = null
    if (objectId) {
      const inspection = await this.inspectControlState(ctx, objectId)
      if (inspection.status === 'failed') {
        this.releaseObject(ctx, objectId)
        return {
          success: false,
          error: `点击前无法检查目标控件：${inspection.error}`,
          code: 'element_not_interactable',
        }
      }
      before = inspection.state
    }

    // 普通按钮/链接点击可能立即导航。确认不是 checkable 后先释放对象，
    // 点击完成即返回，不在旧页面执行上下文上追加任何脚本或 CDP 对象操作。
    if (!before && objectId) this.releaseObject(ctx, objectId)

    const result = await this.clickAtCoordinate(ctx, cx, cy)
    if (!result.success || !before || !objectId) return result

    const afterInspection = await this.inspectControlState(ctx, objectId)
    this.releaseObject(ctx, objectId)
    if (afterInspection.status === 'failed') {
      return {
        success: false,
        error: `点击后无法确认原生选择控件状态：${afterInspection.error}`,
        code: 'element_not_interactable',
        checked: before.checked,
        controlValue: before.controlValue,
      }
    }
    const after = afterInspection.state
    if (!after || after.kind !== before.kind) {
      return {
        success: false,
        error: '点击后目标不再是同一种原生选择控件',
        code: 'element_not_interactable',
        checked: before.checked,
        controlValue: before.controlValue,
      }
    }

    const stateChangedAsExpected = before.kind === 'radio'
      ? after.checked
      : after.checked !== before.checked
    if (!stateChangedAsExpected) {
      return {
        success: false,
        error: before.kind === 'radio'
          ? '点击后单选框仍未选中'
          : '点击后复选框状态未切换',
        code: 'element_not_interactable',
        checked: after.checked,
        controlValue: after.controlValue,
      }
    }

    return {
      ...result,
      checked: after.checked,
      controlValue: after.controlValue,
    }
  }

  private async executeDrag(ctx: BrowserContext, opts: CDPActionOptions): Promise<CDPOperationResult> {
    let fromX = opts.fromX
    let fromY = opts.fromY
    let toX = opts.toX
    let toY = opts.toY

    if (opts.selector && fromX == null) {
      const from = await this.resolveElementCenter(ctx, opts.selector, opts.timeout)
      fromX = from.cx
      fromY = from.cy
    }
    if (opts.toSelector && toX == null) {
      const to = await this.resolveElementCenter(ctx, opts.toSelector, opts.timeout)
      toX = to.cx
      toY = to.cy
    }

    if (fromX == null || fromY == null || toX == null || toY == null) {
      return { success: false, error: 'Drag requires from/to coordinates or selectors', code: 'invalid_params' }
    }

    const steps = Math.max(1, opts.steps ?? 10)
    const delay = opts.delay ?? 5

    // 指针飞到拖拽起点，按下时缩小；拖动期间页内 glide 匀速跟随（不逐步 roundtrip）
    await animateCursorTo(ctx, fromX, fromY)
    pulseCursor(ctx, 'down')
    glideCursorTo(ctx, toX, toY, steps * Math.max(delay, 5) + 100)

    await ctx.sendCDP('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: fromX, y: fromY, button: 'none',
    })
    await this.sleep(50)
    await ctx.sendCDP('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: fromX, y: fromY, button: 'left', clickCount: 1,
    })
    await this.sleep(50)

    for (let i = 1; i <= steps; i++) {
      const ratio = i / steps
      const x = Math.round(fromX + (toX - fromX) * ratio)
      const y = Math.round(fromY + (toY - fromY) * ratio)
      await ctx.sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x, y, button: 'left',
      })
      if (delay > 0) await this.sleep(delay)
    }

    await this.sleep(50)
    await ctx.sendCDP('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: toX, y: toY, button: 'left', clickCount: 1,
    })

    pulseCursor(ctx, 'up')
    return { success: true }
  }

  private async executeType(ctx: BrowserContext, opts: CDPActionOptions): Promise<CDPOperationResult> {
    if (opts.selector) {
      const el = await this.resolveElementCenter(ctx, opts.selector, opts.timeout)
      await this.clickAtCoordinate(ctx, el.cx, el.cy)
      await this.sleep(100)
    }

    const text = opts.value ?? ''
    const delay = opts.delay ?? 50

    for (const ch of text) {
      // ASCII 可打印走逐键；中文等非 ASCII 必须 insertText，否则 CDP key 事件常不落 value。
      if (isAsciiPrintableChar(ch)) {
        await ctx.sendCDP('Input.dispatchKeyEvent', {
          type: 'keyDown', key: ch, text: ch, unmodifiedText: ch,
        })
        await ctx.sendCDP('Input.dispatchKeyEvent', {
          type: 'keyUp', key: ch,
        })
      } else {
        await ctx.sendCDP('Input.insertText', { text: ch })
      }
      if (delay > 0) await this.sleep(delay)
    }

    // 无 selector 时只向当前焦点打字，无法可靠回读；有 selector 时必须对齐 fill 的 value 契约。
    if (!opts.selector) {
      return { success: true }
    }

    return await this.verifyTypedValue(ctx, opts.selector, text)
  }

  /** type 成功门禁：回读 DOM value，不一致则失败（堵住「事件已发 / value 未变」假阳性）。 */
  private async verifyTypedValue(
    ctx: BrowserContext,
    selector: string,
    requestedValue: string,
  ): Promise<CDPOperationResult> {
    // 给受控组件一帧机会吸收 input 事件，再对齐 fill 的不一致判定。
    await Promise.resolve()

    const result = await ctx.executeScript<CDPOperationResult>(`
      (function() {
        ${SHADOW_DOM_HELPERS_SNIPPET}
        const selector = ${JSON.stringify(selector)};
        let el;
        try {
          if (selector.includes(${JSON.stringify(DEEP_SELECTOR_SEPARATOR)})) {
            el = __tabtinDeepQuery(selector);
          } else if (selector.startsWith('xpath=') || selector.startsWith('/')) {
            const xpath = selector.startsWith('xpath=') ? selector.slice(6) : selector;
            el = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          } else {
            el = document.querySelector(selector);
          }
        } catch (error) {
          return { success: false, error: error?.message || String(error), code: 'selector_evaluation_failed' };
        }
        if (!el || !('value' in el)) {
          return { success: false, error: '填写目标不是可输入控件', code: 'element_not_interactable' };
        }
        const actualValue = String(el.value);
        if (actualValue !== ${JSON.stringify(requestedValue)}) {
          return {
            success: false,
            error: '填写后值与请求值不一致',
            code: 'invalid_parameter',
            actualValue,
          };
        }
        return { success: true, actualValue };
      })()
    `)

    return result ?? {
      success: false,
      error: '填写后无法读取控件值',
      code: 'element_not_interactable',
    }
  }

  private async executeKeyPress(ctx: BrowserContext, opts: CDPActionOptions): Promise<CDPOperationResult> {
    const key = opts.key || opts.value || ''
    if (!key) return { success: false, error: 'keyPress requires a key', code: 'invalid_params' }

    const parts = splitKeyCombo(key)

    const modifiers: string[] = []
    const mainKeys: string[] = []

    for (const part of parts) {
      const normalized = normalizeModifier(part)
      if (['Alt', 'Control', 'Meta', 'Shift'].includes(normalized)) {
        modifiers.push(normalized)
      } else {
        mainKeys.push(part)
      }
    }

    try {
      for (const mod of modifiers) {
        await this.executeKeyDown(ctx, { action: 'keyDown', key: mod })
      }

      for (const mk of mainKeys) {
        const kd = buildKeyDescriptor(mk)
        const modBits = this.getModifierBits()
        await ctx.sendCDP('Input.dispatchKeyEvent', {
          type: 'rawKeyDown', ...kd, modifiers: modBits,
        })
        if (kd.text) {
          await ctx.sendCDP('Input.dispatchKeyEvent', {
            type: 'char', text: kd.text, unmodifiedText: kd.text, modifiers: modBits,
          })
        }
        await ctx.sendCDP('Input.dispatchKeyEvent', {
          type: 'keyUp', ...kd, modifiers: modBits,
        })
      }

      for (const mod of modifiers.reverse()) {
        await this.executeKeyUp(ctx, { action: 'keyUp', key: mod })
      }
    } finally {
      this.pressedModifiers.clear()
    }

    return { success: true }
  }

  private async executeKeyDown(ctx: BrowserContext, opts: CDPActionOptions): Promise<CDPOperationResult> {
    const key = opts.key || opts.value || ''
    const normalized = normalizeModifier(key)

    const isModifier = ['Alt', 'Control', 'Meta', 'Shift'].includes(normalized)
    if (isModifier) {
      this.pressedModifiers.add(normalized)
    }

    const kd = buildKeyDescriptor(normalized)
    try {
      await ctx.sendCDP('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', ...kd, modifiers: this.getModifierBits(),
      })
    } catch (err) {
      if (isModifier) {
        this.pressedModifiers.delete(normalized)
      }
      throw err
    }
    return { success: true }
  }

  resetModifiers(): void {
    this.pressedModifiers.clear()
  }

  private async executeKeyUp(ctx: BrowserContext, opts: CDPActionOptions): Promise<CDPOperationResult> {
    const key = opts.key || opts.value || ''
    const normalized = normalizeModifier(key)

    if (['Alt', 'Control', 'Meta', 'Shift'].includes(normalized)) {
      this.pressedModifiers.delete(normalized)
    }

    const kd = buildKeyDescriptor(normalized)
    await ctx.sendCDP('Input.dispatchKeyEvent', {
      type: 'keyUp', ...kd, modifiers: this.getModifierBits(),
    })
    return { success: true }
  }

  private async executeHover(ctx: BrowserContext, opts: CDPActionOptions): Promise<CDPOperationResult> {
    if (opts.x != null && opts.y != null) {
      await animateCursorTo(ctx, opts.x, opts.y)
      await ctx.sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: opts.x, y: opts.y, button: 'none',
      })
      return { success: true }
    }

    if (!opts.selector) {
      return { success: false, error: 'hover requires a selector or coordinates (x, y)', code: 'invalid_params' }
    }
    const el = await this.resolveElementCenter(ctx, opts.selector, opts.timeout)

    await animateCursorTo(ctx, el.cx, el.cy)
    await ctx.sendCDP('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: el.cx, y: el.cy, button: 'none',
    })
    return { success: true }
  }

  private async executeDblClick(ctx: BrowserContext, opts: CDPActionOptions): Promise<CDPOperationResult> {
    if (!opts.selector && opts.x == null) {
      return { success: false, error: 'dblclick requires a selector or coordinates', code: 'invalid_params' }
    }

    let cx: number, cy: number
    if (opts.selector) {
      const el = await this.resolveElementCenter(ctx, opts.selector, opts.timeout)
      cx = el.cx
      cy = el.cy
    } else {
      cx = opts.x!
      cy = opts.y ?? 0
    }

    await animateCursorTo(ctx, cx, cy)
    pulseCursor(ctx, 'click')
    await ctx.sendCDP('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none' })
    await ctx.sendCDP('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 })
    await ctx.sendCDP('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })
    await ctx.sendCDP('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 2 })
    await ctx.sendCDP('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 2 })
    return { success: true }
  }

  private async executeUpload(ctx: BrowserContext, opts: CDPActionOptions): Promise<CDPOperationResult> {
    if (!opts.selector) {
      return { success: false, error: 'upload requires a selector for the file input', code: 'invalid_params' }
    }
    const files = opts.files || (opts.value ? [opts.value] : [])
    if (files.length === 0) {
      return { success: false, error: 'upload requires at least one file path', code: 'invalid_params' }
    }

    const el = await this.resolveElementCenter(ctx, opts.selector, opts.timeout)

    await animateCursorTo(ctx, el.cx, el.cy)
    await ctx.sendCDP('DOM.setFileInputFiles', {
      files,
      backendNodeId: el.backendNodeId,
    })
    return { success: true }
  }

  private async executeSelect(ctx: BrowserContext, opts: CDPActionOptions): Promise<CDPOperationResult> {
    if (!opts.selector || !opts.value) {
      return { success: false, error: 'select requires selector and value', code: 'invalid_params' }
    }

    try {
      const el = await this.resolveElementCenter(ctx, opts.selector, Math.min(opts.timeout ?? 5000, 2000))
      await animateCursorTo(ctx, el.cx, el.cy)
    } catch {
      // 元素中心解析失败不影响 select 本体（executeScript 内部有自己的查找逻辑）
    }

    const result = await ctx.executeScript<CDPOperationResult>(`
      (function() {
        ${SHADOW_DOM_HELPERS_SNIPPET}
        const selector = ${JSON.stringify(opts.selector)};
        let el;
        try {
          if (selector.includes(${JSON.stringify(DEEP_SELECTOR_SEPARATOR)})) {
            el = __tabtinDeepQuery(selector);
          } else if (selector.startsWith('xpath=') || selector.startsWith('/')) {
            const xpath = selector.startsWith('xpath=') ? selector.slice(6) : selector;
            el = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          } else {
            el = document.querySelector(selector);
          }
        } catch (error) {
          return { success: false, error: error?.message || String(error), code: 'selector_evaluation_failed' };
        }
        if (!el || el.tagName !== 'SELECT') {
          return { success: false, error: 'Element is not a <select>', code: 'invalid_element' };
        }
        el.value = ${JSON.stringify(opts.value)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        const actualValue = String(el.value);
        if (actualValue !== ${JSON.stringify(opts.value)}) {
          return { success: false, error: '选择后值与请求值不一致', code: 'invalid_parameter', actualValue, controlValue: actualValue };
        }
        return { success: true, actualValue, controlValue: actualValue };
      })()
    `)

    return result
  }

  private async inspectControlState(
    ctx: BrowserContext,
    objectId: string,
  ): Promise<ControlInspection> {
    try {
      const response = await withOperationTimeout(
        ctx.sendCDP<any>('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function () {
            if (this instanceof HTMLInputElement && (this.type === 'radio' || this.type === 'checkbox')) {
              return {
                kind: this.type,
                checked: Boolean(this.checked),
                controlValue: String(this.value),
              };
            }
            return null;
          }`,
          returnByValue: true,
          awaitPromise: false,
        }),
        CONTROL_INSPECTION_TIMEOUT_MS,
        `控件状态读取超过 ${CONTROL_INSPECTION_TIMEOUT_MS}ms`,
      )
      if (response?.exceptionDetails) {
        return {
          status: 'failed',
          error: response.exceptionDetails.text || '页面执行上下文异常',
        }
      }
      const state = response?.result?.value
      if (state == null) return { status: 'ok', state: null }
      if (
        (state?.kind !== 'checkbox' && state?.kind !== 'radio')
        || typeof state.checked !== 'boolean'
        || typeof state.controlValue !== 'string'
      ) {
        return { status: 'failed', error: '控件状态回执格式无效' }
      }
      return {
        status: 'ok',
        state: {
          kind: state.kind,
          checked: state.checked,
          controlValue: state.controlValue,
        },
      }
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private releaseObject(ctx: BrowserContext, objectId: string): void {
    void ctx.sendCDP('Runtime.releaseObject', { objectId }).catch(() => {})
  }

  async clickAtCoordinate(ctx: BrowserContext, x: number, y: number): Promise<CDPOperationResult> {
    await this.ensureCDPReady(ctx)
    // 模拟指针先飞到目标（失败静默、1.5s 兜底），到位后才派发真实点击。
    // pulse 必须在 mouseReleased 之前：点击可能立刻导航，事后 inject 会打到已卸载文档。
    await animateCursorTo(ctx, x, y)
    pulseCursor(ctx, 'click')
    await ctx.sendCDP('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    await ctx.sendCDP('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await ctx.sendCDP('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    return { success: true }
  }

  private async ensureCDPReady(ctx: BrowserContext): Promise<void> {
    await ctx.sendCDP('DOM.enable')
    // Runtime 域供深选择器 / 兜底路径使用；忽略重复 enable
    await ctx.sendCDP('Runtime.enable').catch(() => {})
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  private getModifierBits(): number {
    let bits = 0
    if (this.pressedModifiers.has('Alt')) bits |= 1
    if (this.pressedModifiers.has('Control')) bits |= 2
    if (this.pressedModifiers.has('Meta')) bits |= 4
    if (this.pressedModifiers.has('Shift')) bits |= 8
    return bits
  }

}

let sharedCDPHelper: CDPOperationHelper | null = null

export function getSharedCDPOperationHelper(): CDPOperationHelper {
  if (!sharedCDPHelper) {
    sharedCDPHelper = new CDPOperationHelper()
  }
  return sharedCDPHelper
}
