export interface ExecutionBoundaryInput {
  yoloMode: boolean;
  workspacePaths?: string[];
  memoEntries?: Array<{ key: string; description: string; allowed: boolean }>;
}

export function buildExecutionBoundaryPrompt(input: ExecutionBoundaryInput): string {
  const lines: string[] = ['<execution_boundary>'];

  if (input.workspacePaths && input.workspacePaths.length > 0) {
    lines.push('当前工作区：');
    for (const p of input.workspacePaths) {
      lines.push(`- ${p}`);
    }
    lines.push('');
    lines.push('工作区内：文件读写和常规命令默认允许；部分敏感路径仍受保护。');
    lines.push('工作区外：需要用户确认。');
  }

  lines.push('');
  lines.push(
    input.yoloMode
      ? '当前模式：超级权限模式——Agent 自主执行。'
      : '当前模式：默认——Agent 在需要时请求确认。',
  );

  if (input.memoEntries && input.memoEntries.length > 0) {
    lines.push('');
    lines.push('已记住的用户偏好：');
    for (const entry of input.memoEntries.slice(0, 20)) {
      const prefix = entry.allowed ? '✓' : '✗';
      lines.push(`- ${prefix} ${entry.description}`);
    }
  }

  if (input.yoloMode) {
    lines.push('');
    lines.push('重要：即使在超级权限模式下，执行不可逆操作（删除文件、覆盖文件、git push 等）前也要三思。');
  }

  lines.push('</execution_boundary>');
  return lines.join('\n');
}
