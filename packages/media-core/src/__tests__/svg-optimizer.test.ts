import { describe, it, expect } from 'vitest';
import { optimizeSvg } from '../svg/optimizer.js';

describe('SVG 优化器 (SVG Optimizer)', () => {
  describe('移除 XML 声明', () => {
    it('removeXmlDecl=true 时移除 XML 声明', () => {
      const input = '<?xml version="1.0" encoding="UTF-8"?>\n<svg></svg>';
      const result = optimizeSvg(input, { removeXmlDecl: true });
      expect(result).not.toContain('<?xml');
      expect(result).toContain('<svg>');
    });

    it('removeXmlDecl=false（默认）时保留 XML 声明', () => {
      const input = '<?xml version="1.0" encoding="UTF-8"?>\n<svg></svg>';
      const result = optimizeSvg(input);
      expect(result).toContain('<?xml');
    });
  });

  describe('移除注释', () => {
    it('默认移除 HTML 注释', () => {
      const input = '<svg><!-- This is a comment --><rect/></svg>';
      const result = optimizeSvg(input);
      expect(result).not.toContain('<!--');
      expect(result).toContain('<rect/>');
    });

    it('removeComments=false 时保留注释', () => {
      const input = '<svg><!-- keep me --><rect/></svg>';
      const result = optimizeSvg(input, { removeComments: false });
      expect(result).toContain('<!-- keep me -->');
    });

    it('移除多行注释', () => {
      const input = '<svg>\n<!--\n  Multi\n  line\n  comment\n-->\n<rect/></svg>';
      const result = optimizeSvg(input);
      expect(result).not.toContain('Multi');
      expect(result).not.toContain('comment');
    });
  });

  describe('移除空元素', () => {
    it('移除空的 <defs></defs>', () => {
      const input = '<svg><defs></defs><rect/></svg>';
      const result = optimizeSvg(input);
      expect(result).not.toContain('<defs>');
      expect(result).toContain('<rect/>');
    });

    it('移除自闭合 <defs/>', () => {
      const input = '<svg><defs/><rect/></svg>';
      const result = optimizeSvg(input);
      expect(result).not.toContain('<defs/>');
    });

    it('移除空的 <g></g> 元素', () => {
      const input = '<svg><g></g><rect/></svg>';
      const result = optimizeSvg(input);
      expect(result).not.toContain('<g>');
      expect(result).toContain('<rect/>');
    });

    it('移除带属性的空 <g> 元素', () => {
      const input = '<svg><g id="empty" class="group"></g><rect/></svg>';
      const result = optimizeSvg(input);
      expect(result).not.toContain('<g ');
    });

    it('递归移除嵌套的空 <g> 元素', () => {
      const input = '<svg><g><g></g></g><rect/></svg>';
      const result = optimizeSvg(input);
      expect(result).not.toContain('<g>');
      expect(result).not.toContain('</g>');
    });

    it('移除空 path 元素（d=""）', () => {
      const input = '<svg><path d="" fill="red"/><rect/></svg>';
      const result = optimizeSvg(input);
      expect(result).not.toContain('<path');
    });
  });

  describe('移除默认冗余属性', () => {
    it('移除 fill-opacity="1"', () => {
      const input = '<svg><rect fill-opacity="1" width="10"/></svg>';
      const result = optimizeSvg(input);
      expect(result).not.toContain('fill-opacity="1"');
      expect(result).toContain('width="10"');
    });

    it('移除 stroke-opacity="1"', () => {
      const input = '<svg><rect stroke-opacity="1"/></svg>';
      const result = optimizeSvg(input);
      expect(result).not.toContain('stroke-opacity="1"');
    });

    it('移除 opacity="1"', () => {
      const input = '<svg><rect opacity="1"/></svg>';
      const result = optimizeSvg(input);
      expect(result).not.toContain('opacity="1"');
    });

    it('保留非默认的 opacity 值', () => {
      const input = '<svg><rect opacity="0.5"/></svg>';
      const result = optimizeSvg(input);
      expect(result).toContain('opacity="0.5"');
    });
  });

  describe('数值精度裁剪', () => {
    it('裁剪超长小数到默认 3 位', () => {
      const input = '<svg><rect x="12.123456789"/></svg>';
      const result = optimizeSvg(input);
      expect(result).toContain('12.123');
      expect(result).not.toContain('12.123456789');
    });

    it('自定义 precision 为 2', () => {
      const input = '<svg><rect x="12.123456"/></svg>';
      const result = optimizeSvg(input, { precision: 2 });
      expect(result).toContain('12.12');
    });

    it('不影响短小数', () => {
      const input = '<svg><rect x="12.5"/></svg>';
      const result = optimizeSvg(input);
      expect(result).toContain('12.5');
    });
  });

  describe('空白压缩', () => {
    it('压缩标签间多余空白', () => {
      const input = '<svg>    <rect/>    <circle/></svg>';
      const result = optimizeSvg(input);
      // 多余空白被压缩为换行
      expect(result).not.toMatch(/>\s{2,}</);
    });

    it('移除行尾空白', () => {
      const input = '<svg>  \n<rect/>  \n</svg>';
      const result = optimizeSvg(input);
      expect(result).not.toMatch(/[ \t]+$/m);
    });

    it('压缩连续空行', () => {
      const input = '<svg>\n\n\n\n<rect/>\n\n\n</svg>';
      const result = optimizeSvg(input);
      expect(result).not.toMatch(/\n{3,}/);
    });
  });

  describe('&nbsp; 标准化', () => {
    it('将 &nbsp; 转换为 &#160;', () => {
      const input = '<svg><text>Hello&nbsp;World</text></svg>';
      const result = optimizeSvg(input);
      expect(result).toContain('&#160;');
      expect(result).not.toContain('&nbsp;');
    });
  });

  describe('不破坏有效 SVG', () => {
    it('保留有效的 <g> 元素（包含子节点）', () => {
      const input = '<svg><g id="group"><rect width="10" height="10"/></g></svg>';
      const result = optimizeSvg(input);
      expect(result).toContain('<g id="group">');
      expect(result).toContain('<rect');
    });

    it('保留有效的 <defs> 元素（包含子节点）', () => {
      const input = '<svg><defs><linearGradient id="g1"/></defs></svg>';
      const result = optimizeSvg(input);
      expect(result).toContain('<defs>');
      expect(result).toContain('linearGradient');
    });

    it('保留非默认的 fill-opacity', () => {
      const input = '<svg><rect fill-opacity="0.5"/></svg>';
      const result = optimizeSvg(input);
      expect(result).toContain('fill-opacity="0.5"');
    });

    it('保留完整的复杂 SVG 结构', () => {
      const input = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs>
          <linearGradient id="grad1">
            <stop offset="0%" stop-color="red"/>
            <stop offset="100%" stop-color="blue"/>
          </linearGradient>
        </defs>
        <rect fill="url(#grad1)" width="100" height="100"/>
        <text x="10" y="50">Hello</text>
      </svg>`;
      const result = optimizeSvg(input);
      expect(result).toContain('xmlns=');
      expect(result).toContain('viewBox=');
      expect(result).toContain('linearGradient');
      expect(result).toContain('<text');
      expect(result).toContain('Hello');
    });

    it('结果首尾无多余空白', () => {
      const input = '  \n  <svg><rect/></svg>  \n  ';
      const result = optimizeSvg(input);
      expect(result).toBe(result.trim());
    });
  });
});
