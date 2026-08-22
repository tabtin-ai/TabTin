/**
 * 页内 Agent 模拟指针运行时（注入字符串）。
 *
 * 算法：
 * - 短距离（≤196px）scoot 直线弹簧滑动；长距离三次贝塞尔曲线 + progress 弹簧
 * - velocity-verlet 240Hz 定步长积分；速度拉伸；到位后 1.41s 思考摆动
 * - 黑箭头 SVG + 蓝色双层 drop-shadow 光晕；点击扩散波纹
 *
 * 提供（注入后页面作用域内）：
 * - __tabtinAgentCursorEnsure()               幂等创建覆盖层
 * - __tabtinAgentCursorMoveTo(x, y) → Promise 动画到位后 resolve
 * - __tabtinAgentCursorPulse(kind)            'click' 波纹 / 'down' 缩小 / 'up' 还原
 * - __tabtinAgentCursorSet(x, y)              无动画落位
 * - __tabtinAgentCursorGlideTo(x, y, ms)      匀速直线跟随（drag 用，不阻塞）
 * - __tabtinAgentCursorHide()                 任务结束收起：拆覆盖层并清状态
 *
 * 状态挂 window.__tabtinAgentCursorState，跨注入持久；导航后由 ensure() 在
 * 默认位置 (58%, 55%) 淡入重建。任何异常不得外抛——可视化失败不能影响真实动作。
 */

export const CURSOR_RUNTIME_SNIPPET = `
  const __TABTIN_CURSOR_LAYER_ID = '__tabtin_agent_cursor__';
  const __TABTIN_CURSOR_SIZE = 24;
  const __TABTIN_CURSOR_SCOOT_MAX = 196;
  const __TABTIN_CURSOR_GLOW = '#3b82f6';
  const __TABTIN_CURSOR_DT = 1 / 240;
  const __TABTIN_CURSOR_FRAME = 1 / 60;

  function __tabtinAgentCursorClamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function __tabtinAgentCursorDist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }

  // —— 贝塞尔（法向弯曲量 clamp(dist*0.22, 24, viewport*0.18)） ——
  function __tabtinAgentCursorBuildBezier(start, end, vw, vh) {
    const dx = end.x - start.x, dy = end.y - start.y;
    const distance = __tabtinAgentCursorDist(start, end);
    if (distance < 0.001) {
      return { start, control1: start, control2: end, end, length: 0 };
    }
    const nx = -dy / distance, ny = dx / distance;
    const scale = Math.max(vw, vh);
    const bend = __tabtinAgentCursorClamp(distance * 0.22, 24, Math.max(24, scale * 0.18));
    const path = {
      start,
      control1: { x: start.x + dx * 0.34 + nx * bend, y: start.y + dy * 0.34 + ny * bend },
      control2: { x: start.x + dx * 0.68 - nx * bend * 0.55, y: start.y + dy * 0.68 - ny * bend * 0.55 },
      end,
      length: distance,
    };
    let len = 0, prev = start;
    for (let i = 1; i <= 24; i++) {
      const p = __tabtinAgentCursorCubicPoint(path, i / 24);
      len += __tabtinAgentCursorDist(prev, p);
      prev = p;
    }
    path.length = len;
    return path;
  }

  function __tabtinAgentCursorCubicPoint(path, t) {
    const u = 1 - t, u2 = u * u, t2 = t * t;
    return {
      x: u2 * u * path.start.x + 3 * u2 * t * path.control1.x + 3 * u * t2 * path.control2.x + t2 * t * path.end.x,
      y: u2 * u * path.start.y + 3 * u2 * t * path.control1.y + 3 * u * t2 * path.control2.y + t2 * t * path.end.y,
    };
  }

  function __tabtinAgentCursorSampleBezier(path, progress) {
    const t = __tabtinAgentCursorClamp(progress, 0, 1);
    const u = 1 - t;
    return {
      point: __tabtinAgentCursorCubicPoint(path, t),
      tangent: {
        x: 3 * u * u * (path.control1.x - path.start.x) + 6 * u * t * (path.control2.x - path.control1.x) + 3 * t * t * (path.end.x - path.control2.x),
        y: 3 * u * u * (path.control1.y - path.start.y) + 6 * u * t * (path.control2.y - path.control1.y) + 3 * t * t * (path.end.y - path.control2.y),
      },
    };
  }

  // —— 弹簧（velocity-verlet，240Hz 定步长；response/damping 语义同 SwiftUI spring） ——
  function __tabtinAgentCursorMakeSpring(value, target, response, damping) {
    return { value, target, velocity: 0, force: 0, response, damping, simTime: 0, scriptTime: 0 };
  }

  function __tabtinAgentCursorStepSpring(s, dt) {
    const response = Math.max(0.001, s.response);
    const maxStiffness = 1 / (2 * __TABTIN_CURSOR_DT * __TABTIN_CURSOR_DT);
    const stiffness = Math.min(Math.pow(Math.PI * 2, 2) / (response * response), maxStiffness);
    const dampingCoef = Math.sqrt(stiffness) * 2 * s.damping;
    s.scriptTime += Math.max(0, dt);
    if (s.scriptTime - s.simTime > 1) s.simTime = s.scriptTime - __TABTIN_CURSOR_FRAME;
    while (s.simTime < s.scriptTime) {
      const half = __TABTIN_CURSOR_DT / 2;
      const midV = s.velocity + s.force * half;
      s.value += midV * __TABTIN_CURSOR_DT;
      s.force = midV * -dampingCoef + (s.target - s.value) * stiffness;
      s.velocity = midV + s.force * half;
      s.simTime += __TABTIN_CURSOR_DT;
    }
    if (Math.max(s.velocity * s.velocity, s.force * s.force) < 0.0036) {
      const tol = s.target * 0.01;
      const rem = s.target - s.value;
      if (tol === 0 || rem * rem <= tol * tol) s.value = s.target;
    }
  }

  function __tabtinAgentCursorSnapSpring(s, v) {
    s.value = v; s.target = v; s.velocity = 0; s.force = 0; s.simTime = 0; s.scriptTime = 0;
  }

  // —— DOM ——
  function __tabtinAgentCursorSvg() {
    return '<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">'
      + '<path d="M5.5 3.2 L5.5 17.5 L9.1 14.4 L11.5 20.2 L14.2 19.1 L11.8 13.4 L16.6 13.1 Z"'
      + ' fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  }

  function __tabtinAgentCursorEnsure() {
    try {
      const prior = window.__tabtinAgentCursorState;
      if (prior && prior.layerEl && document.getElementById(__TABTIN_CURSOR_LAYER_ID)) return;
      const layer = document.createElement('div');
      layer.id = __TABTIN_CURSOR_LAYER_ID;
      layer.setAttribute('aria-hidden', 'true');
      layer.style.cssText = 'position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:2147483647;';
      const cursor = document.createElement('div');
      cursor.style.cssText = 'position:absolute;left:0;top:0;width:' + __TABTIN_CURSOR_SIZE + 'px;height:'
        + __TABTIN_CURSOR_SIZE + 'px;will-change:transform;opacity:0;transition:opacity 240ms ease;'
        + 'filter:drop-shadow(0 0 6px ' + __TABTIN_CURSOR_GLOW + 'e6) drop-shadow(0 0 15px ' + __TABTIN_CURSOR_GLOW + '7a);';
      cursor.innerHTML = __tabtinAgentCursorSvg();
      layer.appendChild(cursor);
      (document.documentElement || document.body).appendChild(layer);
      const x0 = Math.round((window.innerWidth || 1280) * 0.58);
      const y0 = Math.round((window.innerHeight || 720) * 0.55);
      window.__tabtinAgentCursorState = {
        layerEl: layer, cursorEl: cursor, x: x0, y: y0,
        raf: 0, moveToken: 0, rotation: 0, scale: 1, thinkStartedAt: 0,
      };
      __tabtinAgentCursorRender();
      requestAnimationFrame(function () { cursor.style.opacity = '1'; });
    } catch (_) { /* 可视化失败静默 */ }
  }

  function __tabtinAgentCursorRender() {
    try {
      const st = window.__tabtinAgentCursorState;
      if (!st || !st.cursorEl) return;
      const half = __TABTIN_CURSOR_SIZE / 2;
      st.cursorEl.style.transform = 'translate3d(' + (st.x - half).toFixed(2) + 'px,' + (st.y - half).toFixed(2)
        + 'px,0) rotate(' + (st.rotation || 0).toFixed(2) + 'deg) scale(' + (st.scale || 1).toFixed(3) + ')';
    } catch (_) { /* 静默 */ }
  }

  function __tabtinAgentCursorSet(x, y) {
    try {
      __tabtinAgentCursorEnsure();
      const st = window.__tabtinAgentCursorState;
      if (!st) return;
      st.moveToken++;
      st.x = x; st.y = y; st.rotation = 0; st.scale = 1;
      __tabtinAgentCursorRender();
    } catch (_) { /* 静默 */ }
  }

  function __tabtinAgentCursorGlideTo(x, y, durationMs) {
    try {
      __tabtinAgentCursorEnsure();
      const st = window.__tabtinAgentCursorState;
      if (!st) return;
      const token = ++st.moveToken;
      const sx = st.x, sy = st.y;
      const t0 = performance.now();
      const dur = Math.max(16, durationMs || 200);
      function frame(now) {
        try {
          if (!window.__tabtinAgentCursorState || st.moveToken !== token) return;
          const p = Math.min(1, (now - t0) / dur);
          st.x = sx + (x - sx) * p;
          st.y = sy + (y - sy) * p;
          __tabtinAgentCursorRender();
          if (p < 1) requestAnimationFrame(frame);
        } catch (_) { /* 静默 */ }
      }
      requestAnimationFrame(frame);
    } catch (_) { /* 静默 */ }
  }

  function __tabtinAgentCursorPulse(kind) {
    try {
      const st = window.__tabtinAgentCursorState;
      if (!st || !st.layerEl) return;
      if (kind === 'down') { st.scale = 0.82; __tabtinAgentCursorRender(); return; }
      if (kind === 'up') { st.scale = 1; __tabtinAgentCursorRender(); return; }
      const ripple = document.createElement('div');
      ripple.setAttribute('data-tabtin-cursor-ripple', '');
      ripple.style.cssText = 'position:absolute;width:14px;height:14px;border-radius:50%;pointer-events:none;'
        + 'border:2.5px solid ' + __TABTIN_CURSOR_GLOW + ';left:' + (st.x - 7) + 'px;top:' + (st.y - 7) + 'px;'
        + 'opacity:0.9;transform:scale(1);transition:transform 450ms ease-out, opacity 450ms ease-out;';
      st.layerEl.appendChild(ripple);
      requestAnimationFrame(function () {
        try {
          ripple.style.transform = 'scale(3.4)';
          ripple.style.opacity = '0';
        } catch (_) { /* 静默 */ }
      });
      setTimeout(function () { try { ripple.remove(); } catch (_) {} }, 520);
      st.scale = 0.82;
      __tabtinAgentCursorRender();
      setTimeout(function () {
        try {
          const cur = window.__tabtinAgentCursorState;
          if (cur) { cur.scale = 1; __tabtinAgentCursorRender(); }
        } catch (_) { /* 静默 */ }
      }, 130);
    } catch (_) { /* 静默 */ }
  }

  function __tabtinAgentCursorMoveTo(targetX, targetY) {
    return new Promise(function (resolve) {
      try {
        __tabtinAgentCursorEnsure();
        const st = window.__tabtinAgentCursorState;
        if (!st) { resolve(); return; }
        const token = ++st.moveToken;
        const start = { x: st.x, y: st.y };
        const end = {
          x: __tabtinAgentCursorClamp(targetX, 0, window.innerWidth || 1e5),
          y: __tabtinAgentCursorClamp(targetY, 0, window.innerHeight || 1e5),
        };
        const distance = __tabtinAgentCursorDist(start, end);
        if (distance < 0.5) { resolve(); return; }

        const isScoot = distance <= __TABTIN_CURSOR_SCOOT_MAX;
        const path = isScoot ? null
          : __tabtinAgentCursorBuildBezier(start, end, window.innerWidth || 1280, window.innerHeight || 720);
        const progressResponse = isScoot ? 0.19
          : __tabtinAgentCursorClamp(path.length / 1400, 0.2, 0.55);
        const progressDamping = isScoot ? 0.94 : 0.86;
        const progress = __tabtinAgentCursorMakeSpring(0, 1, progressResponse, progressDamping);
        const posX = __tabtinAgentCursorMakeSpring(start.x, start.x, 0.12, 0.9);
        const posY = __tabtinAgentCursorMakeSpring(start.y, start.y, 0.12, 0.9);
        let last = performance.now();
        const deadline = last + 4000; // 页内自兜底：4s 未到位强制落位

        function frame(now) {
          try {
            const cur = window.__tabtinAgentCursorState;
            if (!cur || cur.moveToken !== token) { resolve(); return; }
            const dt = Math.max(__TABTIN_CURSOR_FRAME, (now - last) / 1000);
            last = now;
            __tabtinAgentCursorStepSpring(progress, dt);
            const t = __tabtinAgentCursorClamp(progress.value, 0, 1);
            let px, py, tangent;
            if (isScoot) {
              px = start.x + (end.x - start.x) * t;
              py = start.y + (end.y - start.y) * t;
              tangent = { x: end.x - start.x, y: end.y - start.y };
            } else {
              const s = __tabtinAgentCursorSampleBezier(path, t);
              px = s.point.x; py = s.point.y; tangent = s.tangent;
            }
            posX.target = px; posY.target = py;
            __tabtinAgentCursorStepSpring(posX, dt);
            __tabtinAgentCursorStepSpring(posY, dt);
            const prevX = cur.x, prevY = cur.y;
            cur.x = posX.value; cur.y = posY.value;
            const speed = __tabtinAgentCursorDist({ x: prevX, y: prevY }, { x: cur.x, y: cur.y }) / dt;
            // 速度拉伸 + 沿切线小幅倾斜
            cur.scale = __tabtinAgentCursorClamp(1 - speed / 5500, 0.8, 1);
            const angle = Math.atan2(tangent.y, tangent.x) * 180 / Math.PI;
            cur.rotation = __tabtinAgentCursorClamp(angle, -25, 25) * Math.sin(Math.PI * Math.min(1, t)) * 0.35;
            __tabtinAgentCursorRender();

            const nearEnd = __tabtinAgentCursorDist({ x: cur.x, y: cur.y }, end) <= 0.85
              && Math.abs(posX.velocity) <= 12 && Math.abs(posY.velocity) <= 12;
            if ((t >= 0.999 && nearEnd) || now >= deadline) {
              cur.x = end.x; cur.y = end.y; cur.rotation = 0; cur.scale = 1;
              __tabtinAgentCursorRender();
              __tabtinAgentCursorThink(token);
              resolve();
              return;
            }
            requestAnimationFrame(frame);
          } catch (_) { resolve(); return; }
        }
        requestAnimationFrame(frame);
      } catch (_) { resolve(); }
    });
  }

  // 到位后 1.41s 思考摆动（±12.5°，0.66s 周期，正弦包络）
  function __tabtinAgentCursorThink(token) {
    try {
      const st = window.__tabtinAgentCursorState;
      if (!st) return;
      const t0 = performance.now();
      function frame(now) {
        try {
          const cur = window.__tabtinAgentCursorState;
          if (!cur || cur.moveToken !== token) return;
          const elapsed = (now - t0) / 1000;
          const p = Math.min(1, elapsed / 1.41);
          if (p >= 1) { cur.rotation = 0; __tabtinAgentCursorRender(); return; }
          const envelope = Math.sin(p * Math.PI);
          cur.rotation = Math.sin(elapsed / 0.66 * Math.PI * 2) * envelope * 12.5;
          __tabtinAgentCursorRender();
          requestAnimationFrame(frame);
        } catch (_) { /* 静默 */ }
      }
      requestAnimationFrame(frame);
    } catch (_) { /* 静默 */ }
  }

  function __tabtinAgentCursorHide() {
    try {
      const st = window.__tabtinAgentCursorState;
      if (st) st.moveToken = (st.moveToken || 0) + 1;
      const layer = document.getElementById(__TABTIN_CURSOR_LAYER_ID);
      if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
      delete window.__tabtinAgentCursorState;
    } catch (_) { /* 静默 */ }
  }
`;
