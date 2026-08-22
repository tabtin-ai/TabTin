/**
 * `summarizeToolOutput` 持久化 + 引用语义测试。
 *
 * **W4（2026-05-12）calculator.html dogfood 复盘改造**：旧实现用"中间夹断"
 * （前 4000 char + meta + 后 4000 char），把 12K 字符的 read_file 输出夹掉
 * 中段 4K 后塞回 LLM context，LLM 凭训练分布幻觉出虚构内容（详见
 *
 *   1. 短内容（< SUMMARIZE_TOOL_OUTPUT_TOKEN_THRESHOLD，按 CJK-aware token 判定）→ 原样返回
 *   2. `ctx.perToolMax === Infinity` → hard opt-out（read_file 等"主动读取
 *      契约"工具用）
 *   3. 否则：写盘到 ToolResultStorage + 给 LLM head/tail+banner，banner 含
 *      绝对路径让 LLM 用 read_file 续读
 *
 * 老的 fence-aware 行为保留（fence 边界仍是安全护栏，meta 仍在 fence 外）。
 *
 * **L-29 历史背景**：fence 内不写 meta，是因为 `<tool_output>` fence 是 FR-09
 * prompt-injection 防护边界，meta 写进 body 会让攻击者可以伪造类似的 meta
 * 行迷惑 LLM。新 banner 文案 (`buildPersistMeta`) 比旧 (`[... N lines, M chars
 * total ...]`) 更丰富，但写位置仍在 fence 外。
 */
import { describe, it, expect } from 'vitest';
import {
  summarizeToolOutput,
  splitToolOutputFence,
  SUMMARIZE_TOOL_OUTPUT_TOKEN_THRESHOLD,
} from '../src/engine/tooling/tool-output-summary.js';
import { wrapInToolOutputFence } from '../src/engine/tooling/tool-output-sanitizer.js';
import {
  MemoryToolResultStorage,
  type ToolResultStorage,
} from '../src/engine/tooling/tool-result-storage.js';
import type {
  ContentBlock,
} from '../src/engine/contracts/conversation.js';
import type {
  ToolResult,
} from '../src/engine/contracts/tools.js';

function makeResult(content: string | ContentBlock[]): ToolResult {
  return { content, isError: false } as ToolResult;
}

/** Spy storage：记录每次 save 的 (id, toolName, content)，用于断言持久化是否真发生。 */
class SpyStorage implements ToolResultStorage {
  saves: Array<{ id: string; toolName: string; content: string }> = [];
  save(id: string, toolName: string, content: string): void {
    this.saves.push({ id, toolName, content });
  }
  getFilePath(id: string): string {
    return `/tmp/test-tool-results/${id}.txt`;
  }
  getResultsDir(): string {
    return '/tmp/test-tool-results';
  }
}

const PERSIST_BANNER_RE =
  /\[\.\.\. 输出已截断：超出摘要阈值（\d+ token），原始 \d+ 字符/;
const FAKE_DIR = '/tmp/test-tool-results';

// ：阈值改用 token（CJK-aware）。纯 ASCII 内容 token ≈ 字符数 / 3，故
// 取 6× 阈值字符（≈2× token 阈值）确保稳定触发截断，避免贴着阈值抖动。
const LONG_CHARS = SUMMARIZE_TOOL_OUTPUT_TOKEN_THRESHOLD * 6;

describe('splitToolOutputFence (W3 — no tool_call_id attribute)', () => {
  it('returns parts for a valid attribute-bearing fence', () => {
    const wrapped = wrapInToolOutputFence('body text', 'web_search', false);
    const parts = splitToolOutputFence(wrapped);
    expect(parts).not.toBeNull();
    expect(parts!.body).toBe('body text');
    expect(parts!.open).toMatch(/^<tool_output [^>]+>\n$/);
    expect(parts!.close).toBe('\n</tool_output>');
    expect(parts!.open + parts!.body + parts!.close).toBe(wrapped);
  });

  it('handles attribute-less fence open (defensive)', () => {
    const s = '<tool_output>\nhello\n</tool_output>';
    const parts = splitToolOutputFence(s);
    expect(parts).not.toBeNull();
    expect(parts!.body).toBe('hello');
  });

  it('returns null for plain text', () => {
    expect(splitToolOutputFence('plain content')).toBeNull();
  });

  it('returns null for fence open without close', () => {
    const s = '<tool_output tool_name="x">\nbody only';
    expect(splitToolOutputFence(s)).toBeNull();
  });

  it('returns null for fence close without open', () => {
    const s = 'body only\n</tool_output>';
    expect(splitToolOutputFence(s)).toBeNull();
  });

  it('returns null when open tag is missing the trailing newline', () => {
    const s = '<tool_output tool_name="x">body\n</tool_output>';
    expect(splitToolOutputFence(s)).toBeNull();
  });
});

describe('summarizeToolOutput · short content', () => {
  it('returns short content unchanged regardless of fence (no ctx)', () => {
    const wrapped = wrapInToolOutputFence('short body', 'web_search', false);
    expect(summarizeToolOutput(makeResult(wrapped))).toBe(wrapped);

    const plain = 'short plain content';
    expect(summarizeToolOutput(makeResult(plain))).toBe(plain);
  });

  it('keeps current-turn terminal tool_result semantics unchanged', () => {
    const terminalResult = JSON.stringify({
      status: 'completed',
      exit_code: 0,
      stdout: 'CURRENT_TURN_TERMINAL_STDOUT_STILL_VISIBLE',
    });
    const out = summarizeToolOutput(makeResult(terminalResult), {
      toolUseId: 'toolu-current-turn-terminal',
      toolName: 'run_terminal_command',
      storage: new SpyStorage(),
    });

    expect(out).toBe(terminalResult);
    expect(String(out)).toContain('CURRENT_TURN_TERMINAL_STDOUT_STILL_VISIBLE');
  });

  it('returns ContentBlock[] content unchanged (no string truncation applied)', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'hello' } as ContentBlock,
    ];
    expect(summarizeToolOutput(makeResult(blocks))).toBe(blocks);
  });

  it('short content remains untouched even with full ctx (no persist, no save)', () => {
    const storage = new SpyStorage();
    const out = summarizeToolOutput(makeResult('short'), {
      toolUseId: 'id-1',
      toolName: 'read_file',
      storage,
    });
    expect(out).toBe('short');
    expect(storage.saves).toHaveLength(0);
  });
});

describe('summarizeToolOutput · perToolMax=Infinity hard opt-out', () => {
  it('returns full content unchanged when perToolMax is Infinity (read_file契约)', () => {
    const storage = new SpyStorage();
    const longContent = 'x'.repeat(LONG_CHARS);
    const out = summarizeToolOutput(makeResult(longContent), {
      toolUseId: 'id-2',
      toolName: 'read_file',
      storage,
      perToolMax: Infinity,
    });
    expect(out).toBe(longContent);
    // hard opt-out 必须避免持久化（不写 token、不占磁盘）
    expect(storage.saves).toHaveLength(0);
  });

  it('still truncates + persists when perToolMax is a finite limit', () => {
    const storage = new SpyStorage();
    const longContent = 'y'.repeat(LONG_CHARS);
    const out = summarizeToolOutput(makeResult(longContent), {
      toolUseId: 'id-3',
      toolName: 'grep_search',
      storage,
      perToolMax: 20_000, // finite → 不豁免
    });
    expect(out).not.toBe(longContent);
    expect(storage.saves).toHaveLength(1);
  });

  it('perToolMax undefined → 走默认阈值（不豁免）', () => {
    const storage = new SpyStorage();
    const longContent = 'z'.repeat(LONG_CHARS);
    const out = summarizeToolOutput(makeResult(longContent), {
      toolUseId: 'id-4',
      toolName: 'web_search',
      storage,
      // perToolMax 缺省
    });
    expect(out).not.toBe(longContent);
    expect(storage.saves).toHaveLength(1);
  });
});

describe('summarizeToolOutput · CJK token threshold ', () => {
  it('CJK content over 12K tokens is offloaded', () => {
    const storage = new SpyStorage();
    const cjk = '中'.repeat(15_000);
    const out = summarizeToolOutput(makeResult(cjk), {
      toolUseId: 'cjk-offload',
      toolName: 'web_search',
      storage,
    }) as string;

    expect(out).not.toBe(cjk);
    expect(out).toMatch(PERSIST_BANNER_RE);
    expect(out).toContain(
      `超出摘要阈值（${SUMMARIZE_TOOL_OUTPUT_TOKEN_THRESHOLD} token）`,
    );
    expect(out).toContain(`原始 ${cjk.length} 字符`);
    expect(storage.saves).toHaveLength(1);
    expect(storage.saves[0]).toEqual({
      id: 'cjk-offload',
      toolName: 'web_search',
      content: cjk,
    });
  });

  it('CJK content under 12K tokens stays inline', () => {
    const storage = new SpyStorage();
    const cjk = '中'.repeat(11_000);
    const out = summarizeToolOutput(makeResult(cjk), {
      toolUseId: 'cjk-inline',
      toolName: 'web_search',
      storage,
    });

    expect(out).toBe(cjk);
    expect(storage.saves).toHaveLength(0);
  });
});

describe('summarizeToolOutput · persist+reference (long content)', () => {
  it('long non-fence content is persisted + banner contains absolute path', () => {
    const storage = new SpyStorage();
    const longContent = 'a'.repeat(LONG_CHARS);
    const out = summarizeToolOutput(makeResult(longContent), {
      toolUseId: 'id-5',
      toolName: 'web_search',
      storage,
    }) as string;

    // banner 命中
    expect(out).toMatch(PERSIST_BANNER_RE);
    // 路径在 banner 里
    expect(out).toContain(`Full output saved to: ${FAKE_DIR}/id-5.txt`);
    // ：digest 工具下线后，banner 只引导仍可用的收窄路径。
    expect(out).not.toContain('digest');
    expect(out).toContain('grep_search');
    expect(out).toContain('read_file');
    // 写盘真发生 + 内容是 pre-truncation 完整内容
    expect(storage.saves).toHaveLength(1);
    expect(storage.saves[0]).toEqual({
      id: 'id-5',
      toolName: 'web_search',
      content: longContent,
    });
  });

  it('long fence-wrapped content keeps fence intact + meta outside close tag', () => {
    const storage = new SpyStorage();
    const longBody = 'q'.repeat(LONG_CHARS);
    const wrapped = wrapInToolOutputFence(longBody, 'web_search', false);
    const out = summarizeToolOutput(makeResult(wrapped), {
      toolUseId: 'id-6',
      toolName: 'web_search',
      storage,
    }) as string;

    // 安全护栏：fence open / close 完整
    expect(out.startsWith('<tool_output ')).toBe(true);
    // **W4 (2026-05-12)**：banner 整体被 `<persisted-output>` 包裹后，fence
    // close 后紧跟 `<persisted-output>\n[... 输出已截断`。
    expect(out).toMatch(
      /<\/tool_output>\n<persisted-output>\n\[\.\.\. 输出已截断/,
    );

    // banner 在 fence 外
    const closeIdx = out.lastIndexOf('</tool_output>');
    const bannerIdx = out.search(PERSIST_BANNER_RE);
    expect(closeIdx).toBeGreaterThan(0);
    expect(bannerIdx).toBeGreaterThan(closeIdx);

    // body 内不出现 banner（fence 内是"untrusted bytes"，runtime 的话不能进去）
    const bodyStart = out.indexOf('>\n') + 2;
    const bodyOnly = out.slice(bodyStart, closeIdx);
    expect(bodyOnly).not.toMatch(PERSIST_BANNER_RE);
    expect(bodyOnly).not.toContain('<persisted-output>');

    // 写盘真发生
    expect(storage.saves).toHaveLength(1);
    expect(storage.saves[0].content).toBe(wrapped);
  });

  it('preserves fence attributes (tool_name + suspicious) verbatim after truncation', () => {
    const storage = new SpyStorage();
    const longBody = 'z'.repeat(LONG_CHARS);
    const wrapped = wrapInToolOutputFence(longBody, 'web_search', true);
    const out = summarizeToolOutput(makeResult(wrapped), {
      toolUseId: 'id-7',
      toolName: 'web_search',
      storage,
    }) as string;
    expect(out).toMatch(/^<tool_output tool_name="web_search" suspicious="true">\n/);
    expect(out).not.toContain('tool_call_id=');
  });
});

describe('summarizeToolOutput · storage absent fallback', () => {
  it('without ctx → "not persisted in this host" banner（向后兼容老调用方）', () => {
    const longContent = 'a'.repeat(LONG_CHARS);
    const out = summarizeToolOutput(makeResult(longContent)) as string;
    expect(out).toMatch(PERSIST_BANNER_RE);
    expect(out).toContain('完整输出未在此 host 持久化');
  });

  it('with MemoryToolResultStorage → 同样降级为 not persisted', () => {
    const storage = new MemoryToolResultStorage();
    const longContent = 'b'.repeat(LONG_CHARS);
    const out = summarizeToolOutput(makeResult(longContent), {
      toolUseId: 'id-8',
      toolName: 'web_search',
      storage,
    }) as string;
    expect(out).toMatch(PERSIST_BANNER_RE);
    expect(out).toContain('完整输出未在此 host 持久化');
    // memory:// URI 不能直接暴露给 LLM（LLM 拿这种 URI 没法用 read_file 读）
    expect(out).not.toContain('memory://');
  });

  it('with ctx but no storage → 等价 not persisted', () => {
    const longContent = 'c'.repeat(LONG_CHARS);
    const out = summarizeToolOutput(makeResult(longContent), {
      toolUseId: 'id-9',
      toolName: 'web_search',
      // storage 缺省
    }) as string;
    expect(out).toMatch(PERSIST_BANNER_RE);
    expect(out).toContain('完整输出未在此 host 持久化');
  });
});

describe('summarizeToolOutput · banner 内容信号', () => {
  it('banner 包含 original size + threshold + path 三要素，让 LLM 能精确决策', () => {
    const storage = new SpyStorage();
    const original = 'a'.repeat(LONG_CHARS);
    const out = summarizeToolOutput(makeResult(original), {
      toolUseId: 'banner-test',
      toolName: 'web_search',
      storage,
    }) as string;

    // 1. original size 在 banner 里 → LLM 能算"我看了多少 / 还缺多少"
    expect(out).toContain(`原始 ${original.length} 字符`);
    // 2. threshold 在 banner 里 → LLM 知道触发条件（：单位为 token）
    expect(out).toContain(`超出摘要阈值（${SUMMARIZE_TOOL_OUTPUT_TOKEN_THRESHOLD} token）`);
    // 3. path 在 banner 里 → LLM 能用 read_file 沿引用路径恢复
    expect(out).toContain(`Full output saved to: ${FAKE_DIR}/banner-test.txt`);
  });

  it('head + tail 比例符合 4:4（保留 LLM 上下文里的开头 + 结尾签名）', () => {
    const storage = new SpyStorage();
    // 用可识别的 head/tail 标记区分（head 是 'A'，tail 是 'B'）。
    // ：阈值改 token 后 preview 字符预算 = floor(token阈值*0.4) * 内容
    // chars-per-token。纯 ASCII 内容 chars-per-token ≈ 3，故 preview ≈ 14.4K
    // 字符。每段取 3× 阈值字符（=36K > preview），确保 head 段纯 'A'、tail 段
    // 纯 'B'，且 head+mid+tail 的 token 数远超阈值，必触发截断。
    const segLen = SUMMARIZE_TOOL_OUTPUT_TOKEN_THRESHOLD * 3;
    const head = 'A'.repeat(segLen);
    const tail = 'B'.repeat(segLen);
    const original = head + 'X'.repeat(segLen) + tail;
    const out = summarizeToolOutput(makeResult(original), {
      toolUseId: 'head-tail',
      toolName: 'web_search',
      storage,
    }) as string;

    // 输出开头应该是 A（不是 X 也不是 B）
    expect(out.startsWith('A')).toBe(true);
    // 输出末尾（path 之后）应该有 B
    expect(out).toContain('B'.repeat(100));
    // X 是中段，应该被丢掉（写盘 + truncate）—— 但因为持久化路径里有 'tool-results'
    // 字符串，正好不含 X，所以可以严格断言。
    // **W4 (2026-05-12)**：banner 现在被 `<persisted-output>` 包裹，head 跟
    // banner 之间多了一行 `<persisted-output>`。
    const headEnd = out.indexOf('\n<persisted-output>\n[... 输出已截断');
    expect(headEnd).toBeGreaterThan(0);
    expect(out.slice(0, headEnd)).not.toContain('X');
  });
});
