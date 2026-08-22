/**
 * ranking 模块单测：分词（中英混合）+ BM25 相关性打分。
 */

import { describe, it, expect } from 'vitest';
import { tokenize } from '../tokenize.js';
import { rankByRelevance, type RankItem } from '../bm25.js';

describe('tokenize', () => {
  it('切分英文并小写归一', () => {
    expect(tokenize('Hello World')).toEqual(['hello', 'world']);
  });

  it('切分中文为词（字典分词，非逐字）', () => {
    const toks = tokenize('把数据放进表格');
    // Intl.Segmenter 至少应切出「数据」「表格」这类词，而非整句一个 token。
    expect(toks.length).toBeGreaterThan(1);
    expect(toks.join('')).toContain('数据');
    expect(toks.join('')).toContain('表格');
  });

  it('中英混合一次处理', () => {
    const toks = tokenize('用 lark-sheets 导出表格');
    const joined = toks.join(' ');
    expect(joined).toContain('lark');
    expect(joined).toContain('表格');
  });

  it('空串返回空数组、标点被丢弃', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('！？。，')).toEqual([]);
  });
});

describe('rankByRelevance', () => {
  const items: RankItem[] = [
    { id: 'sheets', text: '飞书电子表格 创建和操作电子表格 导出表格数据' },
    { id: 'mail', text: '飞书邮箱 起草邮件 发送邮件 回复邮件' },
    { id: 'calendar', text: '飞书日历 管理日程和会议室 预定会议室' },
  ];

  it('相关条目分数更高', () => {
    const results = rankByRelevance(items, '帮我把数据导出成表格');
    const byId = new Map(results.map((r) => [r.id, r.score]));
    expect(byId.get('sheets')!).toBeGreaterThan(byId.get('mail')!);
    expect(byId.get('sheets')!).toBeGreaterThan(byId.get('calendar')!);
  });

  it('query 命中邮件相关词时 mail 胜出', () => {
    const results = rankByRelevance(items, '给他回复一封邮件');
    const top = [...results].sort((a, b) => b.score - a.score)[0];
    expect(top.id).toBe('mail');
  });

  it('空 query → 所有条目 0 分', () => {
    const results = rankByRelevance(items, '');
    expect(results.every((r) => r.score === 0)).toBe(true);
  });

  it('query 与所有条目无重合 → 全 0 分', () => {
    const results = rankByRelevance(items, 'kubernetes docker 部署');
    expect(results.every((r) => r.score === 0)).toBe(true);
  });

  it('保持输入顺序（不排序）', () => {
    const results = rankByRelevance(items, '表格');
    expect(results.map((r) => r.id)).toEqual(['sheets', 'mail', 'calendar']);
  });

  it('仅虚词重合 → 0 分（query 侧停用词过滤）', () => {
    // 「的」在候选描述里普遍存在，但不承载检索意图，不应产生非零分
    const noisy: RankItem[] = [
      { id: 'stock', text: '获取全市场的融资融券标的数据' },
      { id: 'index', text: '获取申万行业指数的最新截面数据' },
    ];
    const results = rankByRelevance(noisy, '帮我截一张当前屏幕的图');
    expect(results.every((r) => r.score === 0)).toBe(true);
  });

  it('全虚词 query 退回原行为（不因过滤变成空 query）', () => {
    const noisy: RankItem[] = [{ id: 'a', text: '我的文档' }];
    // query 全是停用词时保留原 token，仍按老口径打分
    const results = rankByRelevance(noisy, '我的');
    expect(results[0].score).toBeGreaterThan(0);
  });
});
