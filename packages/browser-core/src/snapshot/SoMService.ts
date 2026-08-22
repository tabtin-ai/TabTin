/**
 * SoMService — Set-of-Mark 交互元素收集与视觉标注
 *
 * 职责：
 * - 收集页面可交互元素（按 ARIA role / tag / attribute）
 * - 在页面注入数字标号覆盖层（overlay）
 * - 截取带标注的截图后清理覆盖层
 */

import type { BrowserContext } from '../context/BrowserContext';
import { NATIVE_CONTROL_ROLE_HELPERS_SNIPPET } from '../page-scripts/native-control-role';
import { SHADOW_DOM_HELPERS_SNIPPET } from '../page-scripts/shadow-dom';

export interface SoMElement {
  id: number;
  tag: string;
  role: string;
  name: string;
  selector: string;
  bbox: { x: number; y: number; width: number; height: number };
  visible: boolean;
  interactive: boolean;
  /** DOM 元素的有意义属性（href / placeholder / type 等），供 DomIndexSerializer 使用 */
  attributes?: Record<string, string>;
  /** 原生表单控件语义（textbox / checkbox / radio / combobox / button）。 */
  controlType?: string;
  /** 仅 checkbox / radio 的选项值；普通文本框的实际值绝不采集。 */
  optionValue?: string;
  /** 仅 checkbox / radio 的选中状态。 */
  checked?: boolean;
  /** 元素在 DOM 树中的深度（相对于 body），供 DomIndexSerializer 计算缩进 */
  depth?: number;
  /** 元素所属的子 frame；主 frame 不设置。仅供 ref 后续准确回解。 */
  frameId?: string;
}

export interface SoMResult {
  elements: SoMElement[];
  screenshotBase64?: string;
}

/**
 * 采到 0 元素时的重采退避序列。SPA 在 domcontentloaded 后常有渲染空窗，
 * 导航一「完成」就观察会得到空清单（open 内嵌观察 / 紧跟的 glance 都会踩），
 * Agent 只能靠再 glance / print 自愈，白白拉长链路。空结果按此序列重采，
 * 一旦采到立即返回；真实空白页极罕见，最坏多花 ~3s。
 */
export const SOM_EMPTY_COLLECT_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 1500];

type SoMCollectResult = {
  elements: SoMElement[];
  totalCandidates: number;
  truncated: boolean;
  retryable: boolean;
};

export class SoMService {
  async collectInteractiveElements(
    ctx: BrowserContext,
    options?: { selector?: string; limit?: number },
  ): Promise<{ elements: SoMElement[]; totalCandidates: number; truncated: boolean }> {
    let result = await this.collectInteractiveElementsOnce(ctx, options);
    for (const delayMs of SOM_EMPTY_COLLECT_RETRY_DELAYS_MS) {
      if (result.elements.length > 0 && !result.retryable) {
        return this.toPublicResult(result);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (typeof ctx.isAlive === 'function' && !ctx.isAlive()) return this.toPublicResult(result);
      result = await this.collectInteractiveElementsOnce(ctx, options);
    }
    return this.toPublicResult(result);
  }

  private toPublicResult({ retryable: _retryable, ...result }: SoMCollectResult) {
    return result;
  }

  private async collectInteractiveElementsOnce(
    ctx: BrowserContext,
    options?: { selector?: string; limit?: number },
  ): Promise<SoMCollectResult> {
    // 默认无上限：不传 limit 即收集全部交互元素，避免有损截断（丢掉的元素
    // Agent 永远看不到也不知情）。需要限量的调用方可显式传 limit。
    const limit = options?.limit ?? Number.POSITIVE_INFINITY;
    const scopeSelector = options?.selector || null;

    const script = `
      (() => {
        ${SHADOW_DOM_HELPERS_SNIPPET}
        ${NATIVE_CONTROL_ROLE_HELPERS_SNIPPET}
        const scopeRoot = ${scopeSelector ? `__tabtinDeepQuery(${JSON.stringify(scopeSelector)})` : 'document'};
        if (!scopeRoot) return [];

        const interactiveSelectors = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [role="slider"], [role="textbox"], [role="searchbox"], [role="listbox"], [role="spinbutton"], [onclick], [tabindex]:not([tabindex="-1"])';
        // ：候选采集穿透 open shadow DOM——按根（document + 递归 shadowRoot）逐一
        // 采集。每个根内先走选择器候选、再补扫 JS 挂载 onclick property 的候选（hover
        // 顶导 / 自绘按钮无 [onclick] attribute，属性选择器抓不到）；无 shadow 的页面
        // 根列表只有 document，候选顺序与旧版完全一致。
        const candidates = [];
        const candidateSet = new Set();
        for (const root of __tabtinCollectShadowRoots(scopeRoot)) {
          for (const el of root.querySelectorAll(interactiveSelectors)) {
            if (!candidateSet.has(el)) { candidateSet.add(el); candidates.push(el); }
          }
          for (const el of root.querySelectorAll('*')) {
            if (typeof el.onclick === 'function' && !candidateSet.has(el)) {
              candidateSet.add(el);
              candidates.push(el);
            }
          }
        }
        const limit = ${limit};
        const results = [];

        // ：selector 必须在 document 级唯一可解析——act 端 querySelector 只取第一个匹配，
        // 弱 selector（如 'div > a'）会命中错误元素并烧满超时。快捷属性 selector 先验唯一性，
        // 不唯一则落到绝对 xpath（与 snapshot 管线 backendId→xpath 同格式：小写 tag、同名兄弟从 1 计）。
        const uniqueOrNull = (sel) => {
          try { return document.querySelectorAll(sel).length === 1 ? sel : null; } catch (e) { return null; }
        };
        // ：类名常是无文本控件（图标翻页/加载更多）唯一的语义线索，采集给 Agent 判读与定位。
        // 过滤明显机器生成的噪声 token（过长 / 含 hash 段），限量防撑爆输出。
        const readableClasses = (el) => {
          const out = [];
          for (const cls of el.classList) {
            if (cls.length > 40) continue;
            if (/[0-9a-f]{8,}/i.test(cls)) continue;
            out.push(cls);
            if (out.length >= 5) break;
          }
          return out;
        };
        const buildXPath = (el) => {
          const parts = [];
          let node = el;
          while (node && node.nodeType === 1) {
            const t = node.tagName.toLowerCase();
            let idx = 1;
            let sib = node.previousElementSibling;
            while (sib) { if (sib.tagName === node.tagName) idx++; sib = sib.previousElementSibling; }
            parts.unshift(t + '[' + idx + ']');
            node = node.parentElement;
          }
          return '/' + parts.join('/');
        };
        const textExcludingFormControls = (node) => {
          if (!node || node.nodeType !== 1) return '';
          const tag = node.tagName.toLowerCase();
          if (['input', 'textarea', 'select', 'button', 'output'].includes(tag)) return '';
          const copy = node.cloneNode(true);
          if (copy && copy.querySelectorAll) {
            copy.querySelectorAll('input, textarea, select, button, output').forEach((control) => control.remove());
          }
          return (copy.textContent || '').trim();
        };
        const associatedLabelText = (el) => {
          const labelledBy = el.getAttribute('aria-labelledby');
          if (labelledBy) {
            const text = labelledBy.split(/\\s+/)
              .map((id) => textExcludingFormControls(document.getElementById(id)))
              .join(' ')
              .trim();
            if (text) return text;
          }
          if (el.labels && el.labels.length > 0) {
            const text = Array.from(el.labels)
              .map((label) => textExcludingFormControls(label))
              .join(' ')
              .trim();
            if (text) return text;
          }
          return textExcludingFormControls(el.closest('label'));
        };

        for (const el of candidates) {
          if (results.length >= limit) break;

          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;

          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

          const tag = el.tagName.toLowerCase();
          const controlType = __tabtinNativeControlRole(el);
          const role = controlType || el.getAttribute('role') || '';
          const name = el.getAttribute('aria-label')
            || associatedLabelText(el)
            || el.getAttribute('title')
            || el.getAttribute('placeholder')
            || el.getAttribute('data-testid')
            || (tag === 'textarea' ? '' : (el.textContent || '').trim().slice(0, 80))
            || '';
          const isCheckable = controlType === 'checkbox' || controlType === 'radio';

          let selector = '';
          // ：shadow 内元素必须用深选择器；light xpath/querySelector 无法回解
          const deepSel = __tabtinBuildDeepSelector(el);
          if (deepSel) {
            selector = deepSel;
          } else {
            if (el.id) {
              selector = uniqueOrNull('#' + CSS.escape(el.id)) || '';
            }
            if (!selector && el.name && tag !== 'div' && tag !== 'span') {
              selector = uniqueOrNull(tag + '[name=' + JSON.stringify(el.name) + ']') || '';
            }
            if (!selector && el.getAttribute('data-testid')) {
              selector = uniqueOrNull('[data-testid=' + JSON.stringify(el.getAttribute('data-testid')) + ']') || '';
            }
            if (!selector && el.getAttribute('aria-label')) {
              selector = uniqueOrNull(tag + '[aria-label=' + JSON.stringify(el.getAttribute('aria-label')) + ']') || '';
            }
            const classes = readableClasses(el);
            // ：落绝对 xpath 之前先试 tag.class 组合（同  唯一性验证）——
            // 比 xpath 可读且对 DOM 结构变动更稳。
            if (!selector && classes.length > 0) {
              selector = uniqueOrNull(tag + classes.map((c) => '.' + CSS.escape(c)).join('')) || '';
            }
            if (!selector) {
              selector = 'xpath=' + buildXPath(el);
            }
          }

          var attributes = {};
          const classes = readableClasses(el);
          if (classes.length > 0) attributes.class = classes.join(' ');
          if (el.href) attributes.href = String(el.href);
          if (el.placeholder) attributes.placeholder = el.placeholder;
          if ((tag === 'input' || tag === 'button') && el.type) attributes.type = el.type;
          if (el.getAttribute('aria-expanded')) attributes['aria-expanded'] = el.getAttribute('aria-expanded');
          if (el.getAttribute('aria-selected')) attributes['aria-selected'] = el.getAttribute('aria-selected');
          if (el.disabled) attributes.disabled = 'true';

          var depth = 0;
          var ancestor = el.parentElement;
          while (ancestor && ancestor !== document.documentElement && depth < 20) {
            depth++;
            ancestor = ancestor.parentElement;
          }

          results.push({
            id: results.length + 1,
            tag,
            role,
            name,
            selector,
            bbox: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
            visible: rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0,
            interactive: true,
            attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
            controlType: controlType || undefined,
            ...(isCheckable ? { optionValue: String(el.value), checked: Boolean(el.checked) } : {}),
            depth
          });
        }

        return { elements: results, totalCandidates: candidates.length };
      })();
    `;

    const collectFrame = async (frameId?: string) => {
      const raw = frameId
        ? await ctx.executeScript<{ elements: SoMElement[]; totalCandidates: number }>(script, frameId)
        : await ctx.executeScript<{ elements: SoMElement[]; totalCandidates: number }>(script);
      if (raw && Array.isArray(raw.elements)) {
        const total = raw.totalCandidates ?? raw.elements.length;
        return { elements: raw.elements, totalCandidates: total };
      }
      const arr = Array.isArray(raw) ? (raw as unknown as SoMElement[]) : [];
      return { elements: arr, totalCandidates: arr.length };
    };

    let childFrameIds: string[] = [];
    let retryable = false;
    try {
      childFrameIds = ctx.listChildFrameIds?.() ?? [];
    } catch (error) {
      console.error('[SoMService] listChildFrameIds failed:', error);
    }
    const frameIds: Array<string | undefined> = [undefined, ...childFrameIds];
    const merged: SoMElement[] = [];
    let totalCandidates = 0;

    for (const frameId of frameIds) {
      try {
        const result = await collectFrame(frameId);
        if (frameId && result.elements.length === 0) retryable = true;
        totalCandidates += result.totalCandidates;
        for (const entry of result.elements) {
          merged.push({
            ...entry,
            ...(frameId ? { frameId } : {}),
          });
        }
      } catch (error) {
        console.error(
          `[SoMService] collectInteractiveElements failed${frameId ? ` in frame ${frameId}` : ''}:`,
          error,
        );
      }
    }

    const elements = merged
      .slice(0, limit)
      .map((entry, index) => ({ ...entry, id: index + 1 }));
    return {
      elements,
      totalCandidates,
      truncated: elements.length < totalCandidates,
      retryable,
    };
  }

  async injectOverlay(
    ctx: BrowserContext,
    elements: Array<{ id: number; bbox: { x: number; y: number } }>,
    options?: { fullPage?: boolean },
  ): Promise<void> {
    const markData = JSON.stringify(elements.map((e) => ({ id: e.id, x: e.bbox.x, y: e.bbox.y })));
    const fullPage = !!options?.fullPage;

    const script = `
      (() => {
        const existing = document.getElementById('__tabtin_som_overlay__');
        if (existing) existing.remove();
        const overlay = document.createElement('div');
        overlay.id = '__tabtin_som_overlay__';
        const fullPage = ${fullPage};
        if (fullPage) {
          const docW = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
          const docH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
          overlay.style.cssText = 'position:absolute;top:0;left:0;width:' + docW + 'px;height:' + docH + 'px;pointer-events:none;z-index:2147483647';
        } else {
          overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647';
        }
        const sx = fullPage ? window.scrollX : 0;
        const sy = fullPage ? window.scrollY : 0;
        const marks = ${markData};
        for (const m of marks) {
          const d = document.createElement('div');
          d.style.cssText = 'position:absolute;left:' + (m.x + sx) + 'px;top:' + (m.y + sy) + 'px;background:rgba(255,0,0,0.85);color:#fff;font-size:10px;font-weight:bold;padding:1px 3px;border-radius:2px;line-height:1;z-index:2147483647;font-family:monospace';
          d.textContent = String(m.id);
          overlay.appendChild(d);
        }
        document.body.appendChild(overlay);
      })();
    `;

    await ctx.executeScript(script);
  }

  async removeOverlay(ctx: BrowserContext): Promise<void> {
    await ctx.executeScript(
      `document.getElementById('__tabtin_som_overlay__')?.remove();`,
    );
  }

  async captureAnnotated(
    ctx: BrowserContext,
    options?: { selector?: string; limit?: number; fullPage?: boolean; width?: number },
  ): Promise<SoMResult> {
    const { elements } = await this.collectInteractiveElements(ctx, options);
    if (elements.length === 0) return { elements };

    let screenshotBase64: string | undefined;
    try {
      await this.injectOverlay(
        ctx,
        elements.filter((element) => !element.frameId),
        { fullPage: options?.fullPage },
      );
      await new Promise((r) => setTimeout(r, 100));

      const buffer = await ctx.captureScreenshot({
        fullPage: options?.fullPage,
        width: options?.width ?? 1280,
        format: 'jpeg',
        quality: 70,
      });
      screenshotBase64 = buffer.toString('base64');
    } catch (err) {
      console.error('[SoMService] annotated screenshot failed:', err);
    } finally {
      try { await this.removeOverlay(ctx); } catch { /* ignore */ }
    }

    return { elements, screenshotBase64 };
  }
}

let shared: SoMService | null = null;

export function getSharedSoMService(): SoMService {
  if (!shared) shared = new SoMService();
  return shared;
}
