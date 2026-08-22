/**
 * 页面内滚动运行时（注入字符串）。
 *
 * 提供：
 * - `__tabtinIsScrollableEl(el)`
 * - `__tabtinResolveScrollTarget(preferredEl)`
 * - `__tabtinApplyScroll(preferredEl, intent)` → { success, code?, error?, delta?, atBoundary?, target? }
 *
 * 主滚解析：preferred → 祖先可滚 → document 可滚 → 视口内嵌套容器打分。
 * 成功条件：位移 ≥ ε，或已在目标边界。
 */

export const SCROLL_EPS = 1

/** 注入页面的滚动辅助（IIFE 内可直接调用的函数声明串）。 */
export const SCROLL_RUNTIME_SNIPPET = `
            const __TABTIN_SCROLL_EPS = ${SCROLL_EPS};

            function __tabtinOverflowAllowsScroll(style) {
              const tokens = [style.overflow, style.overflowY].join(' ');
              return /(?:^|[\\s])(?:auto|scroll|overlay)(?:$|[\\s])/.test(tokens)
                || tokens.includes('auto')
                || tokens.includes('scroll')
                || tokens.includes('overlay');
            }

            function __tabtinIsScrollableEl(el) {
              if (!el || typeof el.scrollHeight !== 'number' || typeof el.clientHeight !== 'number') return false;
              if (el.scrollHeight - el.clientHeight <= __TABTIN_SCROLL_EPS) return false;
              try {
                return __tabtinOverflowAllowsScroll(getComputedStyle(el));
              } catch (_) {
                return false;
              }
            }

            function __tabtinDocScrollMax() {
              const se = document.scrollingElement || document.documentElement;
              const height = Math.max(
                se ? se.scrollHeight : 0,
                document.body ? document.body.scrollHeight : 0,
                document.documentElement ? document.documentElement.scrollHeight : 0
              );
              return Math.max(0, height - (window.innerHeight || 0));
            }

            function __tabtinGetScrollPos(target) {
              if (!target || target.kind === 'window') {
                return window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
              }
              return target.el.scrollTop || 0;
            }

            function __tabtinGetScrollMax(target) {
              if (!target || target.kind === 'window') return __tabtinDocScrollMax();
              return Math.max(0, target.el.scrollHeight - target.el.clientHeight);
            }

            function __tabtinGetViewport(target) {
              if (!target || target.kind === 'window') return window.innerHeight || 0;
              return target.el.clientHeight || 0;
            }

            function __tabtinScrollBy(target, deltaY, behavior) {
              if (!target || target.kind === 'window') {
                window.scrollBy({ top: deltaY, behavior: behavior || 'auto' });
                return;
              }
              target.el.scrollBy({ top: deltaY, behavior: behavior || 'auto' });
            }

            function __tabtinScrollTo(target, top, behavior) {
              if (!target || target.kind === 'window') {
                window.scrollTo({ top: top, behavior: behavior || 'auto' });
                return;
              }
              target.el.scrollTo({ top: top, behavior: behavior || 'auto' });
            }

            function __tabtinResolveScrollTarget(preferredEl) {
              if (preferredEl) {
                let cur = preferredEl;
                while (cur && cur.nodeType === 1) {
                  if (__tabtinIsScrollableEl(cur)) {
                    return { kind: 'element', el: cur };
                  }
                  if (cur === document.body || cur === document.documentElement) break;
                  cur = cur.parentElement;
                }
              }

              if (__tabtinDocScrollMax() > __TABTIN_SCROLL_EPS) {
                return { kind: 'window' };
              }

              let best = null;
              let bestScore = 0;
              const vw = window.innerWidth || 0;
              const vh = window.innerHeight || 0;
              const nodes = document.querySelectorAll('*');
              for (let i = 0; i < nodes.length; i++) {
                const el = nodes[i];
                if (!__tabtinIsScrollableEl(el)) continue;
                const r = el.getBoundingClientRect();
                if (r.width < 40 || r.height < 40) continue;
                const visibleH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
                const visibleW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
                const visibleArea = visibleH * visibleW;
                if (visibleArea <= 0) continue;
                const maxScroll = el.scrollHeight - el.clientHeight;
                const score = maxScroll * visibleArea;
                if (score > bestScore) {
                  bestScore = score;
                  best = el;
                }
              }
              if (best) return { kind: 'element', el: best };
              return null;
            }

            function __tabtinAtBoundary(target, deltaY) {
              const pos = __tabtinGetScrollPos(target);
              const max = __tabtinGetScrollMax(target);
              if (deltaY > 0) return max - pos <= __TABTIN_SCROLL_EPS;
              if (deltaY < 0) return pos <= __TABTIN_SCROLL_EPS;
              return false;
            }

            async function __tabtinScrollToEndHumanLike(target) {
              const getInfo = () => ({
                current: __tabtinGetScrollPos(target),
                max: __tabtinGetScrollMax(target),
                viewport: __tabtinGetViewport(target),
              });
              const info = getInfo();
              const remainingDistance = info.max - info.current;
              if (remainingDistance < Math.max(info.viewport * 0.1, __TABTIN_SCROLL_EPS)) {
                return;
              }
              const segments = Math.min(
                Math.floor(Math.random() * 3) + 3,
                Math.max(1, Math.ceil(remainingDistance / 400))
              );
              for (let i = 0; i < segments; i++) {
                const currentInfo = getInfo();
                const remaining = currentInfo.max - currentInfo.current;
                if (remaining <= __TABTIN_SCROLL_EPS) break;
                const isLastSegment = i === segments - 1;
                const scrollDistance = isLastSegment
                  ? remaining
                  : Math.floor(remaining * (0.4 + Math.random() * 0.4));
                const shouldBackScroll = !isLastSegment && Math.random() < 0.1;
                const finalDistance = shouldBackScroll
                  ? -Math.floor(Math.random() * 100 + 50)
                  : scrollDistance;
                __tabtinScrollBy(target, finalDistance, 'auto');
                await sleep(Math.floor(Math.random() * 80) + 20);
              }
              // 收口到真正底部，避免分段误差
              __tabtinScrollTo(target, __tabtinGetScrollMax(target), 'auto');
            }

            async function __tabtinApplyScroll(preferredEl, intent) {
              const target = __tabtinResolveScrollTarget(preferredEl || null);
              if (!target) {
                return {
                  success: false,
                  code: 'no_target',
                  error: '页面上没有可滚动的区域',
                };
              }

              const before = __tabtinGetScrollPos(target);
              const max = __tabtinGetScrollMax(target);
              const targetLabel = target.kind === 'window' ? 'window' : 'element';

              if (intent && intent.kind === 'to_start') {
                if (before <= __TABTIN_SCROLL_EPS) {
                  return { success: true, delta: 0, atBoundary: true, target: targetLabel };
                }
                __tabtinScrollTo(target, 0, 'auto');
                await sleep(50);
              } else if (intent && intent.kind === 'by') {
                const deltaY = typeof intent.deltaY === 'number' ? intent.deltaY : 0;
                if (deltaY === 0) {
                  return { success: true, delta: 0, atBoundary: true, target: targetLabel };
                }
                if (__tabtinAtBoundary(target, deltaY)) {
                  return { success: true, delta: 0, atBoundary: true, target: targetLabel };
                }
                __tabtinScrollBy(target, deltaY, 'auto');
                await sleep(50);
              } else {
                // to_end（缺省）
                if (max - before <= __TABTIN_SCROLL_EPS) {
                  return { success: true, delta: 0, atBoundary: true, target: targetLabel };
                }
                await __tabtinScrollToEndHumanLike(target);
                await sleep(50);
              }

              const after = __tabtinGetScrollPos(target);
              const delta = after - before;
              if (Math.abs(delta) < __TABTIN_SCROLL_EPS) {
                // 执行后仍无位移：若已在边界则成功，否则 no_effect
                if (intent && intent.kind === 'by' && __tabtinAtBoundary(target, intent.deltaY || 0)) {
                  return { success: true, delta: 0, atBoundary: true, target: targetLabel };
                }
                if ((!intent || intent.kind === 'to_end') && max - after <= __TABTIN_SCROLL_EPS) {
                  return { success: true, delta: 0, atBoundary: true, target: targetLabel };
                }
                if (intent && intent.kind === 'to_start' && after <= __TABTIN_SCROLL_EPS) {
                  return { success: true, delta: 0, atBoundary: true, target: targetLabel };
                }
                return {
                  success: false,
                  code: 'no_effect',
                  error: '滚动未产生位移（可能滚错了容器，或页面阻止了滚动）',
                  delta: 0,
                  target: targetLabel,
                };
              }
              return { success: true, delta: delta, target: targetLabel };
            }
`
