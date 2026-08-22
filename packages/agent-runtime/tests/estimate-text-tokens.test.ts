/**
 * estimateTextTokens — CJK-aware 单段文本 token 估算（阶段 7.4）
 *
 * proxy-provider 的 BP4 缓存断点门控复用此函数判断"消息够不够长值得占断点"。
 * 锁定 CJK 文本 token 密度显著高于 Latin（同字符数下 token 数约 3 倍），
 * 这是把 BP4 阈值从字符口径改成 token 口径的核心动机。
 */

import { describe, it, expect } from 'vitest';
import { estimateTextTokens } from '../src/engine/context/token-budget.js';

describe('estimateTextTokens — CJK-aware token 估算', () => {
  it('空串 = 0 token', () => {
    expect(estimateTextTokens('')).toBe(0);
  });

  it('纯中文 token 数显著高于同字符数的纯英文（CJK ≈1.3 vs Latin ≈4.0 chars/token）', () => {
    const cjk = '今天天气很好我们一起去公园散步吧'; // 16 个汉字
    const latin = 'the quick brown.'; // 16 个 ASCII 字符
    expect(cjk.length).toBe(latin.length);
    const cjkTokens = estimateTextTokens(cjk);
    const latinTokens = estimateTextTokens(latin);
    // 同字符数下中文 token 数应明显更高（约 3 倍量级）
    expect(cjkTokens).toBeGreaterThan(latinTokens * 2);
  });

  it('纯中文约 length 量级（charsPerToken≈1.3，含 4/3 padding → ≈1.03×length）', () => {
    const text = '一二三四五六七八九十'; // 10 个汉字
    // ceil(10 / 1.3 * 4/3) = ceil(10.26) = 11
    expect(estimateTextTokens(text)).toBe(11);
  });

  it('纯英文约 length/3 量级（charsPerToken≈4.0，含 4/3 padding → ≈0.33×length）', () => {
    const text = 'abcdefghijkl'; // 12 个 ASCII
    // ceil(12 / 4.0 * 4/3) = ceil(4) = 4
    expect(estimateTextTokens(text)).toBe(4);
  });
});
