export async function runTimedStage(
  label,
  operation,
  { now = performance.now, output = console.log } = {},
) {
  const startedAt = now();
  try {
    const result = await operation();
    output(
      `[community-dev] ${label}完成（${((now() - startedAt) / 1_000).toFixed(1)}s）`,
    );
    return result;
  } catch (error) {
    output(
      `[community-dev] ${label}失败（${((now() - startedAt) / 1_000).toFixed(1)}s）`,
    );
    throw error;
  }
}
