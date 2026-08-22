#!/usr/bin/env node
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { compareOrUpdateBaseline } from "./baseline";
import { EvidenceWriter } from "./evidence-writer";
import { createRunId, resolveRepoRoot, sanitizePathSegment, toRepoRelative } from "./paths";
import { assertScenarioContracts, assertUniqueScenarioIds, findScenario, selectScenarios } from "./scenario-registry";
import { runScenario } from "./run-scenario";
import type { BaselineSnapshot, ScenarioDefinition, ScenarioProfile, ScenarioResult } from "./types";

type CliArgs = {
  command: string;
  flags: Map<string, string | boolean>;
};

type DoctorCheck = {
  name: string;
  status: "ok" | "warn" | "fail";
  message: string;
};

const VALID_PROFILES = new Set<ScenarioProfile>([
  "smoke",
  "regression",
  "data-seeding",
  "external-ai",
  "visual",
  "p0-plus",
]);

async function main(): Promise<void> {
  assertUniqueScenarioIds();
  assertScenarioContracts();
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolveRepoRoot();
  validateFlags(args);

  switch (args.command) {
    case "doctor":
      await commandDoctor(repoRoot, args);
      break;
    case "list":
      commandList(args);
      break;
    case "ask":
      await commandAsk(repoRoot, args);
      break;
    case "prepare":
      await commandPrepare(repoRoot, args);
      break;
    case "run":
      await commandRun(repoRoot, args);
      break;
    case "baseline":
      await commandBaseline(repoRoot, args);
      break;
    case "cleanup":
      await commandCleanup(repoRoot, args);
      break;
    case "help":
    case "":
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

function parseArgs(argv: string[]): CliArgs {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      flags.set(key, true);
    } else {
      flags.set(key, next);
      i += 1;
    }
  }
  return { command, flags };
}

async function commandDoctor(repoRoot: string, args: CliArgs): Promise<void> {
  const checks = [
    await checkHttp("django", envUrl("TABTIN_API_BASE_URL", "http://127.0.0.1:6060/health")),
    await checkHttp("collab-live", envUrl("TABTIN_COLLAB_HEALTH_URL", "http://127.0.0.1:4100/health")),
    await checkTcp("centrifugo", envHost("TABTIN_CENTRIFUGO_HOST", "127.0.0.1"), envPort("CENTRIFUGO_PORT", 8100)),
    await checkElectronCdp(repoRoot, Boolean(args.flags.get("require-electron"))),
    await checkPath(repoRoot, "apps/tabtin-electron/package.json"),
    await checkArtifactWritable(repoRoot),
  ];

  if (args.flags.get("json")) {
    console.log(JSON.stringify({ ok: checks.every((check) => check.status !== "fail"), checks }, null, 2));
  } else {
    for (const check of checks) {
      console.log(`${check.status.toUpperCase()} ${check.name}: ${check.message}`);
    }
  }

  if (checks.some((check) => check.status === "fail")) {
    process.exitCode = 1;
  }
}

function commandList(args: CliArgs): void {
  const selected = selectFromArgs(args);
  if (args.flags.get("json")) {
    console.log(JSON.stringify(selected.map(toScenarioListItem), null, 2));
    return;
  }

  for (const scenario of selected) {
    console.log(
      [
        scenario.id,
        scenario.priority,
        scenario.automationStatus,
        scenario.expectedFailure ? `expectedFailure=${scenario.expectedFailure.reason}` : undefined,
        `layer=${scenario.testLayer}`,
        `profiles=${scenario.profiles.join(",")}`,
        `tags=${scenario.tags.join(",")}`,
        scenario.testLayer === "ui"
          ? `userActions=${scenario.interactionContract?.requiredUserActions.length ?? 0}`
          : undefined,
        `source=${scenario.sourceCapability}`,
        `title=${scenario.title}`,
      ]
        .filter((item): item is string => Boolean(item))
        .join(" | ")
    );
  }
}

async function commandPrepare(repoRoot: string, args: CliArgs): Promise<void> {
  const scenario = requireScenario(args);
  const runId = readStringFlag(args, "run-id") ?? createRunId();
  const writer = new EvidenceWriter(repoRoot, runId, scenario.id);
  await writer.init();
  const context = writer.createContext(false);
  const prepared = scenario.prepare ? await scenario.prepare(context) : defaultPreparationSummary(scenario, runId);
  await context.writeJson("preparation.json", prepared);
  await context.writeTimeline({ event: "scenario.prepare", payload: prepared });
  console.log(`PREPARED ${scenario.id} runId=${runId}`);
  console.log(toRepoRelative(repoRoot, path.join(writer.scenarioArtifactDir, "preparation.json")));
}

async function commandRun(repoRoot: string, args: CliArgs): Promise<void> {
  if (args.flags.get("start-stack")) {
    throw new Error("--start-stack is reserved but not implemented yet; start scripts/dev/menu.sh explicitly for now.");
  }

  const selected = selectFromArgs(args);
  if (selected.length === 0) {
    throw new Error("No scenarios matched the requested filters.");
  }

  const runId = readStringFlag(args, "run-id") ?? createRunId();
  const includePlanned = Boolean(args.flags.get("include-planned"));
  const updateBaseline = Boolean(args.flags.get("update-baseline"));
  const allowSkips = Boolean(args.flags.get("allow-skips"));
  const results: ScenarioResult[] = [];

  for (const scenario of selected) {
    const result = await runScenario({ repoRoot, runId, scenario, includePlanned, updateBaseline });
    results.push(result);
    console.log(`${result.status.toUpperCase()} ${result.scenarioId} -> ${result.artifactDir}`);
  }

  const failed = results.filter((result) => result.status === "failed").length;
  const expectedFailed = results.filter((result) => result.status === "expected-failed").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const passed = results.filter((result) => result.status === "passed").length;
  console.log(`SUMMARY runId=${runId} passed=${passed} expectedFailed=${expectedFailed} skipped=${skipped} failed=${failed}`);

  if (failed > 0) process.exitCode = 1;
  else if (skipped > 0 && !allowSkips) process.exitCode = 2;
}

async function commandAsk(repoRoot: string, args: CliArgs): Promise<void> {
  const target = readStringFlag(args, "target")?.trim() ?? "";
  const explicitScenarioId = readStringFlag(args, "scenario");
  const yes = readBooleanFlag(args, "yes");
  const requireElectron = Boolean(args.flags.get("require-electron"));
  if (args.flags.get("json") && yes) {
    throw new Error("ask --json cannot be combined with --yes because execution emits progress logs.");
  }
  if (!target && !explicitScenarioId) {
    throw new Error("ask requires --target <测试目标> or --scenario <id>.");
  }
  const candidates = explicitScenarioId
    ? [requireScenario(args)]
    : rankScenariosForTarget(target).slice(0, 3).map((item) => item.scenario);

  if (candidates.length === 0) {
    throw new Error(
      `No Electron E2E scenarios matched target: ${target}`
    );
  }

  const primary = candidates[0];
  if (args.flags.get("json")) {
    console.log(JSON.stringify({
      target,
      recommendedScenario: toScenarioListItem(primary),
      candidates: candidates.map(toScenarioListItem),
      willRun: yes,
    }, null, 2));
  } else {
    printAskPlan(target, primary, candidates, yes);
  }

  if (!yes) return;

  const doctorArgs: CliArgs = {
    command: "doctor",
    flags: new Map<string, string | boolean>(requireElectron ? [["require-electron", true]] : []),
  };
  await commandDoctor(repoRoot, doctorArgs);
  if (process.exitCode && process.exitCode !== 0) return;

  await commandRun(repoRoot, {
    command: "run",
    flags: new Map<string, string | boolean>([
      ["scenario", primary.id],
      ["allow-skips", true],
    ]),
  });
}

async function commandBaseline(repoRoot: string, args: CliArgs): Promise<void> {
  if (!args.flags.get("update")) {
    throw new Error("baseline currently requires --update.");
  }
  const scenario = requireScenario(args);
  const runId = readStringFlag(args, "run-id") ?? createRunId();
  const writer = new EvidenceWriter(repoRoot, runId, scenario.id);
  await writer.init();
  const context = writer.createContext(true);
  const snapshot = scenario.collectBaseline
    ? await scenario.collectBaseline(context)
    : plannedBaselineSnapshot(scenario);
  const diff = await compareOrUpdateBaseline(repoRoot, snapshot, true);
  await context.writeJson("diff-against-baseline.json", diff);
  console.log(`BASELINE ${diff.status} ${diff.baselinePath ?? scenario.id}`);
}

async function commandCleanup(repoRoot: string, args: CliArgs): Promise<void> {
  const runId = readStringFlag(args, "run-id");
  if (!runId) throw new Error("cleanup requires --run-id <runId>.");
  if (!/^e2e-[a-zA-Z0-9._-]+$/.test(runId)) {
    throw new Error(`Refusing to cleanup unexpected run id: ${runId}`);
  }

  const runsRoot = path.join(repoRoot, "tests", "electron", "artifacts", "runs");
  const target = path.resolve(runsRoot, sanitizePathSegment(runId));
  if (!target.startsWith(runsRoot)) {
    throw new Error(`Refusing to cleanup path outside runs root: ${target}`);
  }
  await fs.rm(target, { recursive: true, force: true });
  console.log(`CLEANED ${toRepoRelative(repoRoot, target)}`);
}

function selectFromArgs(args: CliArgs): ScenarioDefinition[] {
  const profile = readProfileFlag(args);
  const tag = readStringFlag(args, "tag");
  const scenarioId = readStringFlag(args, "scenario");
  return selectScenarios({ profile, tag, scenarioId });
}

function requireScenario(args: CliArgs): ScenarioDefinition {
  const scenarioId = readStringFlag(args, "scenario");
  if (!scenarioId) throw new Error("Command requires --scenario <scenarioId>.");
  const scenario = findScenario(scenarioId);
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);
  return scenario;
}

function readProfileFlag(args: CliArgs): ScenarioProfile | undefined {
  const raw = readStringFlag(args, "profile");
  if (!raw) return undefined;
  if (!VALID_PROFILES.has(raw as ScenarioProfile)) {
    throw new Error(`Unknown profile: ${raw}`);
  }
  return raw as ScenarioProfile;
}

function readStringFlag(args: CliArgs, key: string): string | undefined {
  const value = args.flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function readBooleanFlag(args: CliArgs, key: string): boolean {
  const value = args.flags.get(key);
  if (value === undefined) return false;
  if (value === true) return true;
  throw new Error(`--${key} does not accept a value; use --${key} to confirm.`);
}

function validateFlags(args: CliArgs): void {
  const common = new Set(["json"]);
  const commandFlags: Record<string, Set<string>> = {
    doctor: new Set(["json", "require-electron"]),
    list: new Set(["profile", "tag", "scenario", "json"]),
    ask: new Set(["target", "scenario", "yes", "require-electron", "json"]),
    prepare: new Set(["scenario", "run-id"]),
    run: new Set([
      "profile",
      "tag",
      "scenario",
      "include-planned",
      "update-baseline",
      "run-id",
      "allow-skips",
      "start-stack",
    ]),
    baseline: new Set(["update", "scenario", "run-id"]),
    cleanup: new Set(["run-id"]),
    help: new Set(),
    "": new Set(),
  };
  const allowed = commandFlags[args.command] ?? common;
  for (const key of args.flags.keys()) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown flag for ${args.command}: --${key}`);
    }
  }
}

function rankScenariosForTarget(target: string): Array<{ scenario: ScenarioDefinition; score: number }> {
  const normalizedTarget = normalizeSearchText(target);
  if (!normalizedTarget) {
    return selectScenarios({}).map((scenario) => ({ scenario, score: scenario.priority === "P0" ? 2 : 1 }));
  }
  const targetTokens = tokenize(normalizedTarget);
  return selectScenarios({})
    .map((scenario) => {
      const haystack = normalizeSearchText([
        scenario.id,
        scenario.title,
        scenario.intent,
        scenario.sourceCapability,
        scenario.tags.join(" "),
        scenario.profiles.join(" "),
      ].join(" "));
      let textScore = haystack.includes(normalizedTarget) ? 10 : 0;
      for (const token of targetTokens) {
        if (haystack.includes(token)) textScore += token.length > 2 ? 3 : 1;
      }
      if (textScore === 0) return { scenario, score: 0 };
      let score = textScore;
      if (scenario.automationStatus === "ready") score += 2;
      if (scenario.priority === "P0") score += 1;
      return { scenario, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.scenario.id.localeCompare(b.scenario.id));
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return normalizeSearchText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function printAskPlan(
  target: string,
  primary: ScenarioDefinition,
  candidates: ScenarioDefinition[],
  willRun: boolean
): void {
  console.log("TESTLAB PLAN");
  if (target) console.log(`Target: ${target}`);
  console.log(`Recommended scenario: ${primary.id}`);
  console.log(`Title: ${primary.title}`);
  console.log(`Intent: ${primary.intent}`);
  console.log(`Priority: ${primary.priority}`);
  console.log(`Status: ${primary.automationStatus}`);
  if (primary.expectedFailure) {
    console.log(`Expected failure: ${primary.expectedFailure.reason}`);
    if (primary.expectedFailure.issue) console.log(`Expected failure issue: ${primary.expectedFailure.issue}`);
  }
  console.log(`Layer: ${primary.testLayer}`);
  if (primary.caseFile) console.log(`Case file: ${primary.caseFile}`);
  console.log(`Self-contained data: ${primary.dataContract.selfContained ? "yes" : "no"}`);
  if (primary.dataContract.setup.length) {
    console.log("Data setup:");
    for (const item of primary.dataContract.setup) {
      console.log(`- ${item}`);
    }
  }
  if (primary.userFlow?.length) {
    console.log("User flow:");
    for (const [index, step] of primary.userFlow.entries()) {
      console.log(`${index + 1}. ${step}`);
    }
  }
  if (primary.automationContract?.length) {
    console.log("Automation contract:");
    for (const item of primary.automationContract) {
      console.log(`- ${item}`);
    }
  }
  if (primary.interactionContract) {
    console.log("Interaction contract:");
    for (const item of primary.interactionContract.requiredUserActions) {
      console.log(`- user action: ${item}`);
    }
    for (const item of primary.interactionContract.allowedAutomationHelpers) {
      console.log(`- allowed helper: ${item}`);
    }
    for (const item of primary.interactionContract.forbiddenShortcuts) {
      console.log(`- forbidden shortcut: ${item}`);
    }
  }
  console.log(`Evidence: tests/electron/artifacts/runs/<runId>/${primary.id}`);
  if (candidates.length > 1) {
    console.log("Other candidates:");
    for (const scenario of candidates.slice(1)) {
      console.log(`- ${scenario.id}: ${scenario.title}`);
    }
  }
  console.log("");
  if (willRun) {
    console.log("Confirmed by --yes. Running doctor, then the recommended scenario.");
  } else {
    console.log("Review this plan. To execute:");
    console.log(`pnpm e2e:ask --target "${target || primary.id}" --yes --require-electron`);
  }
}

function toScenarioListItem(scenario: ScenarioDefinition): Record<string, unknown> {
  return {
    id: scenario.id,
    title: scenario.title,
    priority: scenario.priority,
    automationStatus: scenario.automationStatus,
    expectedFailure: scenario.expectedFailure,
    testLayer: scenario.testLayer,
    profiles: scenario.profiles,
    tags: scenario.tags,
    sourceCapability: scenario.sourceCapability,
    fixtures: scenario.fixtures,
    dataContract: scenario.dataContract,
    interactionContract: scenario.interactionContract,
    caseFile: scenario.caseFile,
    userFlow: scenario.userFlow,
    automationContract: scenario.automationContract,
  };
}

function defaultPreparationSummary(scenario: ScenarioDefinition, runId: string): Record<string, unknown> {
  return {
    runId,
    scenarioId: scenario.id,
    fixtures: scenario.fixtures,
    prepared: false,
    note: "No scenario-specific preparation script is registered yet.",
  };
}

function plannedBaselineSnapshot(scenario: ScenarioDefinition): BaselineSnapshot {
  return {
    schemaVersion: 1,
    scenarioId: scenario.id,
    title: scenario.title,
    automationStatus: scenario.automationStatus,
    profiles: scenario.profiles,
    tags: scenario.tags,
    sourceCapability: scenario.sourceCapability,
    data: {
      testLayer: scenario.testLayer,
      planned: true,
      stepCount: scenario.steps.length,
      fixtureCount: scenario.fixtures.length,
    },
  };
}

async function checkHttp(name: string, url: string): Promise<DoctorCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return {
      name,
      status: response.ok ? "ok" : "fail",
      message: `${url} -> HTTP ${response.status}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name, status: "fail", message: `${url} -> ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function checkTcp(
  name: string,
  host: string,
  port: number
): Promise<DoctorCheck> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ name, status: "fail", message: `${host}:${port} -> timeout` });
    }, 1500);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve({ name, status: "ok", message: `${host}:${port} -> listening` });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve({ name, status: "fail", message: `${host}:${port} -> ${error.message}` });
    });
  });
}

async function checkPath(
  repoRoot: string,
  relativePath: string
): Promise<DoctorCheck> {
  const target = path.join(repoRoot, relativePath);
  try {
    await fs.access(target);
    return { name: relativePath, status: "ok", message: "found" };
  } catch {
    return { name: relativePath, status: "fail", message: "missing" };
  }
}

async function checkArtifactWritable(repoRoot: string): Promise<DoctorCheck> {
  const target = path.join(repoRoot, "tests", "electron", "artifacts", ".doctor-write-test");
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "ok\n", "utf8");
    await fs.rm(target, { force: true });
    return { name: "artifacts", status: "ok", message: "writable" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: "artifacts", status: "fail", message };
  }
}

async function checkElectronCdp(repoRoot: string, required: boolean): Promise<DoctorCheck> {
  const result = spawnSync("node", [path.join(repoRoot, "scripts", "cdp-eval.mjs"), "--targets"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 15000,
  });
  if (result.status === 0 || looksLikeCdpTargets(result.stdout)) {
    const summary = summarizeCdpTargets(result.stdout);
    return { name: "electron-cdp", status: "ok", message: summary };
  }

  const stderr = result.stderr.trim() || result.stdout.trim() || result.error?.message || "CDP unavailable";
  return {
    name: "electron-cdp",
    status: required ? "fail" : "warn",
    message: `${stderr}; start Electron with \`cd apps/tabtin-electron && pnpm dev\``,
  };
}

function looksLikeCdpTargets(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as { endpoint?: unknown; pages?: unknown };
    return Boolean(parsed.endpoint && Array.isArray(parsed.pages));
  } catch {
    return false;
  }
}

function summarizeCdpTargets(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as { endpoint?: { port?: number }; pages?: Array<{ url?: string }> };
    const port = parsed.endpoint?.port ?? "unknown";
    const pages = parsed.pages?.length ?? 0;
    return `port=${port}, pages=${pages}`;
  } catch {
    return "reachable";
  }
}

function envUrl(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function envHost(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function printHelp(): void {
  console.log(`Electron E2E runner

Usage:
  pnpm e2e:doctor [--json]
  pnpm e2e:doctor --require-electron
  pnpm e2e:list [--profile smoke] [--tag tabdoc] [--json]
  pnpm e2e:ask --target "TabDoc 编辑保存" [--yes] [--require-electron]
  pnpm e2e:prepare --scenario <id> [--run-id e2e-...]
  pnpm e2e:run [--profile smoke] [--scenario <id>] [--include-planned] [--allow-skips]
  pnpm e2e:baseline --update --scenario <id>
  pnpm e2e:cleanup --run-id <runId>
`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAIL ${message}`);
  process.exit(1);
});
