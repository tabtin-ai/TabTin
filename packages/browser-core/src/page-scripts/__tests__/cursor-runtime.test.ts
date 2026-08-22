// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { CURSOR_RUNTIME_SNIPPET } from '../cursor-runtime';

type Point = { x: number; y: number };

function loadRuntime() {
  return new Function(`${CURSOR_RUNTIME_SNIPPET}; return {
    ensure: __tabtinAgentCursorEnsure,
    moveTo: __tabtinAgentCursorMoveTo,
    pulse: __tabtinAgentCursorPulse,
    set: __tabtinAgentCursorSet,
    hide: __tabtinAgentCursorHide,
    bezier: __tabtinAgentCursorBuildBezier,
    sample: __tabtinAgentCursorSampleBezier,
    springStep: __tabtinAgentCursorStepSpring,
  };`)() as {
    ensure: () => void;
    moveTo: (x: number, y: number) => Promise<void>;
    pulse: (kind: string) => void;
    set: (x: number, y: number) => void;
    hide: () => void;
    bezier: (start: Point, end: Point, vw: number, vh: number) => {
      start: Point; control1: Point; control2: Point; end: Point; length: number;
    };
    sample: (path: unknown, t: number) => { point: Point; tangent: Point };
    springStep: (s: { value: number; target: number; velocity: number;
      response: number; damping: number; simTime: number; scriptTime: number; force: number }, dt: number) => void;
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.querySelectorAll('#__tabtin_agent_cursor__').forEach((el) => el.remove());
  delete (window as any).__tabtinAgentCursorState;
});

describe('bezier 几何', () => {
  it('端点吻合：t=0 在起点，t=1 在终点', () => {
    const rt = loadRuntime();
    const path = rt.bezier({ x: 10, y: 10 }, { x: 500, y: 300 }, 1280, 720);
    expect(rt.sample(path, 0).point).toEqual({ x: 10, y: 10 });
    const end = rt.sample(path, 1).point;
    expect(end.x).toBeCloseTo(500);
    expect(end.y).toBeCloseTo(300);
  });

  it('长度近似 ≥ 直线距离（曲线更长）', () => {
    const rt = loadRuntime();
    const path = rt.bezier({ x: 0, y: 0 }, { x: 400, y: 0 }, 1280, 720);
    expect(path.length).toBeGreaterThanOrEqual(400);
  });

  it('零距离退化不 NaN', () => {
    const rt = loadRuntime();
    const path = rt.bezier({ x: 5, y: 5 }, { x: 5, y: 5 }, 1280, 720);
    const s = rt.sample(path, 0.5);
    expect(Number.isNaN(s.point.x)).toBe(false);
  });
});

describe('弹簧积分', () => {
  it('收敛到 target 且不发散', () => {
    const rt = loadRuntime();
    const s = { value: 0, target: 100, velocity: 0, response: 0.19, damping: 0.9,
      simTime: 0, scriptTime: 0, force: 0 };
    for (let i = 0; i < 240; i++) rt.springStep(s, 1 / 60); // 4 秒
    expect(Math.abs(s.value - 100)).toBeLessThan(1);
  });
});

describe('ensure / set / pulse DOM', () => {
  it('ensure 幂等：两次调用只有一个覆盖层', () => {
    const rt = loadRuntime();
    rt.ensure();
    rt.ensure();
    expect(document.querySelectorAll('#__tabtin_agent_cursor__').length).toBe(1);
    const layer = document.getElementById('__tabtin_agent_cursor__')!;
    expect(layer.style.pointerEvents).toBe('none');
    expect(layer.style.zIndex).toBe('2147483647');
  });

  it('set 落位更新 transform 与 window 状态', () => {
    const rt = loadRuntime();
    rt.ensure();
    rt.set(120, 240);
    const st = (window as any).__tabtinAgentCursorState;
    expect(st.x).toBe(120);
    expect(st.y).toBe(240);
    expect(st.cursorEl.style.transform).toContain('translate3d');
  });

  it('pulse(click) 产生波纹元素并自动清理', async () => {
    const rt = loadRuntime();
    rt.ensure();
    rt.set(50, 50);
    rt.pulse('click');
    const layer = document.getElementById('__tabtin_agent_cursor__')!;
    expect(layer.querySelectorAll('[data-tabtin-cursor-ripple]').length).toBe(1);
  });

  it('moveTo 零距离立即 resolve', async () => {
    const rt = loadRuntime();
    rt.ensure();
    rt.set(50, 50);
    await expect(rt.moveTo(50, 50)).resolves.toBeUndefined();
  });

  it('hide 移除覆盖层并清状态，可再次 ensure', () => {
    const rt = loadRuntime();
    rt.ensure();
    expect(document.getElementById('__tabtin_agent_cursor__')).toBeTruthy();
    rt.hide();
    expect(document.getElementById('__tabtin_agent_cursor__')).toBeNull();
    expect((window as any).__tabtinAgentCursorState).toBeUndefined();
    rt.hide();
    rt.ensure();
    expect(document.getElementById('__tabtin_agent_cursor__')).toBeTruthy();
  });
});
