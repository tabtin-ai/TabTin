/**
 * format.test.ts —— 13 类 File Pipeline 错误码每类至少 1 个 case。
 *
 * 这是 W1 北极星验收的硬指标之一："测试覆盖 13 类错误码每一类有 case"。
 * 新加错误码时务必同步在此添加 case，否则 W1 门禁不通。
 */

import { describe, expect, it } from 'vitest';
import {
  FILE_PIPELINE_ERROR_KINDS,
  FILE_PIPELINE_ERROR_I18N_KEYS,
  FilePipelineErrorCode,
  formatFilePipelineError,
  formatFilePipelineErrorChinesePrompt,
  isFilePipelineErrorCode,
} from '../index.js';

describe('FilePipelineErrorCode 14 类（W5 L17/L38 后）', () => {
  it('FILE_PIPELINE_ERROR_KINDS 全集恰好 14 项（W5 加 IMAGE_RESIZE_FAILED）', () => {
    expect(FILE_PIPELINE_ERROR_KINDS).toHaveLength(14);
  });

  it('format 输出不含 errorCode 数字字段', () => {
    for (const kind of FILE_PIPELINE_ERROR_KINDS) {
      const out = formatFilePipelineError(kind, { filename: 'x.pdf' });
      expect('errorCode' in out).toBe(false);
      expect(out.errorKind).toBe(kind);
    }
  });

  it('每类都有 i18n key 映射', () => {
    for (const kind of FILE_PIPELINE_ERROR_KINDS) {
      expect(FILE_PIPELINE_ERROR_I18N_KEYS[kind]).toBeTypeOf('string');
      expect(FILE_PIPELINE_ERROR_I18N_KEYS[kind].length).toBeGreaterThan(0);
    }
  });

  it('字符串 errorKind 集合互不冲突', () => {
    expect(new Set(FILE_PIPELINE_ERROR_KINDS).size).toBe(
      FILE_PIPELINE_ERROR_KINDS.length,
    );
  });
});

describe('formatFilePipelineError — 每类返回结构正确', () => {
  for (const kind of FILE_PIPELINE_ERROR_KINDS) {
    it(`${kind} 返回完整 envelope`, () => {
      const out = formatFilePipelineError(kind, { filename: 'sample.pdf' });
      expect(out.errorKind).toBe(kind);
      expect('errorCode' in out).toBe(false);
      expect(out.errorKind).toBe(kind);
      expect(out.i18nKey).toBe(FILE_PIPELINE_ERROR_I18N_KEYS[kind]);
      expect(out.message).toBeTypeOf('string');
      expect(out.message.length).toBeGreaterThan(0);
    });
  }
});

describe('formatFilePipelineError — 关键场景文案', () => {
  it('FILE_NOT_FOUND 本地路径走 glob_search 兜底', () => {
    const out = formatFilePipelineError(FilePipelineErrorCode.FILE_NOT_FOUND, {
      filename: 'missing.pdf',
    });
    expect(out.message).toContain('missing.pdf');
    expect(out.suggestion).toBeDefined();
    expect(out.suggestion!.toLowerCase()).toMatch(/verify|glob/);
  });

  // **W1.3 第 3 轮 Review 1 M4（2026-05-13）**：W1.2 fix-4 引入"远程 URL hint
  // 拆分"逻辑（isRemoteUrl 分支），但当时未补单测。新增本 case 钉死这条分支：
  // 远程 URL 不应走 glob_search 引导（永远 0 匹配），改为"OSS 签名过期 / 让用户
  // 重传"路径。
  it('FILE_NOT_FOUND 远程 URL 走 OSS 签名过期 + 重传 hint（不走 glob_search）', () => {
    const out = formatFilePipelineError(FilePipelineErrorCode.FILE_NOT_FOUND, {
      filename: 'report.pdf',
      url: 'https://oss.example.com/private/123456?token=abc',
    });
    // message 应含 URL（而非裸 filename）
    expect(out.message.toLowerCase()).toContain('remote resource');
    expect(out.message).toContain('oss.example.com');
    // hint 应明确说明"URL 可能过期 / 重新上传"，且不应推荐 glob_search
    expect(out.suggestion).toBeDefined();
    expect(out.suggestion!.toLowerCase()).toMatch(
      /url.*expired|re-upload|fresh link/,
    );
    expect(out.suggestion!.toLowerCase()).not.toContain('glob_search');
    // 显式 DO NOT retry，避免 LLM 反复请求过期 URL
    expect(out.suggestion).toMatch(/DO NOT retry/);
  });

  it('FILE_TOO_LARGE image 引导拖入 chat 或降采样', () => {
    const out = formatFilePipelineError(FilePipelineErrorCode.FILE_TOO_LARGE, {
      filename: 'huge.png',
      subject: 'image',
      actualBytes: 25 * 1024 * 1024,
      limitBytes: 20 * 1024 * 1024,
    });
    expect(out.message).toMatch(/25\.0MB|exceeds/);
    expect(out.suggestion).toBeDefined();
    expect(out.suggestion!.toLowerCase()).toMatch(/drag|chat|downsample/);
  });

  it('FILE_TOO_LARGE document 引导拖入 chat 走异步', () => {
    const out = formatFilePipelineError(FilePipelineErrorCode.FILE_TOO_LARGE, {
      filename: 'big.pdf',
      subject: 'document',
      actualBytes: 80 * 1024 * 1024,
      limitBytes: 50 * 1024 * 1024,
    });
    expect(out.suggestion!.toLowerCase()).toMatch(/drag.*chat|async|rag/);
  });

  it('ENCRYPTED 明确 DO NOT retry', () => {
    const out = formatFilePipelineError(FilePipelineErrorCode.ENCRYPTED, {
      filename: 'secret.pdf',
    });
    expect(out.suggestion).toMatch(/DO NOT retry/);
  });

  it('CORRUPTED 明确 DO NOT retry', () => {
    const out = formatFilePipelineError(FilePipelineErrorCode.CORRUPTED, {
      filename: 'broken.docx',
    });
    expect(out.suggestion).toMatch(/DO NOT retry/);
  });

  it('SCANNED_PDF 引导走 chat 的 VLM', () => {
    const out = formatFilePipelineError(FilePipelineErrorCode.SCANNED_PDF, {
      filename: 'scanned.pdf',
    });
    expect(out.suggestion!.toLowerCase()).toMatch(/vlm|drag.*chat/);
  });

  it('GARBLED_TEXT_LAYER 引导走 chat 的 VLM', () => {
    const out = formatFilePipelineError(
      FilePipelineErrorCode.GARBLED_TEXT_LAYER,
      { filename: 'ocr.pdf' },
    );
    expect(out.suggestion!.toLowerCase()).toMatch(/vlm|drag.*chat/);
  });

  it('UNSUPPORTED_FORMAT 列出 .pptx 引导', () => {
    const out = formatFilePipelineError(
      FilePipelineErrorCode.UNSUPPORTED_FORMAT,
      { filename: 'deck.pptx', format: '.pptx' },
    );
    expect(out.message).toContain('.pptx');
    expect(out.suggestion!.toLowerCase()).toContain('chat');
  });

  // **W5 L31/L38（2026-05-14）**：sharp 缩放失败已拆为独立 `IMAGE_RESIZE_FAILED`
  // kind，不再走 FILE_TOO_LARGE rawMessage 检测。本测试钉死
  // sharp 失败三类（unavailable / decode_failed / too_large_after_resize）
  // 全部走 IMAGE_RESIZE_FAILED 专属语义，与 FILE_TOO_LARGE "原图超 50MB 硬上限"
  // 完全脱耦。
  it.each([
    ['sharp_unavailable', /sharp library is not installed/i],
    ['sharp_decode_failed', /sharp could not decode/i],
    ['too_large_after_resize', /even after auto-resize/i],
  ] as const)(
    'IMAGE_RESIZE_FAILED resizeFailureCause=%s 走专属 cause phrase（与 FILE_TOO_LARGE 物理脱耦）',
    (cause, causePattern) => {
      const out = formatFilePipelineError(
        FilePipelineErrorCode.IMAGE_RESIZE_FAILED,
        {
          filename: 'photo.heic',
          subject: 'image',
          actualBytes: 6 * 1024 * 1024,
          resizeFailureCause: cause,
        },
      );
      expect(out.errorKind).toBe('image_resize_failed');
      expect(out.i18nKey).toBe('image_resize_failed');
      // 反向断言：绝不复用 FILE_TOO_LARGE 的 "Image exceeds the NMB read_file
      // hard size limit" 完整文案（细化反向断言：避免匹到 "even though under
      // the 50mb hard cap" 这种合理的"提示用户 size 没超 cap"信息）
      expect(out.message.toLowerCase()).not.toMatch(
        /image exceeds the .* read_file hard size limit/,
      );
      expect(out.message.toLowerCase()).not.toMatch(
        /exceeds.*read_file hard size limit/,
      );
      // 正向断言：含 cause-specific phrase
      expect(out.message).toMatch(causePattern);
      expect(out.message).toMatch(/Local image processing failed/);
      // suggestion 引导上传 chat（云端 image pipeline 不同），DO NOT 本地重试
      expect(out.suggestion).toMatch(/upload.*chat/);
      expect(out.suggestion).toMatch(/DO NOT retry locally/);
    },
  );

  // **W5 L31 钉死**：rawMessage 字段**不影响** FILE_TOO_LARGE message/suggestion 派发
  // ——历史 W2.1 用 `rawMessage.startsWith('Auto-resize failed')` 字符串前缀检测
  // fork suggestion 文案（跨包字符串契约脆弱反模式，反思 §八 #13），W5 L31 改为
  // 结构化 ctx 字段决策。本测试钉死 rawMessage 字面值变化不会让 message/suggestion
  // 退化（避免 reviewer 又把 rawMessage 检测加回来）。
  it('FILE_TOO_LARGE image: rawMessage 字面值不影响 message/suggestion 派发（W5 L31 钉死 ctx.subject 是唯一真相源）', () => {
    const baseCtx = {
      filename: 'huge.png',
      subject: 'image' as const,
      actualBytes: 80 * 1024 * 1024,
      limitBytes: 50 * 1024 * 1024,
    };
    const noRaw = formatFilePipelineError(
      FilePipelineErrorCode.FILE_TOO_LARGE,
      baseCtx,
    );
    const withResizeRaw = formatFilePipelineError(
      FilePipelineErrorCode.FILE_TOO_LARGE,
      {
        ...baseCtx,
        rawMessage: 'Auto-resize failed (sharp_decode_failed): foo',
      },
    );
    const withMagicRaw = formatFilePipelineError(
      FilePipelineErrorCode.FILE_TOO_LARGE,
      {
        ...baseCtx,
        rawMessage: 'content does not match any known image format',
      },
    );
    // 三种 rawMessage 都应走相同 hard cap 文案——message/suggestion 完全一致
    expect(noRaw.message).toBe(withResizeRaw.message);
    expect(noRaw.message).toBe(withMagicRaw.message);
    expect(noRaw.suggestion).toBe(withResizeRaw.suggestion);
    expect(noRaw.suggestion).toBe(withMagicRaw.suggestion);
    // 都走 hard cap 分支
    expect(noRaw.message).toMatch(
      /Image exceeds the 50(\.0)?MB read_file hard size limit/,
    );
    expect(noRaw.suggestion).toMatch(/upload the image via chat/);
  });

  // **W5 L31（2026-05-14）**：UNSUPPORTED_FORMAT magic-mismatch 走 ctx.failureMode +
  // ctx.subject 派发，**不再** rawMessage 字面值前缀检测。
  it('UNSUPPORTED_FORMAT failureMode=magic_mismatch + subject=image 走 image 专属"重新导出"引导', () => {
    const out = formatFilePipelineError(
      FilePipelineErrorCode.UNSUPPORTED_FORMAT,
      {
        filename: 'fake.png',
        format: '.png',
        subject: 'image',
        failureMode: 'magic_mismatch',
        rawMessage:
          'detected: image/jpeg. The file may be corrupted, mislabeled, or actually a different binary format.',
      },
    );
    // 不应建议主动上传到 chat（"DO NOT recommend uploading via chat" 反向引导）
    expect(out.suggestion).not.toMatch(/ask the user to upload.*via chat/i);
    // 应引导"重新导出 / 改扩展名"
    expect(out.suggestion).toMatch(/re-export|Preview|rename/i);
    // 反向防御：必须明确说"不推 chat 上传"
    expect(out.suggestion).toMatch(/DO NOT recommend uploading via chat/);
    // message 含文件名 + 透传 raw 给 LLM 上下文
    expect(out.message).toContain('fake.png');
    expect(out.message).toMatch(
      /content does not match any known image format/,
    );
  });

  it('UNSUPPORTED_FORMAT failureMode=magic_mismatch + subject=presentation 走 PPTX 专属"重新导出"引导', () => {
    const out = formatFilePipelineError(
      FilePipelineErrorCode.UNSUPPORTED_FORMAT,
      {
        filename: 'mislabeled.pptx',
        format: '.pptx',
        subject: 'presentation',
        failureMode: 'magic_mismatch',
        rawMessage:
          'detected magic header bytes do not match ZIP (50 4B 03 04) nor OLE Compound File (D0 CF 11 E0).',
      },
    );

    // 核心断言：引导 Save As / re-download / 验证 PowerPoint 能打开
    expect(out.suggestion).toMatch(
      /Save As|re-download|verify.*opens|legacy \.ppt/i,
    );
    // 反向防御 1：明确说"不推 chat 上传"
    expect(out.suggestion).toMatch(/DO NOT recommend uploading via chat/);
    // 反向断言：suggestion 不含通用 UNSUPPORTED_FORMAT 分支措辞
    expect(out.suggestion).not.toMatch(
      /drag-and-drop on desktop|use the attach\/\+ button on mobile/,
    );
    expect(out.suggestion).not.toMatch(/audio.*video|\.mp3|\.mp4/);
    expect(out.suggestion).not.toMatch(/archives|\.zip|\.tar\.gz/);
    expect(out.suggestion).not.toMatch(/no path to read this file content/);

    // message 含文件名 + 扩展名上下文 + 透传 raw
    expect(out.message).toContain('mislabeled.pptx');
    expect(out.message).toContain('.pptx');
    expect(out.message).toMatch(
      /neither a valid PPTX|nor an OLE Compound File/,
    );
  });

  // **W5 L31 钉死**：UNSUPPORTED_FORMAT 在 failureMode 缺失时**绝不**根据 rawMessage
  // 字面值 fork 派发——历史 `rawMessage.includes('does not start with PPTX magic bytes')`
  // 检测已删除。reviewer 不应再把 rawMessage 检测加回来。
  it('UNSUPPORTED_FORMAT: rawMessage 字面值不影响 message/suggestion 派发（W5 L31 钉死 failureMode 是唯一真相源）', () => {
    const baseCtx = {
      filename: 'mp3.mp3',
      format: '.mp3',
    };
    const noRaw = formatFilePipelineError(
      FilePipelineErrorCode.UNSUPPORTED_FORMAT,
      baseCtx,
    );
    const withMagicRaw = formatFilePipelineError(
      FilePipelineErrorCode.UNSUPPORTED_FORMAT,
      {
        ...baseCtx,
        rawMessage: 'content does not match any known image format magic bytes',
      },
    );
    const withPptxRaw = formatFilePipelineError(
      FilePipelineErrorCode.UNSUPPORTED_FORMAT,
      {
        ...baseCtx,
        rawMessage: 'File does not start with PPTX magic bytes',
      },
    );
    // 三种 rawMessage 都走通用 fallthrough（subject 缺省 / failureMode 缺省）
    expect(noRaw.message).toBe(withMagicRaw.message);
    expect(noRaw.message).toBe(withPptxRaw.message);
    expect(noRaw.suggestion).toBe(withMagicRaw.suggestion);
    expect(noRaw.suggestion).toBe(withPptxRaw.suggestion);
    // 走通用三段引导（：含 audio ASR + video）
    expect(noRaw.suggestion).toMatch(/audio|\.mp3|\.mp4/);
    expect(noRaw.suggestion!.toLowerCase()).toMatch(/asr|auto-transcrib|video/);
  });

  // 必须三段引导齐全——不能再让 LLM 把 .xls / .key / .zip / .mp4 等推到错误路径。
  // （：音频拖入聊天会 ASR；文档解析路径仍不读音频/视频/archive。）
  // 本测试钉死三段措辞：
  //   (1) .pptx → chat 通道（modern）
  //   (2) 老 Office (.doc/.xls/.key) → 先转新格式
  //   (3) 音频走 chat ASR；视频 / archive / 可执行文件 → 文档解析无路径
  //
  // **W2.1 Review 3 fix-6（2026-05-13）**：HEIC 在 W2.1 加入 IMAGE_EXTS 走
  // sharp 缩放路径，UNSUPPORTED_FORMAT hint 不再列 HEIC（HEIC 走 image 路径
  // 成功；如缩放失败则走 FILE_TOO_LARGE 而非 UNSUPPORTED_FORMAT）。
  it('UNSUPPORTED_FORMAT hint 含三段引导（.pptx / 老格式 / 音频 ASR + 视频归无路径）', () => {
    const out = formatFilePipelineError(
      FilePipelineErrorCode.UNSUPPORTED_FORMAT,
      { filename: 'demo.mp3', format: '.mp3' },
    );
    const lower = out.suggestion!.toLowerCase();
    // 段 1：modern PPTX 走 chat
    expect(lower).toMatch(/\.pptx/);
    expect(lower).toMatch(/chat/);
    // 段 2：legacy Office / iWork 明确引导先转新格式
    expect(lower).toMatch(/legacy office|legacy.*\.doc|export.*modern|convert/);
    // 段 3：音频 chat ASR；视频 / archive 文档解析不支持
    expect(lower).toMatch(/audio|\.mp3/);
    expect(lower).toMatch(/asr|auto-transcrib/);
    expect(lower).toMatch(/video|\.mp4/);
    expect(lower).toMatch(/archives|\.zip/);
    expect(lower).toMatch(/neither read_file|no path to read|document-parse/);
    // 终极防御：DO NOT retry 防 LLM 反复试
    expect(out.suggestion).toMatch(/DO NOT retry/);
  });

  it('PARSE_TIMEOUT 含 timeout 上下文', () => {
    const out = formatFilePipelineError(FilePipelineErrorCode.PARSE_TIMEOUT, {
      filename: 'slow.pdf',
      timeoutMs: 8000,
    });
    expect(out.message).toMatch(/timed out|8\.0s/);
    expect(out.suggestion).toBeDefined();
  });

  it('USER_ABORTED 不带 suggestion', () => {
    const out = formatFilePipelineError(FilePipelineErrorCode.USER_ABORTED, {
      filename: 'cancelled.pdf',
    });
    expect(out.message).toMatch(/aborted|cancelled/);
    expect(out.suggestion).toBeUndefined();
  });

  it('NETWORK_ERROR 含 URL / retry once 建议', () => {
    const out = formatFilePipelineError(FilePipelineErrorCode.NETWORK_ERROR, {
      url: 'https://oss.example.com/file.pdf',
      rawMessage: 'fetch failed: timeout',
    });
    expect(out.message).toContain('oss.example.com');
    expect(out.suggestion!.toLowerCase()).toMatch(/check connectivity|retry/);
  });

  it('INVALID_PARAMETER 沿用 rawMessage', () => {
    const out = formatFilePipelineError(
      FilePipelineErrorCode.INVALID_PARAMETER,
      { rawMessage: "'path' is required and must be a non-empty string" },
    );
    expect(out.message).toContain("'path'");
  });

  it('UNKNOWN_ERROR 兜底 + 引导 chat / support（不暴露 raw 技术词给 LLM）', () => {
    const out = formatFilePipelineError(FilePipelineErrorCode.UNKNOWN_ERROR, {
      filename: 'mystery.bin',
      rawMessage: 'segfault',
    });
    expect(out.message).toContain('mystery.bin');
    // **W1.2 Review 收尾**：raw 技术词（"segfault" / errno 0x...）不再原封
    // 进 message —— LLM 转述给用户时不会带专业术语让用户一脸问号。如调用方
    // 需要 raw 做观测，应自行记入 envelope.metadata，不污染 LLM-facing 文本。
    expect(out.message).not.toContain('segfault');
    expect(out.suggestion!.toLowerCase()).toMatch(/chat|support/);
  });
});

// **W1.3 第 3 轮 Review 2 S1（2026-05-13）**：持久通道 main agent prompt 注入路径
// 使用的中文转述派发器。13 类全覆盖（与 LLM-facing 英文 SSoT 同源），让 main agent
// fetchCloudSummary 在 status='failed' 时能调本函数生成 Agent 上下文。
describe('formatFilePipelineErrorChinesePrompt — 13 类中文转述', () => {
  for (const kind of FILE_PIPELINE_ERROR_KINDS) {
    it(`${kind} 返回非空中文文本`, () => {
      const text = formatFilePipelineErrorChinesePrompt(kind, {
        filename: 'sample.pdf',
      });
      expect(text).toBeTypeOf('string');
      expect(text.length).toBeGreaterThan(0);
      // 文档头：必含 filename
      expect(text).toContain('sample.pdf');
    });
  }

  it('ENCRYPTED 中文文案明确"密码保护"', () => {
    const text = formatFilePipelineErrorChinesePrompt(
      FilePipelineErrorCode.ENCRYPTED,
      { filename: 'secret.pdf' },
    );
    expect(text).toMatch(/密码保护/);
    expect(text).toMatch(/未加密|移除密码/);
  });

  it('SCANNED_PDF 中文文案明示"按页计费"', () => {
    const text = formatFilePipelineErrorChinesePrompt(
      FilePipelineErrorCode.SCANNED_PDF,
      { filename: 'scan.pdf' },
    );
    expect(text).toMatch(/扫描件/);
    expect(text).toMatch(/按页计费/);
  });

  it('GARBLED_TEXT_LAYER 中文文案明示"按页计费"', () => {
    const text = formatFilePipelineErrorChinesePrompt(
      FilePipelineErrorCode.GARBLED_TEXT_LAYER,
      { filename: 'ocr.pdf' },
    );
    expect(text).toMatch(/质量过低|OCR/);
    expect(text).toMatch(/按页计费/);
  });

  it('UNSUPPORTED_FORMAT 中文文案声明音频 ASR、视频 / archive 不支持文档解析', () => {
    const text = formatFilePipelineErrorChinesePrompt(
      FilePipelineErrorCode.UNSUPPORTED_FORMAT,
      { filename: 'song.mp3' },
    );
    expect(text).toMatch(/音频|\.mp3|\.mp4/);
    expect(text).toMatch(/语音识别|ASR/);
    expect(text).toMatch(/视频|\.mp4|\.mov/);
    expect(text).toMatch(/压缩包|\.zip/);
    expect(text).toMatch(/老格式|\.doc|\.key/);
  });

  it('FILE_TOO_LARGE 含 localLimitMb + file_id INTERNAL hint', () => {
    const text = formatFilePipelineErrorChinesePrompt(
      FilePipelineErrorCode.FILE_TOO_LARGE,
      {
        filename: 'big.pdf',
        localLimitMb: 50,
        fileIdForParseDocument: 'file-abc-123',
      },
    );
    expect(text).toContain('50MB');
    expect(text).toContain('file-abc-123');
    expect(text).toContain('[INTERNAL');
    expect(text).toContain('parse_document');
  });

  it('FILE_TOO_LARGE 缺省 localLimitMb 不出现 undefined', () => {
    const text = formatFilePipelineErrorChinesePrompt(
      FilePipelineErrorCode.FILE_TOO_LARGE,
      { filename: 'big.pdf' },
    );
    expect(text).not.toContain('undefined');
    expect(text).toContain('本地处理上限');
  });

  it('UNKNOWN_ERROR 不暴露 raw 技术词给用户', () => {
    const text = formatFilePipelineErrorChinesePrompt(
      FilePipelineErrorCode.UNKNOWN_ERROR,
      {
        filename: 'mystery.bin',
        rawMessage: 'ECONNABORTED 0x10054',
      },
    );
    expect(text).toContain('mystery.bin');
    // raw 技术词不应进 prompt 上下文
    expect(text).not.toContain('ECONNABORTED');
    expect(text).not.toContain('0x10054');
  });

  it('USER_ABORTED 返回最小防御性兜底文本', () => {
    const text = formatFilePipelineErrorChinesePrompt(
      FilePipelineErrorCode.USER_ABORTED,
      { filename: 'cancelled.pdf' },
    );
    expect(text).toMatch(/取消/);
    expect(text).toContain('cancelled.pdf');
  });
});

describe('isFilePipelineErrorCode — type guard', () => {
  it('合法字面值返 true', () => {
    expect(isFilePipelineErrorCode('file_not_found')).toBe(true);
    expect(isFilePipelineErrorCode('scanned_pdf')).toBe(true);
    expect(isFilePipelineErrorCode('garbled_text_layer')).toBe(true);
  });

  it('未知字符串返 false', () => {
    expect(isFilePipelineErrorCode('')).toBe(false);
    expect(isFilePipelineErrorCode('unknown_code')).toBe(false);
    expect(isFilePipelineErrorCode('garbled')).toBe(false); // 已退役旧字面值
    expect(isFilePipelineErrorCode('oversize')).toBe(false); // 已退役
  });

  it('非字符串返 false（防 backend null / undefined / object）', () => {
    expect(isFilePipelineErrorCode(undefined)).toBe(false);
    expect(isFilePipelineErrorCode(null)).toBe(false);
    expect(isFilePipelineErrorCode(123)).toBe(false);
    expect(isFilePipelineErrorCode({})).toBe(false);
  });
});
