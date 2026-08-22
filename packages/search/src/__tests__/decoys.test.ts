import { describe, expect, it } from 'vitest';

import {
  DECOY_MARGIN,
  SEMANTIC_DECOYS,
  computeDecoyBaselines,
  decoyCutoffForText,
  detectTextScript,
  isDecoyId,
} from '../decoys.js';

describe('detectTextScript', () => {
  it('中文为主 → cjk', () => {
    expect(detectTextScript('帮我截一张当前屏幕的图')).toBe('cjk');
  });

  it('英文为主 → latin', () => {
    expect(detectTextScript('Capture a screenshot of the current screen')).toBe('latin');
  });
});

describe('computeDecoyBaselines', () => {
  it('按文字系统取诱饵最高分', () => {
    const cjkDecoys = SEMANTIC_DECOYS.filter((d) => d.script === 'cjk');
    const latinDecoys = SEMANTIC_DECOYS.filter((d) => d.script === 'latin');
    const baselines = computeDecoyBaselines([
      { id: cjkDecoys[0].id, score: 0.85 },
      { id: latinDecoys[0].id, score: 0.79 },
      { id: latinDecoys[1].id, score: 0.81 },
    ]);
    expect(baselines.cjk).toBe(0.85);
    expect(baselines.latin).toBe(0.81);
  });
});

describe('decoyCutoffForText', () => {
  it('中文候选用 cjk 基线 + 边际', () => {
    expect(decoyCutoffForText('每日筹码更新', { cjk: 0.86, latin: 0.78 })).toBeCloseTo(
      0.86 + DECOY_MARGIN,
    );
  });

  it('英文候选用 latin 基线 + 边际', () => {
    expect(
      decoyCutoffForText('Capture screenshot', { cjk: 0.86, latin: 0.78 }),
    ).toBeCloseTo(0.78 + DECOY_MARGIN);
  });

  it('中文 query × 混排候选（Latin 主导但含中文）取更严的 cjk 基线', () => {
    // live 元凶：「slide grep 全文本搜索 …」被判 latin，但同语言抬升让它
    // 高过 latin 基线——含 query 文字系统字符时须同时过 query 侧基线。
    expect(
      decoyCutoffForText(
        'slide grep 全文本搜索 project-id query page-id',
        { cjk: 0.9, latin: 0.8 },
        '现在几点了',
      ),
    ).toBeCloseTo(0.9 + DECOY_MARGIN);
  });

  it('中文 query × 纯英文候选（真跨语言）仍用 latin 基线，不误杀', () => {
    expect(
      decoyCutoffForText(
        'Capture a screenshot of the current screen',
        { cjk: 0.9, latin: 0.8 },
        '帮我截一张当前屏幕的图',
      ),
    ).toBeCloseTo(0.8 + DECOY_MARGIN);
  });
});

describe('isDecoyId', () => {
  it('诱饵 id 可识别', () => {
    expect(isDecoyId('__decoy__:cjk:weather')).toBe(true);
    expect(isDecoyId('cli:browser-screenshot')).toBe(false);
  });
});
