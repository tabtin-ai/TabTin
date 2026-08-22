/**
 *  — streaming text-repetition detector unit tests.
 *
 * Dogfood case: Kimi k2.6 on scheduled「喝水任务」streamed meta-closing
 * phrases for ~70s. Detector must trip early; normal prose must stay free.
 *
 * Current contract: only exact identical continuous periods trip. The same
 * output pattern with different field values is healthy streaming text.
 */
import { describe, it, expect } from 'vitest';
import {
  TEXT_REPETITION_CHECK_STRIDE,
  TEXT_REPETITION_MIN_CHARS,
  detectStreamingTextRepetition,
  shouldCheckTextRepetition,
} from '../guards/text-repetition-detector.js';

function repeat(unit: string, times: number): string {
  return unit.repeat(times);
}

describe('detectStreamingTextRepetition — thresholds', () => {
  it('ignores short text below MIN_CHARS', () => {
    expect(detectStreamingTextRepetition('最终。输出。结束。')).toBeNull();
    expect(TEXT_REPETITION_MIN_CHARS).toBeGreaterThan(50);
  });

  it('trips on dogfood-style Chinese meta-phrase cycling (phrase_period)', () => {
    const unit = '最终。输出。结束。发送。完成。';
    const text = repeat(unit, 12);
    const hit = detectStreamingTextRepetition(text);
    expect(hit).not.toBeNull();
    expect(hit?.triggered).toBe(true);
    expect(hit?.reason).toBe('phrase_period');
  });

  it('trips when whitespace varies between repeating units', () => {
    const unit = '最终。 输出。 结束。 发送。 ';
    const text = repeat(unit, 14);
    const hit = detectStreamingTextRepetition(text);
    expect(hit).not.toBeNull();
    expect(hit?.reason).toBe('phrase_period');
  });

  it('trips on English closing meta-loop', () => {
    const unit = 'final. output. end. send. ';
    const text = repeat(unit, 14);
    const hit = detectStreamingTextRepetition(text);
    expect(hit).not.toBeNull();
    expect(hit?.reason).toBe('phrase_period');
  });

  it('trips when the same closing cycle is joined by periods', () => {
    const tokens = [
      '最终', '输出', '结束', '发送', '完成',
      '最终', '输出', '结束', '发送', '完成',
      '最终', '输出', '结束', '发送', '完成',
      '最终', '输出', '结束', '发送', '完成',
      '最终', '输出', '结束', '发送', '完成',
      '最终', '输出', '结束', '发送', '完成',
      '最终', '输出', '结束', '发送', '完成',
      '最终', '输出', '结束', '发送', '完成',
    ];
    const text = tokens.join('。') + '。';
    const hit = detectStreamingTextRepetition(text);
    expect(hit).not.toBeNull();
    expect(hit?.reason).toBe('phrase_period');
  });

  it('does not trip on normal multi-sentence prose', () => {
    const prose = [
      '已经帮你创建了喝水提醒任务。',
      '它大约每三分钟触发一次，会向对话发送一条提醒消息。',
      '如果推送失败，请检查提醒渠道是否已授权，并把机器人拉进接收群。',
      '你也可以随时在自动化面板里暂停或修改指令。',
      '本次执行到此结束，如需调整频率告诉我即可。',
    ].join('');
    const text = prose.repeat(3);
    expect(text.length).toBeGreaterThan(TEXT_REPETITION_MIN_CHARS);
    expect(detectStreamingTextRepetition(text)).toBeNull();
  });

  it('does not trip on repeated technical identifiers in a short unique wrapper', () => {
    const text = [
      '检查了 session d34e000d-9406-4290-8034-57a7134b3605 的工具调用记录，',
      '发现 run_terminal_command 连续执行了多次不同命令。',
      '第一次读取了 skill 文档，随后尝试通过 CLI 发送提醒。',
      '授权失败后给出了明确修复指引，不再继续盲试。',
    ].join('');
    expect(text.length).toBeGreaterThan(TEXT_REPETITION_MIN_CHARS);
    expect(detectStreamingTextRepetition(text)).toBeNull();
  });

  // : symbol-only periods are structural (tables / rules), not linguistic loops.
  it('does not trip on markdown table separator |--------- cycles', () => {
    const prose = [
      '血清肌酐与肌少症的关系取决于模型调整了哪些变量。',
      '下面用表格对照几种常见设定下的 OR 方向。',
      '### 关键判断：你的模型调整了哪些变量？',
      '| 模型情况 | 肌酐 OR 的预期方向 | 解释 |',
      '',
    ].join('\n');
    const text = prose + repeat('|---------', 8);
    expect(text.length).toBeGreaterThan(TEXT_REPETITION_MIN_CHARS);
    expect(detectStreamingTextRepetition(text)).toBeNull();
  });

  it('does not trip on short |--- column-separator cycles', () => {
    const prose = [
      '对照表如下，请按列阅读模型设定与 OR 方向解释。',
      '每一列对应一种常见调整组合，便于和论文表格逐项核对。',
      '符号分隔行本身不是语言复读，检测器应予放行。',
      '',
    ].join('\n');
    const text = prose + '|a|b|c|d|e|f|g|h|\n' + repeat('|---', 8) + '|\n';
    expect(text.length).toBeGreaterThan(TEXT_REPETITION_MIN_CHARS);
    expect(detectStreamingTextRepetition(text)).toBeNull();
  });

  it('does not trip on long dash runs without letters', () => {
    const prose = [
      '分隔线仅用于版式，不应触发文本复读硬停。',
      '即便后面跟着很长一串横线或 ASCII 规则线也一样。',
      '',
    ].join('\n');
    const text = prose + repeat('-', 80);
    expect(text.length).toBeGreaterThan(TEXT_REPETITION_MIN_CHARS);
    expect(detectStreamingTextRepetition(text)).toBeNull();
  });
});

describe('detectStreamingTextRepetition — exact period only', () => {
  it('does not trip when the same short tokens drift in order', () => {
    const chunks = [
      '最终。输出。结束。发送。完成。',
      '最终。结束。输出。发送。完成。',
      '最终。输出。发送。结束。完成。',
      '最终。输出。结束。完成。发送。',
      '输出。最终。结束。发送。完成。',
      '最终。输出。结束。发送。完成。',
      '最终。结束。输出。发送。完成。',
      '最终。输出。发送。结束。完成。',
      '完成。最终。输出。结束。发送。',
      '最终。完成。输出。结束。发送。',
    ];
    const text = chunks.join('');
    expect(text.length).toBeGreaterThan(TEXT_REPETITION_MIN_CHARS);
    expect(detectStreamingTextRepetition(text)).toBeNull();
  });

  it('does not trip on a dense Unicode file tree with many │ prefixes', () => {
    const files = [
      'start', 'investigate', 'plan', 'implement', 'verify', 'submit', 'review',
      'next', 'status', 'finish', 'discard', 'types', 'index', 'util', 'config',
      'logger', 'errors', 'client', 'server', 'router', 'handler', 'middleware',
      'schema', 'model', 'service', 'repo', 'dto', 'mapper', 'policy', 'guard',
    ];
    const lines = ['src/', '├── commands/'];
    for (let i = 0; i < files.length; i++) {
      const last = i === files.length - 1;
      lines.push(`│   ${last ? '└' : '├'}── ${files[i]}.ts`);
    }
    const text = lines.join('\n');
    expect(text.length).toBeGreaterThan(TEXT_REPETITION_MIN_CHARS);
    expect(detectStreamingTextRepetition(text)).toBeNull();
  });

  it('does not trip on same branch-name pattern with different values', () => {
    const branches = [
      'feat/6490-composer-unified-add-menu',
      'feat/6762-tracker-calendar-templates',
      'feat/7897-ios-notification-routing',
      'feat/8182-ios-shortcut-actions',
      'feat/app-focus-chat-capsule',
      'fix/1604',
      'fix/3844',
      'fix/4985',
      'fix/6035',
      'fix/6072',
      'fix/6179',
      'fix/6313',
      'fix/6538',
      'fix/6565',
      'fix/6575',
      'fix/6672',
      'fix/6673',
      'fix/6674',
      'fix/6744',
      'fix/6847',
      'fix/7041',
      'fix/7182-7183',
      'fix/7220',
      'fix/7401',
      'fix/7814',
      'fix/8129',
    ];
    const text = [
      '深度清理计划（待你确认）',
      '第 1 类：gone 分支（远端已删除）- 45 个，最安全',
      '远端分支已不存在，本地引用是纯残留。包括：',
      branches.map((branch) => `\`${branch}\``).join('、'),
    ].join('\n');
    expect(text.length).toBeGreaterThan(TEXT_REPETITION_MIN_CHARS);
    expect(detectStreamingTextRepetition(text)).toBeNull();
  });

  it('does not trip on deep box-drawing lines with similar short filenames', () => {
    const text = Array.from(
      { length: 40 },
      (_, i) => `│   │   │   ├── file${i}.ts`,
    ).join('\n');
    expect(text.length).toBeGreaterThan(TEXT_REPETITION_MIN_CHARS);
    expect(detectStreamingTextRepetition(text)).toBeNull();
  });

  it('does not trip when filenames vary despite a repeated short suffix', () => {
    const names = ['index', 'types', 'utils', 'config', 'logger', 'errors'];
    const text = Array.from(
      { length: 40 },
      (_, i) => `│   ├── ${names[i % names.length]}.ts`,
    ).join('\n');
    expect(text.length).toBeGreaterThan(TEXT_REPETITION_MIN_CHARS);
    expect(detectStreamingTextRepetition(text)).toBeNull();
  });

  it('does not trip on near-period meta-language drift', () => {
    const chunks = ['最终。输出。结束！', '最终！结束。输出？', '输出。最终！结束。', '结束？输出。最终！'];
    const text = Array.from({ length: 16 }, (_, i) => chunks[i % chunks.length]).join('');
    expect(text.length).toBeGreaterThan(TEXT_REPETITION_MIN_CHARS);
    expect(detectStreamingTextRepetition(text)).toBeNull();
  });

  it('does not trip when symbol-only tokens would otherwise dominate', () => {
    const prose = [
      '下面是仓库目录示意，竖线只是层级缩进，不是收尾复读。',
      '每个叶子对应不同模块入口，请按文件名阅读即可。',
      '',
    ].join('\n');
    const bars = Array.from({ length: 50 }, () => '│').join(' ');
    const text = prose + bars;
    expect(text.length).toBeGreaterThan(TEXT_REPETITION_MIN_CHARS);
    expect(detectStreamingTextRepetition(text)).toBeNull();
  });
});

describe('shouldCheckTextRepetition', () => {
  it('waits until MIN_CHARS then strides', () => {
    expect(shouldCheckTextRepetition(50, 0)).toBe(false);
    expect(shouldCheckTextRepetition(TEXT_REPETITION_MIN_CHARS, 0)).toBe(true);
    expect(
      shouldCheckTextRepetition(
        TEXT_REPETITION_MIN_CHARS + TEXT_REPETITION_CHECK_STRIDE - 1,
        TEXT_REPETITION_MIN_CHARS,
      ),
    ).toBe(false);
    expect(
      shouldCheckTextRepetition(
        TEXT_REPETITION_MIN_CHARS + TEXT_REPETITION_CHECK_STRIDE,
        TEXT_REPETITION_MIN_CHARS,
      ),
    ).toBe(true);
  });
});
