/**
 * W1.4 收尾：DaemonAgentHost.fetchCloudSummary 持久通道单测
 *
 * **为什么必补**：
 *   W1.3 第 3 轮 Review 才救上的"持久通道接 backend `failure_code`"是 W1
 *   北极星在用户**最主要入口**（拖文件到 chat，占 99% 流量）的真实缺口——
 *   代码改对了但 0 测试覆盖。下一棒改 `fetchCloudSummary` / 重构 OSS 集成 /
 *   后端字段命名漂移时，立刻回归到 "[附件: foo.pdf (application/pdf)]" 占位 UX，
 *   没人发现。
 *
 * 测试策略：
 *   - 用 `Object.create(DaemonAgentHost.prototype)` 跳过完整 constructor，
 *     注入最小依赖（config / logger / getAccessToken）后**真正调用** prototype
 *     上的 `fetchCloudSummary` 私有方法（TS private 只是编译期约束）。
 *   - 全局 `vi.stubGlobal('fetch', ...)` mock 整个 backend response，让测试驱动
 *     `data.status` / `data.failure_code` 各种组合；
 *   - 断言：消费 `formatFilePipelineErrorChinesePrompt` 派发，输出含正确中文转述
 *     phrase + `isFilePipelineErrorCode` 兜底分支 + 'ready/parsing/pending' 旧
 *     路径不退化。
 *   - 13 类 failure_code 用 `FILE_PIPELINE_ERROR_KINDS` 自动遍历，**不硬编码字面值
 *     列表** —— SSoT 加新 kind 时本测试自动跟随，避免 §八 反思 #3"SSoT 双源"
 *     在测试层重演。
 *
 * 与 Electron 端 `electron-agent-host-cloud-summary.test.ts` 同构，差异只在
 * fetchCloudSummary 内部依赖（Daemon 用 `this.config.server_url` /
 * `this.getAccessToken()` / `this.logger`，Electron 用 module-level
 * `API_BASE_URL` / `TokenManager.getAccessToken()` / `electron-log`）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// SSoT 通过 @tabtin/local-docparse 二次 re-export（与 daemon localDocParse.ts
// 同款入口；daemon 没有直接 depend file-pipeline-errors）
import {
  FILE_PIPELINE_ERROR_KINDS,
  FilePipelineErrorCode,
  formatFilePipelineErrorChinesePrompt,
} from '@tabtin/local-docparse';
import { DaemonAgentHost } from '../src/application/agent/daemon-agent-host.js';

// ────────────────────────────────────────────────────────────────────
// 测试 harness：跳过完整 constructor，注入最小依赖
// ────────────────────────────────────────────────────────────────────

interface CloudSummaryHarness {
  config: { server_url: string };
  logger: { debug: (...args: unknown[]) => void };
  getAccessToken: () => string | null;
  fetchCloudSummary: (
    fileId: string,
    filename: string,
    sessionAbortSignal?: AbortSignal,
  ) => Promise<string | null>;
}

function createHarness(opts?: {
  token?: string | null;
  serverUrl?: string;
}): CloudSummaryHarness {
  const harness = Object.create(DaemonAgentHost.prototype) as CloudSummaryHarness;
  Object.defineProperty(harness, 'config', {
    value: { server_url: opts?.serverUrl ?? 'https://api.test.local' },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(harness, 'logger', {
    value: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(harness, 'getAccessToken', {
    value: () => (opts?.token === undefined ? 'test-token' : opts.token),
    writable: true,
    configurable: true,
  });
  return harness;
}

function mockFetchOnce(responseBody: unknown, opts?: { ok?: boolean; status?: number }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: opts?.ok ?? true,
    status: opts?.status ?? 200,
    json: async () => responseBody,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ────────────────────────────────────────────────────────────────────
// A. 13 类 failure_code 全覆盖（自动遍历 SSoT，不硬编码）
// ────────────────────────────────────────────────────────────────────

describe('DaemonAgentHost.fetchCloudSummary — backend status=failed × 13 类 failure_code', () => {
  for (const failureCode of FILE_PIPELINE_ERROR_KINDS) {
    it(`failure_code='${failureCode}' → 走 SSoT formatFilePipelineErrorChinesePrompt 中文转述`, async () => {
      mockFetchOnce({
        status: 'failed',
        failure_code: failureCode,
        message: `representative backend message for ${failureCode}`,
      });

      const harness = createHarness();
      const result = await harness.fetchCloudSummary('test-file-id', 'sample.pdf');

      expect(result).not.toBeNull();
      expect(typeof result).toBe('string');

      const expected = formatFilePipelineErrorChinesePrompt(failureCode, {
        filename: 'sample.pdf',
        rawMessage: `representative backend message for ${failureCode}`,
      });
      expect(result).toBe(expected);

      expect(result).toContain('[文档: sample.pdf');
      expect(result).not.toContain('[附件: sample.pdf');
    });
  }
});

// ────────────────────────────────────────────────────────────────────
// B. 关键 phrase 钉死（每类的中文文案"用户能看懂"语义不漂移）
// ────────────────────────────────────────────────────────────────────

describe('DaemonAgentHost.fetchCloudSummary — 13 类关键中文 phrase 钉死', () => {
  const phraseMatrix: ReadonlyArray<{
    code: FilePipelineErrorCode;
    filename: string;
    expectPhrase: RegExp;
    forbidPhrase?: RegExp;
  }> = [
    { code: FilePipelineErrorCode.ENCRYPTED, filename: 'secret.pdf', expectPhrase: /密码保护|加密/ },
    { code: FilePipelineErrorCode.SCANNED_PDF, filename: 'scan.pdf', expectPhrase: /扫描件|按页计费/ },
    { code: FilePipelineErrorCode.UNSUPPORTED_FORMAT, filename: 'song.mp3', expectPhrase: /格式|不支持|语音识别|音频/ },
    { code: FilePipelineErrorCode.CORRUPTED, filename: 'broken.pdf', expectPhrase: /损坏|无法解析|结构异常/ },
    { code: FilePipelineErrorCode.GARBLED_TEXT_LAYER, filename: 'ocr.pdf', expectPhrase: /乱码|文本层|VLM/ },
    { code: FilePipelineErrorCode.PARSE_TIMEOUT, filename: 'big.pdf', expectPhrase: /超时|稍后重试|拆/ },
    { code: FilePipelineErrorCode.NETWORK_ERROR, filename: 'net.pdf', expectPhrase: /网络|重试|链接/ },
    { code: FilePipelineErrorCode.FILE_NOT_FOUND, filename: 'gone.pdf', expectPhrase: /未找到|失效|删除|过期|重新上传/ },
    { code: FilePipelineErrorCode.FILE_TOO_LARGE, filename: 'huge.pdf', expectPhrase: /体积|大|分段|分页/ },
    { code: FilePipelineErrorCode.PERMISSION_DENIED, filename: 'private.pdf', expectPhrase: /权限|访问|工作区/ },
    { code: FilePipelineErrorCode.USER_ABORTED, filename: 'cancelled.pdf', expectPhrase: /取消/ },
    { code: FilePipelineErrorCode.INVALID_PARAMETER, filename: 'badreq.pdf', expectPhrase: /参数|重新上传|链路异常/ },
    {
      code: FilePipelineErrorCode.UNKNOWN_ERROR,
      filename: 'mystery.bin',
      expectPhrase: /未能识别|换一种格式|联系客服/,
      // UNKNOWN_ERROR **绝不能**把 backend raw "segfault 0xDEADBEEF" 之类技术词
      // 透出给用户（W1.2 反思 #3 SSoT 收口"差最后一公里"）
      forbidPhrase: /segfault|0x[0-9a-f]+|DEADBEEF/i,
    },
  ];

  // **W1.4 收尾 Review 3 HIGH-1 修复**：全 13 类共享默认 forbidPhrase
  // —— SSoT 设计承诺是"13 类**全部**不透 backend raw 技术词给用户"
  // （`format.ts:480` UNKNOWN_ERROR 分支 `void rawMessage;` 显式不消费；
  // 其它 12 类根本不取 rawMessage）。但只对 UNKNOWN_ERROR 加 forbidPhrase
  // 留下"未来某轮把 ENCRYPTED 中文 prompt 改为透 rawMessage"的回归口。
  // case-specific forbidPhrase 仍可独立覆盖默认值。
  const COMMON_FORBID_RAW_TECH = /segfault|0x[0-9a-f]+|DEADBEEF/i;

  for (const { code, filename, expectPhrase, forbidPhrase } of phraseMatrix) {
    it(`${code} 中文 phrase 包含 ${expectPhrase}`, async () => {
      mockFetchOnce({
        status: 'failed',
        failure_code: code,
        message: 'segfault at 0xDEADBEEF (raw backend tech stack)',
      });

      const harness = createHarness();
      const result = await harness.fetchCloudSummary('test-id', filename);

      expect(result).not.toBeNull();
      expect(result).toMatch(expectPhrase);
      // 默认全 13 类 forbid raw 技术词；case-specific forbidPhrase 可覆盖
      expect(result).not.toMatch(forbidPhrase ?? COMMON_FORBID_RAW_TECH);
    });
  }
});

// ────────────────────────────────────────────────────────────────────
// B-bis. sessionAbortSignal race condition 钉死（Review 1 MID-3）
// ────────────────────────────────────────────────────────────────────

describe('DaemonAgentHost.fetchCloudSummary — sessionAbortSignal race condition', () => {
  it('sessionAbortSignal 已 abort → catch 返 null（不传染上游）', async () => {
    // 模拟 fetch 在 abort signal 触发后立即抛 AbortError（real fetch 行为）
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')),
    );
    const ctrl = new AbortController();
    ctrl.abort();

    const harness = createHarness();
    const result = await harness.fetchCloudSummary('id', 'foo.pdf', ctrl.signal);

    expect(result).toBeNull();
  });

  it('sessionAbortSignal 不传时 fetch 仍走内部 15s 硬超时（防御性烟雾）', async () => {
    // 不实际等 15s——只验证 fetch 被调用时 signal 字段非 undefined
    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, opts: { signal?: AbortSignal }) => {
        capturedSignal = opts.signal;
        return { ok: true, status: 200, json: async () => ({ status: 'ready', summary: 'ok' }) };
      }),
    );

    const harness = createHarness();
    await harness.fetchCloudSummary('id', 'foo.pdf');

    expect(capturedSignal).toBeDefined();
    // signal.aborted 应该是 false（fetch 进行中未 abort）
    expect(capturedSignal!.aborted).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// C. 非法 failure_code 字符串走 UNKNOWN_ERROR 中文兜底（isFilePipelineErrorCode 兜底分支）
// ────────────────────────────────────────────────────────────────────

describe('DaemonAgentHost.fetchCloudSummary — 非法 failure_code 走 UNKNOWN_ERROR 中文兜底', () => {
  it('backend 返非法 failure_code 字符串 → 走 UNKNOWN_ERROR 中文文案', async () => {
    mockFetchOnce({
      status: 'failed',
      failure_code: 'something_backend_invented_in_v2', // 不在 SSoT 13 类内
      message: 'irrelevant backend stack',
    });

    const harness = createHarness();
    const result = await harness.fetchCloudSummary('id', 'maybe.pdf');

    const expected = formatFilePipelineErrorChinesePrompt(FilePipelineErrorCode.UNKNOWN_ERROR, {
      filename: 'maybe.pdf',
      rawMessage: 'irrelevant backend stack',
    });
    expect(result).toBe(expected);
    expect(result).toMatch(/未能识别/);
  });

  it('backend 缺 failure_code 字段 → 走 UNKNOWN_ERROR 中文兜底（旧记录兼容）', async () => {
    mockFetchOnce({
      status: 'failed',
      message: 'old record without failure_code',
    });

    const harness = createHarness();
    const result = await harness.fetchCloudSummary('id', 'old.pdf');

    expect(result).not.toBeNull();
    expect(result).toMatch(/未能识别|联系客服/);
    // **W1.4 收尾 Review 1 LOW-3 修复**：原 `not.toContain('failed')` 在某些
    // 文案下假阳性失败（如未来文案含 "upload failed"）；改为更精确的负向断言
    // —— 不含英文裸 enum 字面值 / status 字面值 / [附件:] 兜底占位
    expect(result).not.toMatch(/\b(failed|upstream_error|UNKNOWN_ERROR)\b/i);
    expect(result).not.toContain('[附件:');
  });

  it('backend failure_code = 空字符串 → 走 UNKNOWN_ERROR 中文兜底', async () => {
    mockFetchOnce({
      status: 'failed',
      failure_code: '',
      message: '',
    });

    const harness = createHarness();
    const result = await harness.fetchCloudSummary('id', 'empty.pdf');

    const expected = formatFilePipelineErrorChinesePrompt(FilePipelineErrorCode.UNKNOWN_ERROR, {
      filename: 'empty.pdf',
      rawMessage: '',
    });
    expect(result).toBe(expected);
  });

  it('backend failure_code = null（非字符串）→ 走 UNKNOWN_ERROR 中文兜底', async () => {
    mockFetchOnce({
      status: 'failed',
      failure_code: null,
      message: null,
    });

    const harness = createHarness();
    const result = await harness.fetchCloudSummary('id', 'nully.pdf');

    expect(result).not.toBeNull();
    expect(result).toMatch(/未能识别|联系客服/);
  });
});

// ────────────────────────────────────────────────────────────────────
// D. 旧路径不退化（status='ready' / 'parsing' / 'pending' 行为钉死）
// ────────────────────────────────────────────────────────────────────

describe('DaemonAgentHost.fetchCloudSummary — status=ready/parsing/pending 旧路径不退化', () => {
  it('status=ready + summary → 返回 [文档: filename] + summary 内容', async () => {
    mockFetchOnce({
      status: 'ready',
      summary: '本文档是一份关于 Wave 1.4 的设计纪要。内容足够长，覆盖产品决策与实现约束。',
      title: '设计纪要',
    });

    const harness = createHarness();
    const result = await harness.fetchCloudSummary('id', 'design.pdf');

    expect(result).toMatch(/^\[文档: design\.pdf — 设计纪要\]/);
    expect(result).toContain('本文档是一份关于 Wave 1.4 的设计纪要');
  });

  it('status=ready + 无 title → header 用 [文档: filename]', async () => {
    mockFetchOnce({
      status: 'ready',
      summary: '内容 Body 需要足够长才能通过云端 summary 质量门，避免被当成 stub。',
    });

    const harness = createHarness();
    const result = await harness.fetchCloudSummary('id', 'no-title.pdf');

    expect(result).toMatch(/^\[文档: no-title\.pdf\]\n内容 Body/);
  });

  it('status=ready + 仅表格 stub → 拒绝注入并返回可读错误', async () => {
    mockFetchOnce({
      status: 'ready',
      summary: '[表格: ? 行]',
    });

    const harness = createHarness();
    const result = await harness.fetchCloudSummary('id', 'resume.pdf');

    expect(result).not.toContain('[表格: ? 行]');
    expect(result).toMatch(/简历|文档|解析|扫描|文本|内容/);
  });

  it('status=ready + 空 summary → 拒绝注入可读错误，而非 pending/附件占位', async () => {
    mockFetchOnce({
      status: 'ready',
      summary: '',
      message: '文档已解析完成，但未提取到可用文本',
    });

    const harness = createHarness();
    const result = await harness.fetchCloudSummary('id', 'empty.pptx');

    expect(result).not.toBeNull();
    expect(result).not.toContain('正在解析中');
    expect(result).not.toContain('已触发解析');
    expect(result).not.toContain('[附件:');
    expect(result).toMatch(/扫描|文本|内容|解析/);
  });

  it('status=parsing → 返回"正在解析中" + parse_document hint', async () => {
    mockFetchOnce({ status: 'parsing' });

    const harness = createHarness();
    const result = await harness.fetchCloudSummary('file-id-123', 'wip.pdf');

    expect(result).toContain('[文档: wip.pdf');
    expect(result).toContain('正在解析中');
    expect(result).toContain('parse_document');
    expect(result).toContain('file-id-123');
  });

  it('status=pending → 返回"已触发解析" + parse_document hint', async () => {
    mockFetchOnce({ status: 'pending' });

    const harness = createHarness();
    const result = await harness.fetchCloudSummary('file-id-456', 'queued.pdf');

    expect(result).toContain('[文档: queued.pdf');
    expect(result).toContain('已触发解析');
    expect(result).toContain('parse_document');
    expect(result).toContain('file-id-456');
  });
});

// ────────────────────────────────────────────────────────────────────
// E. 防御性边界（fetch 失败 / 没 token / 网络异常 → 返 null）
// ────────────────────────────────────────────────────────────────────

describe('DaemonAgentHost.fetchCloudSummary — 防御性边界', () => {
  it('getAccessToken 返 null → 直接返 null（不发 fetch）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const harness = createHarness({ token: null });
    const result = await harness.fetchCloudSummary('id', 'foo.pdf');

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resp.ok=false → 返 null', async () => {
    mockFetchOnce({ status: 'ready', summary: 'should not see' }, { ok: false, status: 500 });

    const harness = createHarness();
    const result = await harness.fetchCloudSummary('id', 'foo.pdf');

    expect(result).toBeNull();
  });

  it('fetch 抛 TypeError → catch 路径返 null（不传染上游）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const harness = createHarness();
    const result = await harness.fetchCloudSummary('id', 'foo.pdf');

    expect(result).toBeNull();
  });

  it('未知 status 字段（既非 ready/parsing/pending/failed）→ 返 null', async () => {
    mockFetchOnce({ status: 'unexpected_status_v2', summary: 'never read' });

    const harness = createHarness();
    const result = await harness.fetchCloudSummary('id', 'foo.pdf');

    expect(result).toBeNull();
  });
});
