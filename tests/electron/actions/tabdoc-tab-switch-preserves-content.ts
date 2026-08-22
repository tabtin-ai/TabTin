import type { RunContext, StepResult } from "../runner/types";
import type { TabdocTabSwitchPreparation } from "../fixtures/prepare-tabdoc-tab-switch-preserves-content";

/**
 * UI 10 次切换 action 骨架。
 * 升 ready 前需补齐：真实点击打开 A/B → 切换 ≥10 次 → CDP 读首段 + Django 持久化断言 + scope=1。
 */
export async function runTabdocTabSwitchPreservesContent(
  context: RunContext,
): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const prepared = context.preparedData as unknown as TabdocTabSwitchPreparation;
  await context.writeJson("snapshots/tabdoc-tab-switch-preserves-content-prepared.json", prepared);

  throw new Error(
    "tabdoc.tab-switch-preserves-content UI action is planned: "
      + "implement CDP click-switch ≥10 times + lead-paragraph + single-scope assertions "
      + `(docA=${prepared?.docAId}, docB=${prepared?.docBId}). `
      + "Unit harness already covers Activity Y.Doc rebuild, hydrate gate, dirty claim, foreground dedupe.",
  );
}
