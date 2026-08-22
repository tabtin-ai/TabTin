/**
 * Error classifier unit tests — covers 18+ classification branches.
 */

import { describe, it, expect } from 'vitest';
import { classifyError, isReportableRunError } from '../src/engine/errors/error-classifier.js';
import type { ErrorCategory } from '../src/engine/errors/error-classifier.js';
import {
  AgentError,
} from '../src/engine/contracts/kernel.js';

describe('classifyError', () => {
  // ─── AgentError with statusCode ────────────────────────────────────

  it('529 → rate_limit, showAsAssistant false', () => {
    const err = new AgentError('LLM overloaded', 'LLM_ERROR', { statusCode: 529 });
    const c = classifyError(err);
    expect(c.category).toBe('rate_limit');
    expect(c.code).toBe('LLM_ERROR');
    expect(c.statusCode).toBe(529);
    expect(c.retryable).toBe(true);
    expect(c.showAsAssistant).toBe(false);
  });

  it('429 → rate_limit with retryAfterMs', () => {
    const err = new AgentError('Rate limit', 'LLM_RATE_LIMIT', {
      statusCode: 429,
      retryAfterMs: 5000,
    });
    const c = classifyError(err);
    expect(c.category).toBe('rate_limit');
    expect(c.code).toBe('LLM_RATE_LIMIT');
    expect(c.retryable).toBe(true);
    expect(c.retryAfterMs).toBe(5000);
    expect(c.showAsAssistant).toBe(true);
    expect(c.userMessage).toContain('5');
  });

  it('429 without retryAfterMs → generic message', () => {
    const err = new AgentError('Rate limit', 'LLM_RATE_LIMIT', { statusCode: 429 });
    const c = classifyError(err);
    expect(c.userMessage).toContain('稍后');
  });

  it('402 → billing', () => {
    const err = new AgentError('No credits', 'LLM_BILLING_ERROR', { statusCode: 402 });
    const c = classifyError(err);
    expect(c.category).toBe('billing');
    expect(c.suggestedAction).toBe('check_billing');
    expect(c.showAsAssistant).toBe(true);
  });

  it('billing_charge_failed 尾帧 → 结算异常可重试，不伪装余额不足', () => {
    const err = new AgentError(
      'LLM 调用已完成但计费结算失败，请稍后重试。',
      'LLM_ERROR',
      {
        retryable: false,
        details: {
          chargeStatus: 'failed',
          error_type: 'billing_charge_failed',
          error_category: 'billing_charge_failed',
          fromBillingTail: true,
        },
      },
    );
    const c = classifyError(err);
    expect(c.code).toBe('LLM_ERROR');
    expect(c.category).toBe('server_error');
    expect(c.retryable).toBe(true);
    expect(c.suggestedAction).toBe('retry_later');
    expect(c.userMessage).toBe('服务结算异常，请稍后重试');
  });

  it('organization_insufficient_credits 尾帧 → 组织余额不足不可重试', () => {
    const err = new AgentError(
      '组织钱包余额不足，请充值后继续使用。',
      'LLM_BILLING_ERROR',
      {
        statusCode: 402,
        retryable: false,
        details: {
          chargeStatus: 'failed',
          error_type: 'organization_insufficient_credits',
          error_category: 'organization_insufficient_credits',
          fromBillingTail: true,
        },
      },
    );
    const c = classifyError(err);
    expect(c.category).toBe('organization_insufficient_credits');
    expect(c.retryable).toBe(false);
    expect(c.suggestedAction).toBe('check_billing');
  });

  it('401 → auth', () => {
    const err = new AgentError('Unauthorized', 'LLM_ERROR', { statusCode: 401 });
    const c = classifyError(err);
    expect(c.category).toBe('auth');
    expect(c.suggestedAction).toBe('relogin');
  });

  it('403 → auth', () => {
    const err = new AgentError('Forbidden', 'LLM_ERROR', { statusCode: 403 });
    const c = classifyError(err);
    expect(c.category).toBe('auth');
  });

  it('413 → context_overflow', () => {
    const err = new AgentError('prompt is too long', 'CONTEXT_OVERFLOW', { statusCode: 413 });
    const c = classifyError(err);
    expect(c.category).toBe('context_overflow');
    expect(c.suggestedAction).toBe('shorten_context');
  });

  it('400 with tool_use error → internal, showAsAssistant false', () => {
    const err = new AgentError(
      'tool_use block without tool_result',
      'LLM_ERROR',
      { statusCode: 400 },
    );
    const c = classifyError(err);
    expect(c.category).toBe('internal');
    expect(c.showAsAssistant).toBe(false);
  });

  it('400 with invalid model → switch_model', () => {
    const err = new AgentError('invalid model xyz', 'LLM_ERROR', { statusCode: 400 });
    const c = classifyError(err);
    expect(c.suggestedAction).toBe('switch_model');
    expect(c.showAsAssistant).toBe(true);
  });

  it('500 → server_error', () => {
    const err = new AgentError('Internal server error', 'LLM_ERROR', { statusCode: 500 });
    const c = classifyError(err);
    expect(c.category).toBe('server_error');
    expect(c.retryable).toBe(true);
  });

  it('502 → server_error', () => {
    const err = new AgentError('Bad gateway', 'LLM_ERROR', { statusCode: 502 });
    const c = classifyError(err);
    expect(c.category).toBe('server_error');
  });

  // ─── AgentError by code (no statusCode) ────────────────────────────

  it('LLM_KEY_EXHAUSTED (platform) → server_error', () => {
    const err = new AgentError('Keys exhausted', 'LLM_KEY_EXHAUSTED');
    const c = classifyError(err);
    expect(c.category).toBe('server_error');
    expect(c.code).toBe('LLM_KEY_EXHAUSTED');
    expect(c.retryable).toBe(true);
    expect(c.userMessage).toContain('服务暂时繁忙');
  });

  it('LLM_KEY_EXHAUSTED (BYOK) → billing', () => {
    const err = new AgentError('Keys exhausted', 'LLM_KEY_EXHAUSTED', { isByok: true });
    const c = classifyError(err);
    expect(c.category).toBe('billing');
    expect(c.code).toBe('LLM_KEY_EXHAUSTED');
    expect(c.retryable).toBe(false);
    expect(c.suggestedAction).toBe('check_billing');
    expect(c.userMessage).toContain('API Key');
  });

  it('TOOL_ERROR → tool_error', () => {
    const err = new AgentError('Tool failed', 'TOOL_ERROR');
    const c = classifyError(err);
    expect(c.category).toBe('tool_error');
    expect(c.showAsAssistant).toBe(false);
  });

  it('TOOL_TIMEOUT → tool_error', () => {
    const err = new AgentError('Timeout', 'TOOL_TIMEOUT');
    const c = classifyError(err);
    expect(c.category).toBe('tool_error');
  });

  it('PERMISSION_DENIED → permission', () => {
    const err = new AgentError('Denied', 'PERMISSION_DENIED');
    const c = classifyError(err);
    expect(c.category).toBe('permission');
    expect(c.showAsAssistant).toBe(false);
  });

  it('PERMISSION_TIMEOUT → permission, showAsAssistant true', () => {
    const err = new AgentError('Timed out', 'PERMISSION_TIMEOUT');
    const c = classifyError(err);
    expect(c.category).toBe('permission');
    expect(c.showAsAssistant).toBe(true);
    expect(c.userMessage).toContain('授权超时');
  });

  it('MAX_TURNS_EXCEEDED → budget_exceeded', () => {
    const err = new AgentError('Too many turns', 'MAX_TURNS_EXCEEDED');
    const c = classifyError(err);
    expect(c.category).toBe('budget_exceeded');
    expect(c.showAsAssistant).toBe(true);
  });

  it('MAX_CREDITS_EXCEEDED → budget_exceeded', () => {
    const err = new AgentError('Credits exceeded', 'MAX_CREDITS_EXCEEDED');
    const c = classifyError(err);
    expect(c.category).toBe('budget_exceeded');
    expect(c.suggestedAction).toBe('check_billing');
  });

  it('DOOM_LOOP_DETECTED → doom_loop', () => {
    const err = new AgentError('Loop detected', 'DOOM_LOOP_DETECTED');
    const c = classifyError(err);
    expect(c.category).toBe('doom_loop');
    expect(c.showAsAssistant).toBe(true);
    expect(c.userMessage).toContain('循环');
  });

  it('ABORT → abort', () => {
    const err = new AgentError('Aborted', 'ABORT');
    const c = classifyError(err);
    expect(c.category).toBe('abort');
    expect(c.showAsAssistant).toBe(false);
  });

  it('network error → network', () => {
    const err = new AgentError('unreachable', 'LLM_ERROR', {
      retryable: true,
      details: { networkError: true },
    });
    const c = classifyError(err);
    expect(c.category).toBe('network');
  });

  // ─── Non-AgentError inputs ─────────────────────────────────────────

  it('plain Error → internal', () => {
    const c = classifyError(new Error('something broke'));
    expect(c.category).toBe('internal');
    expect(c.code).toBe('INTERNAL');
    expect(c.showAsAssistant).toBe(true);
  });

  it('string → internal', () => {
    const c = classifyError('random string');
    expect(c.category).toBe('internal');
    expect(c.originalError).toBe('random string');
  });

  it('null → internal', () => {
    const c = classifyError(null);
    expect(c.category).toBe('internal');
  });

  it('undefined → internal', () => {
    const c = classifyError(undefined);
    expect(c.category).toBe('internal');
  });

  it('Error with status property → classified by status', () => {
    const err = Object.assign(new Error('bad'), { status: 429 });
    const c = classifyError(err);
    expect(c.category).toBe('rate_limit');
    expect(c.statusCode).toBe(429);
  });

  it('prompt too long in message → context_overflow', () => {
    const c = classifyError(new Error('prompt is too long for this model'));
    expect(c.category).toBe('context_overflow');
  });

  it('context_length_exceeded in message → context_overflow', () => {
    const c = classifyError(new Error('context_length_exceeded'));
    expect(c.category).toBe('context_overflow');
  });

  // ─── originalError preserved ───────────────────────────────────────

  it('originalError is always set', () => {
    const orig = new Error('test');
    const c = classifyError(orig);
    expect(c.originalError).toBe(orig);
  });

  // ─── W0 (v0.2.1):后端 SSE error chunk 渲染好的中文文案优先 ────────

  describe('fromProxySSE: 优先采用后端 user_message', () => {
    it('budget_exceeded 后端文案直接当 userMessage,走 billing category', () => {
      const err = new AgentError(
        '本次请求超出预算限制。请检查 Organization 配额或联系管理员。',
        'LLM_ERROR',
        {
          statusCode: 402,
          retryable: false,
          details: {
            fromProxySSE: true,
            user_message: '本次请求超出预算限制。请检查 Organization 配额或联系管理员。',
            error_type: 'budget_exceeded',
            technical_detail: 'stage=billing reason=budget_exceeded',
          },
        },
      );
      const c = classifyError(err);
      expect(c.userMessage).toContain('预算');
      expect(c.userMessage).toContain('Organization');
      expect(c.category).toBe('billing');
      expect(c.suggestedAction).toBe('check_billing');
      expect(c.retryable).toBe(false);
      expect(c.showAsAssistant).toBe(true);
    });

    it('image_fetch_timeout 后端含主机名的中文 + network category', () => {
      const err = new AgentError(
        '图片下载超时(主机:example-assets.oss-cn-wuhan-lr.aliyuncs.com,超时 5.0s)。请检查网络或重新上传后再试。',
        'LLM_ERROR',
        {
          statusCode: 504,
          retryable: false,
          details: {
            fromProxySSE: true,
            user_message: '图片下载超时(主机:example-assets.oss-cn-wuhan-lr.aliyuncs.com,超时 5.0s)。请检查网络或重新上传后再试。',
            error_type: 'image_fetch_timeout',
          },
        },
      );
      const c = classifyError(err);
      expect(c.userMessage).toContain('example-assets.oss-cn-wuhan-lr.aliyuncs.com');
      expect(c.userMessage).toContain('图片下载');
      expect(c.category).toBe('network');
      expect(c.retryable).toBe(false);  // 后端已重试过,前端不再 retry storm
    });

    it('model_not_found 走 server_error + switch_model 引导', () => {
      const err = new AgentError(
        '模型 "claude-bogus" 不存在或未激活。请刷新页面或换 model。',
        'LLM_ERROR',
        {
          statusCode: 404,
          details: {
            fromProxySSE: true,
            user_message: '模型 "claude-bogus" 不存在或未激活。请刷新页面或换 model。',
            error_type: 'model_not_found',
          },
        },
      );
      const c = classifyError(err);
      expect(c.userMessage).toContain('claude-bogus');
      expect(c.category).toBe('server_error');
      expect(c.suggestedAction).toBe('switch_model');
    });

    it('upstream_error 4xx 走 server_error + retry_later', () => {
      const err = new AgentError(
        '上游服务返回错误(400)。可能原因:模型暂时不可用 / 配额限制 / 请求格式错误。请稍后重试或换 model。',
        'LLM_ERROR',
        {
          statusCode: 400,
          details: {
            fromProxySSE: true,
            user_message: '上游服务返回错误(400)。可能原因:模型暂时不可用 / 配额限制 / 请求格式错误。请稍后重试或换 model。',
            error_type: 'upstream_error',
          },
        },
      );
      const c = classifyError(err);
      expect(c.userMessage).toContain('上游');
      expect(c.userMessage).toContain('400');
      expect(c.category).toBe('server_error');
      expect(c.retryable).toBe(false);  // 非 429/529/503 的 fromProxySSE 仍 non-retryable
    });

    it('fromProxySSE 429 过载标记为 retryable', () => {
      const err = new AgentError(
        '模型上游返回错误（429）……建议换一个模型重试',
        'LLM_ERROR',
        {
          statusCode: 429,
          details: {
            fromProxySSE: true,
            user_message: '模型上游返回错误（429）……建议换一个模型重试',
            error_type: 'upstream_error',
          },
        },
      );
      const c = classifyError(err);
      expect(c.retryable).toBe(true);
      expect(c.suggestedAction).toBe('retry_later');
    });

    it('火山 burst 限流英文原文 → LLM_RATE_LIMIT + 模型暂不可用文案', () => {
      const burst =
        'System protection triggered by request burst. Please slow down traffic growth '
        + 'and increase requests gradually before retrying.';
      const err = new AgentError(burst, 'LLM_ERROR', {
        details: {
          fromProxySSE: true,
          user_message: burst,
          error_type: 'proxy_error',
        },
      });
      const c = classifyError(err);
      expect(c.code).toBe('LLM_RATE_LIMIT');
      expect(c.category).toBe('rate_limit');
      expect(c.retryable).toBe(true);
      expect(c.suggestedAction).toBe('switch_model');
      expect(c.userMessage).toBe('该模型暂无法使用，请稍后重试或更换模型');
      expect(c.showAsAssistant).toBe(true);
    });

    it('upstream_rate_limited → 模型暂不可用文案', () => {
      const err = new AgentError(
        '该模型暂无法使用，请稍后重试或更换模型',
        'LLM_RATE_LIMIT',
        {
          statusCode: 429,
          details: {
            fromProxySSE: true,
            user_message: '该模型暂无法使用，请稍后重试或更换模型',
            error_type: 'upstream_rate_limited',
          },
        },
      );
      const c = classifyError(err);
      expect(c.code).toBe('LLM_RATE_LIMIT');
      expect(c.category).toBe('rate_limit');
      expect(c.suggestedAction).toBe('switch_model');
      expect(c.userMessage).toBe('该模型暂无法使用，请稍后重试或更换模型');
    });

    it('非 fromProxySSE 的 burst 原文也映射为模型暂不可用', () => {
      const err = new AgentError(
        'System protection triggered by request burst. Please slow down.',
        'LLM_ERROR',
      );
      const c = classifyError(err);
      expect(c.code).toBe('LLM_RATE_LIMIT');
      expect(c.userMessage).toBe('该模型暂无法使用，请稍后重试或更换模型');
      expect(c.suggestedAction).toBe('switch_model');
    });

    it('image_not_supported (capability gate) 走 server_error + switch_model 按钮', () => {
      // wire_adapter._normalize_images 抛 CapabilityGateError 时 error_code=
      // 'image_not_supported',proxy_service yield SSE chunk 时 type='image_not_supported'。
      // 前端期望:中文气泡告诉用户"换 Claude/GPT-4o",同时 suggestedAction=switch_model
      // 让 ChatPanel 渲染"切换模型"按钮(MessageBubble.ACTION_LABELS 待补)。
      const err = new AgentError(
        '当前模型 "MiniMax-Text-01" 不支持图片输入。建议:换一个模型(如 Claude/GPT-4o/Qwen-VL),或移除图片后重发。',
        'LLM_ERROR',
        {
          statusCode: 400,
          retryable: false,
          details: {
            fromProxySSE: true,
            user_message:
              '当前模型 "MiniMax-Text-01" 不支持图片输入。建议:换一个模型(如 Claude/GPT-4o/Qwen-VL),或移除图片后重发。',
            error_type: 'image_not_supported',
          },
        },
      );
      const c = classifyError(err);
      expect(c.userMessage).toContain('不支持图片输入');
      expect(c.userMessage).toContain('换一个模型');
      expect(c.category).toBe('server_error');
      expect(c.suggestedAction).toBe('switch_model');
    });

    it('image_input_via_unsupported (caps 只接受 file_id) 走 server_error + switch_model', () => {
      const err = new AgentError(
        '当前模型 不支持图片输入。建议:换一个模型,或移除图片后重发。',
        'LLM_ERROR',
        {
          statusCode: 400,
          retryable: false,
          details: {
            fromProxySSE: true,
            user_message: '当前模型 不支持图片输入。建议:换一个模型,或移除图片后重发。',
            error_type: 'image_input_via_unsupported',
          },
        },
      );
      const c = classifyError(err);
      expect(c.category).toBe('server_error');
      expect(c.suggestedAction).toBe('switch_model');
    });

    it('image_fetch_failed (W0 风通用 error_code) 走 network + retry_later', () => {
      // proxy_service.proxy_stream_events 在 ImageFetchError catch 里给的
      // error_code 是 exc.error_code or "image_fetch_failed",兜底 code。
      const err = new AgentError(
        '图片下载超时(主机:oss.example.com,共 1 张图,1 张失败)。',
        'LLM_ERROR',
        {
          statusCode: 502,
          retryable: false,
          details: {
            fromProxySSE: true,
            user_message: '图片下载超时(主机:oss.example.com,共 1 张图,1 张失败)。',
            error_type: 'image_fetch_failed',
          },
        },
      );
      const c = classifyError(err);
      expect(c.category).toBe('network');
      expect(c.suggestedAction).toBe('retry_later');
    });

    it('未知 error_type 兜底走 internal + contact_support', () => {
      const err = new AgentError(
        '请求处理失败,请稍后重试。',
        'LLM_ERROR',
        {
          // 显式给 statusCode 让 ctor 走 typed-opts 路径(否则 opts 整体被当 details)
          statusCode: 500,
          retryable: false,
          details: {
            fromProxySSE: true,
            user_message: '请求处理失败,请稍后重试。',
            error_type: 'never_seen_type',
          },
        },
      );
      const c = classifyError(err);
      expect(c.userMessage).toContain('请求处理失败');
      expect(c.category).toBe('internal');
      expect(c.suggestedAction).toBe('contact_support');
    });

    it('技术细节(technical_detail)从 details 透传(不会出现在 userMessage 里)', () => {
      const err = new AgentError(
        '图片下载失败(主机:x,HTTP 404)。',
        'LLM_ERROR',
        {
          statusCode: 404,
          retryable: false,
          details: {
            fromProxySSE: true,
            user_message: '图片下载失败(主机:x,HTTP 404)。',
            error_type: 'image_fetch_http_error',
            technical_detail: 'stage=image_fetch reason=http_error host=x status=404',
          },
        },
      );
      const c = classifyError(err);
      // userMessage 是中文,technical_detail 不混入
      expect(c.userMessage).not.toContain('stage=');
      expect(c.userMessage).not.toContain('reason=');
      // technical_detail 仍可在 originalError.details 上拿到给"查看技术详情"折叠
      const orig = c.originalError as AgentError;
      const tech = orig.details?.technical_detail as string | undefined;
      expect(tech).toBeDefined();
      expect(tech!).toContain('stage=image_fetch');
    });
  });
});

describe('isReportableRunError ()', () => {
  // 全集守卫：每个 ErrorCategory 都必须明确"报 / 不报"。
  // Record<ErrorCategory, boolean> 缺 key 会让 tsc 编译失败——将来 error-classifier
  // 新增分类时，强制后人在这里拍板它进不进错误监控，杜绝"悄悄默认上报/不报"。
  // false = 可预期业务态，不上报；true = 意外/需工程排查，上报。
  const REPORT_EXPECTATION: Record<ErrorCategory, boolean> = {
    // ── 不上报（前端已有 UI 引导）──
    abort: false,
    billing: false,
    organization_insufficient_credits: false,
    budget_exceeded: false,
    rate_limit: false,
    context_overflow: false,
    auth: false,
    permission: false,
    byok_provider_unavailable: false,
    byok_rate_limit_exceeded: false,
    byok_quota_exhausted: false,
    byok_invalid_key: false,
    network: false,
    // ── 上报（意外 / 需工程排查）──
    internal: true,
    server_error: true,
    tool_error: true,
    doom_loop: true,
  };

  it.each(Object.entries(REPORT_EXPECTATION))(
    'category=%s 上报判定符合口径',
    (category, expected) => {
      expect(isReportableRunError(category as ErrorCategory)).toBe(expected);
    },
  );

  // end-to-end：组织钱包余额不足（本 issue 的触发场景，fromProxySSE）分类后不上报
  it('组织钱包余额不足（fromProxySSE）分类后不上报', () => {
    const err = new AgentError(
      '[organization_insufficient_credits] 组织钱包余额不足，请联系组织管理员充值',
      'LLM_BILLING_ERROR',
      {
        statusCode: 402,
        details: {
          fromProxySSE: true,
          user_message: '组织钱包余额不足，请联系组织管理员充值',
          error_type: 'organization_insufficient_credits',
        },
      },
    );
    const c = classifyError(err);
    expect(c.category).toBe('organization_insufficient_credits');
    expect(isReportableRunError(c.category)).toBe(false);
  });

  // end-to-end：用户主动中止不上报
  it('用户主动中止（ABORT）分类后不上报', () => {
    const err = new AgentError('用户已停止', 'ABORT', {});
    const c = classifyError(err);
    expect(c.category).toBe('abort');
    expect(isReportableRunError(c.category)).toBe(false);
  });

  // end-to-end：真正的意外错误仍上报
  it('未分类内部错误分类后上报', () => {
    const c = classifyError(new Error('unexpected boom'));
    expect(isReportableRunError(c.category)).toBe(true);
  });
});
