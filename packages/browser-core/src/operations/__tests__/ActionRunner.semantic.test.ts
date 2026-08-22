import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSharedCDPOperationHelper } from '../CDPOperationHelper';
import { DOMOperationHelper } from '../DOMOperationHelper';
import { runSingleAction } from '../ActionRunner';
import type { BrowserContext } from '../../context/BrowserContext';

function mockCtx(executeScript: BrowserContext['executeScript']): BrowserContext {
  return {
    isAlive: () => true,
    executeScript,
    captureScreenshot: vi.fn(),
    getCurrentURL: () => 'https://example.com',
    getTitle: async () => 'Example',
  } as unknown as BrowserContext;
}

describe('ActionRunner — BW-1 语义重定位', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('快路径 selector 命中时不触发重定位', async () => {
    const runSpy = vi
      .spyOn(getSharedCDPOperationHelper(), 'runAction')
      .mockResolvedValue({ success: true });
    const executeScript = vi.fn();

    const entry = await runSingleAction(
      mockCtx(executeScript),
      {
        type: 'click',
        selector: '#ok',
        refSemantic: { role: 'button', name: 'OK', nth: 0 },
      },
      1000,
    );

    expect(entry.status).toBe('success');
    expect(entry.selector_source).toBe('initial');
    expect(entry.relocated_from).toBeUndefined();
    expect(entry.resolved_text).toBe('OK');
    expect(entry.resolved_role).toBe('button');
    expect(executeScript).not.toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('回执带 resolved_text/role，便于发现跨 glance 误用 eN', async () => {
    vi.spyOn(getSharedCDPOperationHelper(), 'runAction').mockResolvedValue({ success: true });

    const entry = await runSingleAction(
      mockCtx(vi.fn()),
      {
        type: 'click',
        ref: 'e78',
        selector: 'xpath=/html/body//a[11]',
        refSemantic: {
          role: 'link',
          name: '(https://martinfowler.com/articles/build-own-coding-agent.html)',
          nth: 0,
        },
      },
      1000,
    );

    expect(entry.status).toBe('success');
    expect(entry.resolved_text).toContain('martinfowler.com');
    expect(entry.resolved_role).toBe('link');
  });

  it('xpath 失效后按 refSemantic 重定位并重试成功', async () => {
    const runSpy = vi
      .spyOn(getSharedCDPOperationHelper(), 'runAction')
      .mockResolvedValueOnce({
        success: false,
        code: 'cdp_error',
        error: 'Element not found or not visible: xpath=/html/body/a[99]',
      })
      .mockResolvedValueOnce({ success: true });

    const executeScript = vi.fn().mockResolvedValue({
      success: true,
      selector: 'a[aria-label="Home"]',
    });

    const entry = await runSingleAction(
      mockCtx(executeScript),
      {
        type: 'click',
        ref: 'e1',
        selector: 'xpath=/html/body/a[99]',
        refSemantic: { role: 'link', name: 'Home', nth: 0 },
      },
      1000,
    );

    expect(entry.status).toBe('success');
    expect(entry.selector).toBe('a[aria-label="Home"]');
    expect(entry.selector_source).toBe('semantic_relocate');
    expect(entry.relocated_from).toBe('xpath=/html/body/a[99]');
    expect(entry.resolved_text).toBe('Home');
    expect(entry.resolved_role).toBe('link');
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(runSpy.mock.calls[1]?.[1]?.selector).toBe('a[aria-label="Home"]');
  });

  it('重定位失败时返回明确 ref_semantic_relocate_failed 错误', async () => {
    vi.spyOn(getSharedCDPOperationHelper(), 'runAction').mockResolvedValue({
      success: false,
      code: 'element_not_found',
      error: '未找到 XPath 元素',
    });

    const executeScript = vi.fn().mockResolvedValue({
      success: false,
      code: 'ref_semantic_relocate_failed',
      error: 'no matching interactive element for semantic fingerprint',
    });

    const entry = await runSingleAction(
      mockCtx(executeScript),
      {
        type: 'click',
        ref: 'e9',
        selector: 'xpath=/stale',
        refSemantic: { role: 'link', name: 'Gone', nth: 0 },
      },
      1000,
    );

    expect(entry.status).toBe('failed');
    expect(entry.error_code).toBe('ref_semantic_relocate_failed');
    expect(entry.error).toContain('语义重定位失败');
    expect(entry.error).toContain('ref e9');
    expect(entry.error).toContain('role=link');
  });

  it('drag 的 toRefSemantic 失效后重定位 toSelector 并重试成功', async () => {
    const runSpy = vi
      .spyOn(getSharedCDPOperationHelper(), 'runAction')
      .mockResolvedValueOnce({
        success: false,
        code: 'cdp_error',
        error: 'Element not found or not visible: xpath=/html/body/div[99]',
      })
      .mockResolvedValueOnce({ success: true });

    const executeScript = vi.fn().mockResolvedValue({
      success: true,
      selector: '#drop-target',
    });

    const entry = await runSingleAction(
      mockCtx(executeScript),
      {
        type: 'drag',
        selector: '#source',
        toRef: 'e2',
        toSelector: 'xpath=/html/body/div[99]',
        toRefSemantic: { role: 'button', name: 'Drop here', nth: 0 },
      },
      1000,
    );

    expect(entry.status).toBe('success');
    expect(entry.selector).toBe('#source');
    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(runSpy.mock.calls[1]?.[1]?.selector).toBe('#source');
    expect(runSpy.mock.calls[1]?.[1]?.toSelector).toBe('#drop-target');
  });

  it('drag 的 toRefSemantic 重定位失败时错误归因到 toRef', async () => {
    vi.spyOn(getSharedCDPOperationHelper(), 'runAction').mockResolvedValue({
      success: false,
      code: 'cdp_error',
      error: 'Element not found or not visible: xpath=/html/body/div[99]',
    });

    const executeScript = vi.fn().mockResolvedValue({
      success: false,
      code: 'ref_semantic_relocate_failed',
      error: 'no matching interactive element for semantic fingerprint',
    });

    const entry = await runSingleAction(
      mockCtx(executeScript),
      {
        type: 'drag',
        selector: '#source',
        toRef: 'e2',
        toSelector: 'xpath=/html/body/div[99]',
        toRefSemantic: { role: 'button', name: 'Drop here', nth: 0 },
      },
      1000,
    );

    expect(entry.status).toBe('failed');
    expect(entry.error_code).toBe('ref_semantic_relocate_failed');
    expect(entry.error).toContain('ref e2');
    expect(entry.error).toContain('role=button');
    expect(entry.error).toContain('Drop here');
  });

  it('小写 keypress 归一为 keyPress 并走 CDP 键盘路径（不落 DOM 空等）', async () => {
    const runSpy = vi
      .spyOn(getSharedCDPOperationHelper(), 'runAction')
      .mockResolvedValue({ success: true });
    const executeScript = vi.fn();

    const entry = await runSingleAction(
      mockCtx(executeScript),
      {
        // 模型常输出小写 keypress，需归一到规范 keyPress
        type: 'keypress' as never,
        selector: '',
        value: 'Enter',
      },
      1000,
    );

    expect(entry.status).toBe('success');
    expect(entry.type).toBe('keyPress');
    expect(executeScript).not.toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0]?.[1]?.action).toBe('keyPress');
  });

  it('非法 selector 不触发语义重定位', async () => {
    const runSpy = vi.spyOn(getSharedCDPOperationHelper(), 'runAction').mockResolvedValue({
      success: false,
      code: 'selector_evaluation_failed',
      error: 'Failed to execute querySelector: invalid selector',
    });
    const executeScript = vi.fn();

    const entry = await runSingleAction(
      mockCtx(executeScript),
      {
        type: 'click',
        ref: 'e1',
        selector: 'a[',
        refSemantic: { role: 'link', name: 'Home', nth: 0 },
      },
      1000,
    );

    expect(entry.status).toBe('failed');
    expect(executeScript).not.toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('将 DOM 表单状态转发为 API 蛇形回执，同时保留语义重定位字段', async () => {
    vi.spyOn(DOMOperationHelper, 'runAction').mockResolvedValue({
      success: true,
      actualValue: '张三',
      controlValue: 'large',
      checked: true,
    });

    const entry = await runSingleAction(
      mockCtx(vi.fn()),
      {
        type: 'fill',
        selector: '#name',
        value: '张三',
        refSemantic: { role: 'textbox', name: '姓名', nth: 0 },
      },
      1000,
    );

    expect(entry).toMatchObject({
      status: 'success',
      actual_value: '张三',
      control_value: 'large',
      checked: true,
      selector_source: 'initial',
      resolved_text: '姓名',
      resolved_role: 'textbox',
    });
  });

  it('将失败 DOM 表单状态同样转发为 API 蛇形回执', async () => {
    vi.spyOn(DOMOperationHelper, 'runAction').mockResolvedValue({
      success: false,
      code: 'invalid_parameter',
      error: '填写后值与请求值不一致',
      actualValue: 'old',
    });

    const entry = await runSingleAction(
      mockCtx(vi.fn()),
      { type: 'fill', selector: '#name', value: '张三' },
      1000,
    );

    expect(entry).toMatchObject({
      status: 'failed',
      error_code: 'invalid_parameter',
      actual_value: 'old',
    });
  });
});
