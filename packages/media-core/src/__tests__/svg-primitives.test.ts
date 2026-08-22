import { describe, it, expect } from 'vitest';
import {
  n,
  escXml,
  hexToRgba,
  roundedRectPath,
  emptySvg,
  sanitizeSvgContent,
} from '../svg/primitives';

// ---------------------------------------------------------------------------
// n — 数值格式化
// ---------------------------------------------------------------------------

describe('n — 数值格式化', () => {
  it('整数不带小数点', () => {
    expect(n(42)).toBe('42');
    expect(n(0)).toBe('0');
    expect(n(-7)).toBe('-7');
  });

  it('浮点数最多 4 位小数，去尾零', () => {
    expect(n(1.5)).toBe('1.5');
    expect(n(3.14159265)).toBe('3.1416');
    expect(n(0.10000)).toBe('0.1');
  });

  it('极小值保留精度', () => {
    expect(n(0.0001)).toBe('0.0001');
    expect(n(0.00001)).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// escXml — XML 转义
// ---------------------------------------------------------------------------

describe('escXml — XML 转义', () => {
  it('转义 & < > " \'', () => {
    expect(escXml('a & b')).toBe('a &amp; b');
    expect(escXml('<tag>')).toBe('&lt;tag&gt;');
    expect(escXml('"quoted"')).toBe('&quot;quoted&quot;');
    expect(escXml("it's")).toBe('it&apos;s');
  });

  it('无特殊字符时原样返回', () => {
    expect(escXml('hello world')).toBe('hello world');
  });

  it('处理多个特殊字符', () => {
    expect(escXml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });
});

// ---------------------------------------------------------------------------
// hexToRgba — 颜色转换
// ---------------------------------------------------------------------------

describe('hexToRgba — 颜色转换', () => {
  it('6 位 hex 转换', () => {
    expect(hexToRgba('#ff0000', 1)).toBe('rgba(255,0,0,1)');
    expect(hexToRgba('#00ff00', 0.5)).toBe('rgba(0,255,0,0.5)');
  });

  it('3 位 hex 转换', () => {
    expect(hexToRgba('#f00', 1)).toBe('rgba(255,0,0,1)');
    expect(hexToRgba('#0f0', 0.8)).toBe('rgba(0,255,0,0.8)');
  });

  it('不带 # 也行', () => {
    expect(hexToRgba('0000ff', 1)).toBe('rgba(0,0,255,1)');
  });
});

// ---------------------------------------------------------------------------
// roundedRectPath — 圆角矩形路径
// ---------------------------------------------------------------------------

describe('roundedRectPath — 圆角矩形路径', () => {
  it('全部圆角为 0 时生成矩形', () => {
    const d = roundedRectPath(0, 0, 100, 50, 0, 0, 0, 0);
    expect(d).toContain('M 0 0');
    expect(d).toContain('L 100 0');
    expect(d).toContain('L 100 50');
    expect(d).toContain('L 0 50');
    expect(d).toContain('Z');
    expect(d).not.toContain('A'); // 无弧线
  });

  it('有圆角时包含弧线指令', () => {
    const d = roundedRectPath(0, 0, 100, 50, 10, 10, 10, 10);
    expect(d).toContain('A');
  });

  it('圆角不超过 min(w,h)/2', () => {
    // 50x20 的矩形，maxR = 10
    const d = roundedRectPath(0, 0, 50, 20, 100, 100, 100, 100);
    expect(d).toContain('A 10 10');
  });
});

// ---------------------------------------------------------------------------
// emptySvg — 空 SVG
// ---------------------------------------------------------------------------

describe('emptySvg — 空 SVG', () => {
  it('生成正确尺寸', () => {
    const svg = emptySvg(100, 50, 2);
    expect(svg).toContain('width="200"');
    expect(svg).toContain('height="100"');
    expect(svg).toContain('viewBox="0 0 100 50"');
  });

  it('包含 XML 声明和 SVG 命名空间', () => {
    const svg = emptySvg(10, 10, 1);
    expect(svg).toContain('<?xml');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });
});

// ---------------------------------------------------------------------------
// sanitizeSvgContent — SVG 安全清洗
// ---------------------------------------------------------------------------

describe('sanitizeSvgContent — SVG 安全清洗', () => {
  it('移除 <script> 标签', () => {
    expect(sanitizeSvgContent('<script>alert(1)</script>')).toBe('alert(1)');
  });

  it('移除 <iframe> 标签', () => {
    expect(sanitizeSvgContent('<iframe src="evil.com"></iframe>')).toBe('');
  });

  it('移除 <object>/<embed>/<applet> 标签', () => {
    expect(sanitizeSvgContent('<object data="x"></object>')).toBe('');
    expect(sanitizeSvgContent('<embed src="x"/>')).toBe('');
  });

  it('移除事件处理器', () => {
    const input = '<rect onclick="alert(1)" width="10"/>';
    const result = sanitizeSvgContent(input);
    expect(result).not.toContain('onclick');
  });

  it('移除 javascript: 协议', () => {
    const input = '<a href="javascript:alert(1)">click</a>';
    const result = sanitizeSvgContent(input);
    expect(result).not.toContain('javascript:');
  });

  it('移除外部 <use> 引用', () => {
    const input = '<use href="http://evil.com/sprite.svg#icon"/>';
    const result = sanitizeSvgContent(input);
    expect(result).not.toContain('<use');
  });

  it('保留本地 <use> 引用', () => {
    const input = '<use href="#my-icon"/>';
    const result = sanitizeSvgContent(input);
    expect(result).toContain('<use');
  });

  it('安全 SVG 内容不被修改', () => {
    const safe = '<rect x="0" y="0" width="100" height="50" fill="red"/>';
    expect(sanitizeSvgContent(safe)).toBe(safe);
  });
});
