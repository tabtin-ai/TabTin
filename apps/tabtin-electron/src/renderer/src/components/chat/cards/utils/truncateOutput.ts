// 卡片内联展示预算。此前为 50K——在 250px 高的滚动区里塞 5 万字符只会造成
// 滚动疲劳；降到 10K（约 150 行）后长输出靠「复制完整输出」/「查看终端」出口，
// 复制路径仍是全量文本（TerminalCard.fullText），不丢信息。
export const MAX_DISPLAY_CHARS = 10_000
const STDERR_RESERVE = 5_000

/**
 * Truncate combined stdout/stderr to fit within MAX_DISPLAY_CHARS.
 *
 * When stdout is much shorter than the budget, remaining space is
 * allocated to stderr so early error messages are preserved.
 */
const TRUNCATION_MARKER = '\n\n... [truncated] ...\n\n'
const TRUNCATION_MARKER_LEN = TRUNCATION_MARKER.length

export function truncateTerminalOutput(
  stdout: string,
  stderr: string,
): { displayStdout: string; displayStderr: string; isTruncated: boolean } {
  const total = stdout.length + stderr.length
  if (total <= MAX_DISPLAY_CHARS) {
    return { displayStdout: stdout, displayStderr: stderr, isTruncated: false }
  }
  const stderrBudget = Math.min(stderr.length, Math.max(STDERR_RESERVE, MAX_DISPLAY_CHARS - stdout.length))
  const stdoutBudget = MAX_DISPLAY_CHARS - stderrBudget

  let displayStdout: string
  if (stdout.length > stdoutBudget) {
    const headBudget = Math.floor(stdoutBudget * 0.6)
    const tailBudget = stdoutBudget - headBudget - TRUNCATION_MARKER_LEN
    displayStdout = tailBudget > 0
      ? stdout.slice(0, headBudget) + TRUNCATION_MARKER + stdout.slice(-tailBudget)
      : stdout.slice(0, stdoutBudget)
  } else {
    displayStdout = stdout.slice(0, stdoutBudget)
  }

  return {
    displayStdout,
    displayStderr: stderr.slice(-stderrBudget),
    isTruncated: true,
  }
}
