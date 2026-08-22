import { executableStep, metadataBaseline, scenario } from "../runner/scenario";

const selfcheck = scenario({
  id: "evidence.baseline-selfcheck",
  title: "测试框架能产出证据包并进行 baseline 对比",
  intent: "验证 Electron E2E runner 自身能写入 result、timeline、snapshot，并生成可对比的结构化 baseline。",
  priority: "P0",
  profiles: ["smoke", "regression", "p0-plus"],
  tags: ["electron", "evidence", "baseline", "selfcheck"],
  sourceCapability: "Electron E2E / 证据包与 baseline",
  testLayer: "infrastructure",
  dataContract: {
    selfContained: true,
    setup: ["使用本次 runId 创建本地 artifacts 目录，不依赖 Electron 或后端数据。"],
  },
  automationStatus: "ready",
  fixtures: ["run-marker", "artifact-dir", "baseline-dir"],
  steps: [
    executableStep("evidence.write-snapshot", "写入结构化快照", async (context) => {
      const artifact = await context.writeJson("snapshots/selfcheck.json", {
        runId: context.runId,
        scenarioId: context.scenarioId,
        marker: `tabtin-e2e-${context.runId}`,
        contract: {
          resultJson: true,
          timelineJsonl: true,
          baselineDiff: true,
        },
      });

      return {
        status: "passed",
        message: "selfcheck snapshot written",
        artifacts: [artifact],
      };
    }),
    executableStep("evidence.write-log", "写入可读日志片段", async (context) => {
      const artifact = await context.writeText(
        "logs/selfcheck.log",
        [
          `runId=${context.runId}`,
          `scenarioId=${context.scenarioId}`,
          "This log proves the evidence writer can keep human-readable files.",
        ].join("\n")
      );

      return {
        status: "passed",
        message: "selfcheck log written",
        artifacts: [artifact],
      };
    }),
  ],
  prepare: (context) => ({
    runId: context.runId,
    prepared: true,
    note: "Selfcheck uses only local artifact directories.",
  }),
  collectBaseline: (context) =>
    metadataBaseline(selfcheck, context, {
      stepCount: selfcheck.steps.length,
      fixtureCount: selfcheck.fixtures.length,
      outputContract: ["result.json", "timeline.jsonl", "snapshots/selfcheck.json"],
    }),
});

export default selfcheck;
