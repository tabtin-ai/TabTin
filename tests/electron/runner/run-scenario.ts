import { compareOrUpdateBaseline } from "./baseline";
import { EvidenceWriter } from "./evidence-writer";
import { toRepoRelative } from "./paths";
import type {
  BaselineSnapshot,
  RunContext,
  ScenarioDefinition,
  ScenarioResult,
  StepResult,
} from "./types";

export type RunScenarioOptions = {
  repoRoot: string;
  runId: string;
  scenario: ScenarioDefinition;
  includePlanned: boolean;
  updateBaseline: boolean;
};

export async function runScenario(options: RunScenarioOptions): Promise<ScenarioResult> {
  const { repoRoot, runId, scenario, includePlanned, updateBaseline } = options;
  const writer = new EvidenceWriter(repoRoot, runId, scenario.id);
  await writer.init();
  const context = writer.createContext(updateBaseline);

  const startedAt = new Date().toISOString();
  await context.reportProgress("START", scenario.title);
  await context.writeTimeline({
    event: "scenario.start",
    payload: { title: scenario.title, automationStatus: scenario.automationStatus },
  });

  if (scenario.automationStatus === "planned" && !includePlanned) {
    const result = buildSkippedResult(repoRoot, scenario, runId, startedAt, writer.scenarioArtifactDir);
    await context.reportProgress("SKIP", result.skippedReason ?? "planned scenario");
    await context.writeTimeline({
      event: "scenario.skip",
      status: "skipped",
      payload: { reason: result.skippedReason },
    });
    await writeScenarioOutputs(context, result);
    return result;
  }

  const steps: StepResult[] = [];
  if (scenario.prepare) {
    await context.reportProgress("PREPARE", "start");
    const prepared = await runPrepare(scenario, context);
    await context.reportProgress(prepared.status.toUpperCase(), `prepare: ${prepared.message ?? prepared.title}`);
    if (prepared.status === "failed") {
      steps.push(prepared);
      const result = buildFailedResult(repoRoot, scenario, runId, startedAt, writer.scenarioArtifactDir, steps);
      await context.reportProgress("END", `${result.status} -> ${toRepoRelative(repoRoot, writer.scenarioArtifactDir)}`);
      await context.writeTimeline({ event: "scenario.end", status: result.status });
      await writeScenarioOutputs(context, result);
      return result;
    }
    steps.push(prepared);
  }

  for (const step of scenario.steps) {
    await context.reportProgress("STEP", `${step.id}: start`);
    await context.writeTimeline({ event: "step.start", stepId: step.id });
    const result = await executeStep(step, context);
    steps.push(result);
    await context.reportProgress(result.status.toUpperCase(), `${step.id}: ${result.message ?? result.title}`);
    await context.writeTimeline({
      event: "step.end",
      stepId: step.id,
      status: result.status,
      payload: { message: result.message, artifacts: result.artifacts },
    });
    if (result.status === "failed") break;
  }

  const stepStatus = deriveScenarioStatus(steps);
  await context.reportProgress("BASELINE", "collect");
  const snapshot = await collectBaselineSnapshot(scenario, context);
  await context.reportProgress("BASELINE", updateBaseline ? "compare/update" : "compare");
  const baselineDiff = await compareOrUpdateBaseline(repoRoot, snapshot, updateBaseline);
  const rawStatus =
    stepStatus === "passed" && (baselineDiff.status === "changed" || baselineDiff.status === "missing")
      ? "failed"
      : stepStatus;
  const status = isExpectedFailure(scenario, steps, rawStatus) ? "expected-failed" : rawStatus;
  const result: ScenarioResult = {
    schemaVersion: 1,
    runId,
    scenarioId: scenario.id,
    title: scenario.title,
    priority: scenario.priority,
    profiles: scenario.profiles,
    tags: scenario.tags,
    automationStatus: scenario.automationStatus,
    testLayer: scenario.testLayer,
    dataContract: scenario.dataContract,
    interactionContract: scenario.interactionContract,
    sourceCapability: scenario.sourceCapability,
    expectedFailure: scenario.expectedFailure,
    caseFile: scenario.caseFile,
    userFlow: scenario.userFlow,
    automationContract: scenario.automationContract,
    startedAt,
    endedAt: new Date().toISOString(),
    status,
    steps,
    baselineDiff,
    artifactDir: toRepoRelative(repoRoot, writer.scenarioArtifactDir),
  };

  await context.writeTimeline({
    event: "scenario.end",
    status,
    payload: status === "expected-failed" ? { expectedFailure: scenario.expectedFailure } : undefined,
  });
  await context.reportProgress("WRITE", `artifacts -> ${result.artifactDir}`);
  await writeScenarioOutputs(context, result);
  await context.reportProgress("END", status);
  return result;
}

async function runPrepare(
  scenario: ScenarioDefinition,
  context: RunContext,
): Promise<StepResult> {
  const now = new Date().toISOString();
  try {
    await context.writeTimeline({ event: "scenario.prepare.start" });
    const data = await scenario.prepare?.(context);
    if (data && typeof data === "object") {
      Object.assign(context.preparedData, data);
      await context.writeJson("snapshots/preparation.json", data);
    }
    await context.writeTimeline({ event: "scenario.prepare.end", status: "passed" });
    return {
      id: "prepare",
      title: "Prepare scenario data",
      status: "passed",
      startedAt: now,
      endedAt: new Date().toISOString(),
      message: "Scenario data prepared.",
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    await context.writeTimeline({
      event: "scenario.prepare.end",
      status: "failed",
      payload: { message: err.message },
    });
    return {
      id: "prepare",
      title: "Prepare scenario data",
      status: "failed",
      startedAt: now,
      endedAt: new Date().toISOString(),
      message: err.message,
      error: {
        message: err.message,
        stack: err.stack,
      },
    };
  }
}

async function executeStep(
  step: ScenarioDefinition["steps"][number],
  context: ReturnType<EvidenceWriter["createContext"]>
): Promise<StepResult> {
  try {
    return await step.run(context);
  } catch (error) {
    const now = new Date().toISOString();
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      id: step.id,
      title: step.title,
      status: "failed",
      startedAt: now,
      endedAt: now,
      message: err.message,
      error: {
        message: err.message,
        stack: err.stack,
      },
    };
  }
}

async function collectBaselineSnapshot(
  scenario: ScenarioDefinition,
  context: ReturnType<EvidenceWriter["createContext"]>
): Promise<BaselineSnapshot | null> {
  if (!scenario.collectBaseline) return null;
  return scenario.collectBaseline(context);
}

function buildSkippedResult(
  repoRoot: string,
  scenario: ScenarioDefinition,
  runId: string,
  startedAt: string,
  scenarioArtifactDir: string
): ScenarioResult {
  return {
    schemaVersion: 1,
    runId,
    scenarioId: scenario.id,
    title: scenario.title,
    priority: scenario.priority,
    profiles: scenario.profiles,
    tags: scenario.tags,
    automationStatus: scenario.automationStatus,
    testLayer: scenario.testLayer,
    dataContract: scenario.dataContract,
    interactionContract: scenario.interactionContract,
    sourceCapability: scenario.sourceCapability,
    expectedFailure: scenario.expectedFailure,
    caseFile: scenario.caseFile,
    userFlow: scenario.userFlow,
    automationContract: scenario.automationContract,
    startedAt,
    endedAt: new Date().toISOString(),
    status: "skipped",
    skippedReason: "Scenario automation is planned; pass --include-planned to execute planned steps.",
    steps: [],
    baselineDiff: { status: "not-collected" },
    artifactDir: toRepoRelative(repoRoot, scenarioArtifactDir),
  };
}

function buildFailedResult(
  repoRoot: string,
  scenario: ScenarioDefinition,
  runId: string,
  startedAt: string,
  scenarioArtifactDir: string,
  steps: StepResult[],
): ScenarioResult {
  return {
    schemaVersion: 1,
    runId,
    scenarioId: scenario.id,
    title: scenario.title,
    priority: scenario.priority,
    profiles: scenario.profiles,
    tags: scenario.tags,
    automationStatus: scenario.automationStatus,
    testLayer: scenario.testLayer,
    dataContract: scenario.dataContract,
    interactionContract: scenario.interactionContract,
    sourceCapability: scenario.sourceCapability,
    expectedFailure: scenario.expectedFailure,
    caseFile: scenario.caseFile,
    userFlow: scenario.userFlow,
    automationContract: scenario.automationContract,
    startedAt,
    endedAt: new Date().toISOString(),
    status: "failed",
    steps,
    baselineDiff: { status: "not-collected" },
    artifactDir: toRepoRelative(repoRoot, scenarioArtifactDir),
  };
}

function deriveScenarioStatus(steps: StepResult[]): ScenarioResult["status"] {
  if (steps.some((step) => step.status === "failed")) return "failed";
  if (steps.length === 0 || steps.every((step) => step.status === "skipped")) return "skipped";
  return "passed";
}

function isExpectedFailure(
  scenario: ScenarioDefinition,
  steps: StepResult[],
  status: ScenarioResult["status"],
): boolean {
  if (status !== "failed" || !scenario.expectedFailure) return false;
  const failedStep = steps.find((step) => step.status === "failed");
  if (!failedStep) return false;
  if (scenario.expectedFailure.stepId && failedStep.id !== scenario.expectedFailure.stepId) return false;
  if (scenario.expectedFailure.messagePattern) {
    const pattern = new RegExp(scenario.expectedFailure.messagePattern);
    const message = failedStep.message ?? failedStep.error?.message ?? "";
    if (!pattern.test(message)) return false;
  }
  return true;
}

async function writeScenarioOutputs(
  context: ReturnType<EvidenceWriter["createContext"]>,
  result: ScenarioResult
): Promise<void> {
  await context.writeJson("result.json", result);
  await context.writeJson("diff-against-baseline.json", result.baselineDiff);
  await context.writeText("summary.md", renderSummary(result));
  if (result.status === "failed") {
    await context.writeText("issueDraft.md", renderIssueDraft(result));
  }
}

function renderSummary(result: ScenarioResult): string {
  const stepLines =
    result.steps.length === 0
      ? ["- No executable steps ran."]
      : result.steps.map((step) => `- ${step.status.toUpperCase()} ${step.id}: ${step.message ?? step.title}`);
  const userFlowLines = result.userFlow?.length
    ? result.userFlow.map((item, index) => `${index + 1}. ${item}`)
    : [];
  const automationContractLines = result.automationContract?.length
    ? result.automationContract.map((item) => `- ${item}`)
    : [];

  return [
    `# ${result.status.toUpperCase()} ${result.scenarioId}`,
    "",
    `runId: ${result.runId}`,
    `title: ${result.title}`,
    `layer: ${result.testLayer}`,
    `artifactDir: ${result.artifactDir}`,
    result.expectedFailure ? `expectedFailure: ${result.expectedFailure.reason}` : undefined,
    result.expectedFailure?.issue ? `expectedFailureIssue: ${result.expectedFailure.issue}` : undefined,
    result.skippedReason ? `skippedReason: ${result.skippedReason}` : undefined,
    `baseline: ${result.baselineDiff.status}`,
    result.caseFile ? `caseFile: ${result.caseFile}` : undefined,
    userFlowLines.length > 0 ? "" : undefined,
    userFlowLines.length > 0 ? "## User Flow" : undefined,
    userFlowLines.length > 0 ? "" : undefined,
    ...userFlowLines,
    automationContractLines.length > 0 ? "" : undefined,
    automationContractLines.length > 0 ? "## Automation Contract" : undefined,
    automationContractLines.length > 0 ? "" : undefined,
    ...automationContractLines,
    "",
    "## Steps",
    "",
    ...stepLines,
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderIssueDraft(result: ScenarioResult): string {
  const failedStep = result.steps.find((step) => step.status === "failed");
  return [
    `# ${result.scenarioId} failed`,
    "",
    `- runId: ${result.runId}`,
    `- scenario: ${result.title}`,
    `- artifactDir: ${result.artifactDir}`,
    failedStep ? `- failedStep: ${failedStep.id}` : "- failedStep: unknown",
    failedStep?.message ? `- observed: ${failedStep.message}` : undefined,
    "",
    "确认这是产品缺陷或测试基础设施缺口后，再按仓库 issue 规则查重并登记。",
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
