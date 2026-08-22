/**
 * RefMap 语义指纹（BW-1 / B5）—— role + name + nth 三元组，供 xpath/selector 失效时重定位。
 *
 * electron-free 纯逻辑 + 可注入页面的 relocate 脚本生成；不依赖 CDP / Playwright。
 */

import { SHADOW_DOM_HELPERS_SNIPPET } from '../page-scripts/shadow-dom';
import { NATIVE_CONTROL_ROLE_HELPERS_SNIPPET } from '../page-scripts/native-control-role';

/** 与 agent-browser RefMap 对齐的语义指纹。nth 为 0-based，在同 role+name 候选中的序号。 */
export interface SemanticFingerprint {
  role: string;
  name: string;
  nth: number;
}

const SEMANTIC_NAME_MAX_LENGTH = 60;

const TAG_TO_DEFAULT_ROLE: Record<string, string> = {
  a: 'link',
  button: 'button',
  input: 'textbox',
  select: 'combobox',
  textarea: 'textbox',
};

export function semanticKey(role: string, name: string): string {
  return `${role}\0${name}`;
}

export function normalizeSemanticName(name: string | undefined): string {
  return (name ?? '').trim().slice(0, SEMANTIC_NAME_MAX_LENGTH);
}

/** 从 compact / observe 元素推断用于指纹的 a11y role。 */
export function effectiveSemanticRole(role: string | undefined, tag: string): string {
  if (role && role.trim()) return role.trim();
  return TAG_TO_DEFAULT_ROLE[tag] ?? tag;
}

/** 为有序元素列表分配 role/name/nth（与 snapshot 元素顺序一致）。 */
export function assignSemanticFingerprints(
  elements: ReadonlyArray<{ role?: string; name: string; tag: string }>,
): SemanticFingerprint[] {
  const counts = new Map<string, number>();
  return elements.map((el) => {
    const role = effectiveSemanticRole(el.role, el.tag);
    const name = normalizeSemanticName(el.name);
    const key = semanticKey(role, name);
    const nth = counts.get(key) ?? 0;
    counts.set(key, nth + 1);
    return { role, name, nth };
  });
}

export function formatSemanticFingerprint(fp: SemanticFingerprint): string {
  const namePart = fp.name ? `"${fp.name}"` : '(unnamed)';
  return `role=${fp.role} name=${namePart} nth=${fp.nth}`;
}

export function formatSemanticRelocateFailure(
  ref: string | undefined,
  fp: SemanticFingerprint,
  detail?: string,
): string {
  const refPart = ref ? `ref ${ref}: ` : '';
  const suffix = detail ? ` — ${detail}` : ' — 页面上无匹配元素';
  return `语义重定位失败：${refPart}${formatSemanticFingerprint(fp)}${suffix}`;
}

/** xpath / selector / backend 句柄失效时可尝试语义重定位的错误信号。 */
export function isStaleLocatorError(code: string | undefined, message?: string): boolean {
  const normalizedCode = (code || '').toLowerCase();
  if (normalizedCode === 'element_not_found') {
    return true;
  }

  const normalizedMessage = (message || '').toLowerCase();
  if (normalizedCode === 'cdp_error') {
    return (
      normalizedMessage.includes('element not found') ||
      normalizedMessage.includes('not found or not visible')
    );
  }

  return false;
}

/**
 * 生成在页面内按语义指纹扫描可交互元素并返回新 selector 的脚本。
 * 返回 `{ success, selector?, error?, code? }`。
 */
export function buildSemanticRelocateScript(fp: SemanticFingerprint): string {
  const payload = JSON.stringify(fp);
  return `
    (() => {
      ${SHADOW_DOM_HELPERS_SNIPPET}
      ${NATIVE_CONTROL_ROLE_HELPERS_SNIPPET}
      const fp = ${payload};
      const SEMANTIC_NAME_MAX_LENGTH = ${SEMANTIC_NAME_MAX_LENGTH};

      const interactiveSelectors = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [role="slider"], [role="textbox"], [role="searchbox"], [role="listbox"], [role="spinbutton"], [onclick], [tabindex]:not([tabindex="-1"])';

      function inferRole(el) {
        const nativeRole = __tabtinNativeControlRole(el);
        if (nativeRole) return nativeRole;
        const tag = el.tagName.toLowerCase();
        const explicit = (el.getAttribute('role') || '').trim();
        if (explicit) return explicit;
        if (tag === 'a') return 'link';
        return tag;
      }

      function textExcludingFormControls(node) {
        if (!node || node.nodeType !== 1) return '';
        const tag = node.tagName.toLowerCase();
        if (['input', 'textarea', 'select', 'button', 'output'].includes(tag)) return '';
        const copy = node.cloneNode(true);
        if (copy && copy.querySelectorAll) {
          copy.querySelectorAll('input, textarea, select, button, output').forEach((control) => control.remove());
        }
        return (copy.textContent || '').trim();
      }

      function associatedLabelText(el) {
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
      }

      function extractName(el) {
        const tag = el.tagName.toLowerCase();
        const raw = (
          el.getAttribute('aria-label')
          || associatedLabelText(el)
          || el.getAttribute('title')
          || el.getAttribute('placeholder')
          || el.getAttribute('data-testid')
          || (tag === 'textarea' ? '' : el.textContent)
          || ''
        );
        return raw.trim().slice(0, SEMANTIC_NAME_MAX_LENGTH);
      }

      function roleMatches(el, targetRole) {
        return inferRole(el) === targetRole;
      }

      function isVisible(el) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (parseFloat(style.opacity) === 0) return false;
        // 重定位阶段只排除明确 hidden；尺寸为 0 的节点留给 act 层 waitForVisible 再判。
        return true;
      }

      // 与 SoMService  同口径：CSS 必须 document 级唯一可解析；
      // 禁止无校验的「父 tag > 子 tag」（如 li > button）——act 端多匹配会点到第一个。
      function uniqueOrNull(sel) {
        try {
          return document.querySelectorAll(sel).length === 1 ? sel : null;
        } catch (e) {
          return null;
        }
      }

      function readableClasses(el) {
        const out = [];
        for (const cls of el.classList) {
          if (cls.length > 40) continue;
          if (/[0-9a-f]{8,}/i.test(cls)) continue;
          out.push(cls);
          if (out.length >= 5) break;
        }
        return out;
      }

      function buildXPath(el) {
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1) {
          const t = node.tagName.toLowerCase();
          let idx = 1;
          let sib = node.previousElementSibling;
          while (sib) {
            if (sib.tagName === node.tagName) idx++;
            sib = sib.previousElementSibling;
          }
          parts.unshift(t + '[' + idx + ']');
          node = node.parentElement;
        }
        return '/' + parts.join('/');
      }

      function buildSelector(el) {
        const deep = __tabtinBuildDeepSelector(el);
        if (deep) return deep;

        const tag = el.tagName.toLowerCase();
        let selector = '';
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
        if (!selector && classes.length > 0) {
          selector = uniqueOrNull(tag + classes.map((c) => '.' + CSS.escape(c)).join('')) || '';
        }
        if (!selector) {
          selector = 'xpath=' + buildXPath(el);
        }
        return selector;
      }

      // 与 observe 采集同口径：JS 挂载 onclick property（无 [onclick] attribute）的
      // hover 顶导 / 自绘按钮也纳入扫描，否则 observe 采得到、act --ref 却重定位不到。
      const candidateNodes = [];
      const candidateSet = new Set();
      for (const root of __tabtinCollectShadowRoots(document)) {
        for (const el of root.querySelectorAll(interactiveSelectors)) {
          if (!candidateSet.has(el)) { candidateSet.add(el); candidateNodes.push(el); }
        }
        for (const el of root.querySelectorAll('*')) {
          if (typeof el.onclick === 'function' && !candidateSet.has(el)) {
            candidateSet.add(el);
            candidateNodes.push(el);
          }
        }
      }
      const candidates = candidateNodes.filter((el) => {
        if (!isVisible(el)) return false;
        if (!roleMatches(el, fp.role)) return false;
        return extractName(el) === fp.name;
      });

      if (candidates.length === 0) {
        return {
          success: false,
          code: 'ref_semantic_relocate_failed',
          error: 'no matching interactive element for semantic fingerprint',
        };
      }

      if (fp.nth < 0 || fp.nth >= candidates.length) {
        return {
          success: false,
          code: 'ref_semantic_relocate_failed',
          error: 'semantic nth out of range: found ' + candidates.length + ' candidate(s)',
        };
      }

      const target = candidates[fp.nth];
      return { success: true, selector: buildSelector(target) };
    })();
  `;
}
