export interface MarkdownRenderOptions {
  /**
   * 设为 `false` 可禁用 HTML 消毒。
   *
   * @security **危险选项** — 设为 `false` 后将完全绕过 `sanitizeHtml()`，
   * 如果 Markdown 内容来自用户输入或不可信来源，将形成完整的 XSS 漏洞链路。
   * 仅在内容完全可信（如系统内部生成的模板）时使用。
   * 启用此选项会触发 console.warn 警告。
   */
  sanitize?: boolean
  /**
   * 跳过 HTML 消毒，直接返回原始渲染结果。
   *
   * @security **危险选项** — 启用后将完全绕过 `sanitizeHtml()`，
   * 如果 Markdown 内容来自用户输入或不可信来源，将形成完整的 XSS 漏洞链路。
   * 仅在内容完全可信（如系统内部生成的模板）时使用。
   *
   * 启用此选项会在所有环境（含生产环境）触发 console.warn 警告。
   */
  allowUnsafeHtml?: boolean
}

export interface MarkdownRenderResult {
  html: string
}

export interface MarkdownRendererAdapter {
  renderToHtml: (markdown: string, options?: MarkdownRenderOptions) => string | Promise<string>
}

