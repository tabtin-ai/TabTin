#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { resolveRepoRoot, toRepoRelative } from "./paths";

type CreateArgs = {
  id: string;
  title: string;
  intent: string;
  layer: "ui" | "logic" | "infrastructure";
  domain: string;
  source: string;
  status: "ready" | "planned";
  dataSetup: string[];
  requiredUserActions: string[];
  uiSuccess: string;
  persistenceSuccess: string;
  forbiddenShortcuts: string[];
  expectedFailure?: {
    reason: string;
    stepId: string;
    messagePattern: string;
  };
  force: boolean;
};

type ParsedArgs = {
  flags: Map<string, string | boolean>;
};

const VALID_LAYERS = new Set<CreateArgs["layer"]>(["ui", "logic", "infrastructure"]);
const VALID_STATUS = new Set<CreateArgs["status"]>(["ready", "planned"]);

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.flags.get("help")) {
    printHelp();
    printScopingQuestions();
    return;
  }
  const repoRoot = resolveRepoRoot();
  if (parsed.flags.size === 0 && (!input.isTTY || !output.isTTY)) {
    printHelp();
    printScopingQuestions();
    return;
  }
  const args = parsed.flags.size === 0 ? await promptCreateArgs() : normalizeArgs(parsed);
  const names = deriveNames(args);

  const scenarioPath = path.join(repoRoot, "tests", "electron", "scenarios", `${names.slug}.scenario.ts`);
  const preparePath = path.join(repoRoot, "tests", "electron", "fixtures", `prepare-${names.slug}.ts`);
  const pythonPath = path.join(repoRoot, "tests", "electron", "fixtures", `${names.pythonModule}.py`);
  const actionPath = path.join(repoRoot, "tests", "electron", "actions", `${names.slug}.ts`);

  await writeNewFile(scenarioPath, renderScenario(args, names), args.force);
  await writeNewFile(preparePath, renderPrepare(args, names), args.force);
  await writeNewFile(pythonPath, renderPython(args), args.force);
  await writeNewFile(actionPath, renderAction(args, names), args.force);
  await registerScenario(repoRoot, args.id, names, args.force);

  console.log(`已创建 ${args.id}`);
  for (const filePath of [scenarioPath, preparePath, pythonPath, actionPath]) {
    console.log(toRepoRelative(repoRoot, filePath));
  }
  console.log("已注册到 tests/electron/runner/scenario-registry.ts");
  console.log(`可用这个命令验证：pnpm e2e:list --scenario ${args.id}`);
  printScopingQuestions(args);
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags.set(key, true);
    } else {
      flags.set(key, next);
      i += 1;
    }
  }
  return { flags };
}

function normalizeArgs(parsed: ParsedArgs): CreateArgs {
  const rawId = readStringFlag(parsed, "id");
  if (!rawId || !isValidScenarioId(rawId)) {
    throw new Error("e2e:create 需要 --id，格式类似 tabdata.member-mention。");
  }
  const id = normalizeScenarioId(rawId);
  const layer = readStringFlag(parsed, "layer") ?? "ui";
  if (!VALID_LAYERS.has(layer as CreateArgs["layer"])) {
    throw new Error(`未知 --layer：${layer}`);
  }
  const status = readStringFlag(parsed, "status") ?? (readSwitchFlag(parsed, "planned") ? "planned" : "ready");
  if (!VALID_STATUS.has(status as CreateArgs["status"])) {
    throw new Error(`未知 --status：${status}`);
  }
  const domain = readStringFlag(parsed, "domain") ?? id.split(".")[0];
  return {
    id,
    title: readStringFlag(parsed, "title") ?? id,
    intent: "TODO: 描述这个场景验证的用户任务、成功状态和为什么重要。",
    layer: layer as CreateArgs["layer"],
    domain,
    source: readStringFlag(parsed, "source") ?? `${domain} / TODO`,
    status: status as CreateArgs["status"],
    dataSetup: ["TODO: 创建测试用户、Space 和业务数据，所有数据带 run marker。"],
    requiredUserActions: [
      "TODO: 逐条列出必须经过真实模拟用户操作的点击、输入、选择、拖拽或提交动作。",
      "TODO: 未在本 contract 明确豁免的用户可感知步骤，都必须由 CDP/Playwright 用户输入事件触发。",
    ],
    uiSuccess: "TODO: 描述 UI 上可见的成功状态。",
    persistenceSuccess: "TODO: 描述后端或持久化记录上的成功状态。",
    forbiddenShortcuts: [
      "不得用 service/store/DB/localStorage 直写替代任何用户可感知步骤。",
      "不得用 DOM dispatchEvent 伪造 click/input 来替代 CDP/Playwright 用户输入事件。",
    ],
    force: readSwitchFlag(parsed, "force"),
  };
}

async function promptCreateArgs(): Promise<CreateArgs> {
  printHelp();
  console.log("");
  console.log("交互模式：默认只问创建测试真正需要的产品问题；方括号里是默认值，直接回车表示接受默认值。");
  const rl = createInterface({ input, output });
  try {
    const rawId = await askRequired(
      rl,
      "场景 id，例如 tabdoc.comment-mention-member",
      (value) => isValidScenarioId(value)
        ? undefined
        : "请使用稳定 id，格式类似 tabdata.member-mention；只允许英文、数字、点号和短横线。",
    );
    const id = normalizeScenarioId(rawId);
    if (id !== rawId) {
      console.log(`场景 id 已规范化为：${id}`);
    }
    const defaultDomain = id.split(".")[0] ?? "electron";
    const title = await askRequired(rl, "用例标题（给人看的中文标题）");
    const advanced = await askYesNo(rl, "是否进入高级设置（layer/domain/source/status/后端断言等）？", false);
    let layer: CreateArgs["layer"] = "ui";
    let domain = defaultDomain;
    let source = `${formatDomainLabel(domain)} / ${title}`;
    let status: CreateArgs["status"] = "ready";
    let intent = `验证「${title}」这个用户流程能通过真实 UI 操作完成，并达到预期成功状态。`;
    if (advanced) {
      layer = await askChoice(rl, "测试层级 layer", ["ui", "logic", "infrastructure"], "ui");
      domain = await askWithDefault(rl, "领域/标签 domain", defaultDomain);
      source = await askWithDefault(rl, "产品能力来源 source", `${formatDomainLabel(domain)} / ${title}`);
      status = await askChoice(rl, "自动化状态 automationStatus", ["ready", "planned"], "ready");
      intent = await askWithDefault(rl, "这个场景验证的用户目标和成功状态", intent);
    }

    const startState = await askWithDefault(rl, "用户从哪里开始", "已登录并位于目标 Space");
    const dataSetup = advanced
      ? await askList(rl, "UI 操作前允许用 fixture 准备的数据")
      : suggestDataSetup(domain, title, startState);
    const suggestedActions = suggestUserActions(domain, title);
    const requiredUserActions = layer === "ui"
      ? advanced
        ? await askList(rl, "用户要怎么操作（每行一个真实点击/输入/选择/拖拽/提交步骤）", { minItems: 1 })
        : await confirmOrEditList(rl, "系统建议的真实用户操作步骤", suggestedActions, { minItems: 1 })
      : [];
    const uiSuccess = await askWithDefault(rl, "最后在界面上看到什么算通过", suggestUiSuccess(domain, title));
    const persistenceSuccess = advanced
      ? await askWithDefault(rl, "后端/持久化里什么记录证明成功", "TODO: 根据业务数据补充后端/持久化断言。")
      : "TODO: 根据业务数据补充后端/持久化断言。";
    const forbiddenShortcuts = advanced
      ? await askList(rl, "这个用例禁止使用的捷径")
      : [];
    const expectedFailure = await askExpectedFailure(rl, id);
    const force = advanced ? await askYesNo(rl, "如果文件已存在，是否覆盖？", false) : false;

    return {
      id,
      title,
      intent,
      layer,
      domain,
      source,
      status,
      dataSetup: [
        `用户可见起点：${startState}`,
        ...dataSetup,
      ],
      requiredUserActions,
      uiSuccess,
      persistenceSuccess,
      forbiddenShortcuts: forbiddenShortcuts.length > 0 ? forbiddenShortcuts : [
        "不得用 service/store/DB/localStorage 直写替代任何用户可感知步骤。",
        "不得用 DOM dispatchEvent 伪造 click/input 来替代 CDP/Playwright 用户输入事件。",
      ],
      expectedFailure,
      force,
    };
  } finally {
    rl.close();
  }
}

function isValidScenarioId(value: string): boolean {
  return /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/i.test(value);
}

function normalizeScenarioId(value: string): string {
  return value.toLowerCase();
}

function formatDomainLabel(domain: string): string {
  const known: Record<string, string> = {
    tabdoc: "TabDoc",
    tabdata: "TabData",
    tabdesign: "TabDesign",
    tabslide: "TabSlide",
    chat: "Chat",
    workspace: "Workspace",
  };
  return known[domain] ?? domain;
}

function suggestDataSetup(domain: string, title: string, startState: string): string[] {
  if (domain === "tabdoc" && /搜索|search|ctrl\+?f|f5/i.test(title)) {
    return [
      `准备登录态和目标 Space：${startState}`,
      "创建一篇包含“TabTin 搜索测试关键词”的 run-scoped TabDoc 文档。",
    ];
  }
  return [
    `准备登录态和目标 Space：${startState}`,
    "按用例标题准备必要的 run-scoped 业务数据。",
  ];
}

function suggestUserActions(domain: string, title: string): string[] {
  if (domain === "tabdoc" && /搜索|search|ctrl\+?f|f5/i.test(title)) {
    return [
      "点击打开目标 TabDoc 文档。",
      "按下 Ctrl+F 打开文档搜索框。",
      "输入搜索关键词“TabTin 搜索测试关键词”。",
      "确认界面定位并高亮匹配内容。",
    ];
  }
  return [
    "通过真实点击打开目标功能入口。",
    "通过真实输入或选择完成核心操作。",
    "通过真实提交或确认动作触发结果。",
  ];
}

function suggestUiSuccess(domain: string, title: string): string {
  if (domain === "tabdoc" && /搜索|search|ctrl\+?f|f5/i.test(title)) {
    return "搜索框显示关键词，并且文档正文中对应内容被定位或高亮。";
  }
  return "界面出现符合用例标题的成功状态。";
}

async function confirmOrEditList(
  rl: Interface,
  prompt: string,
  suggestedItems: string[],
  options: { minItems?: number } = {},
): Promise<string[]> {
  console.log(`${prompt}：`);
  for (const [index, item] of suggestedItems.entries()) {
    console.log(`  ${index + 1}. ${item}`);
  }
  const accepted = await askYesNo(rl, "是否使用这组建议步骤？", true);
  if (accepted) return suggestedItems;
  return askList(rl, "请改写步骤", options);
}

async function askRequired(
  rl: Interface,
  prompt: string,
  validate?: (value: string) => string | undefined,
): Promise<string> {
  while (true) {
    const value = (await rl.question(`${prompt}: `)).trim();
    if (!value) {
      console.log("请输入一个值。");
      continue;
    }
    const error = validate?.(value);
    if (error) {
      console.log(error);
      continue;
    }
    return value;
  }
}

async function askWithDefault(
  rl: Interface,
  prompt: string,
  defaultValue: string,
): Promise<string> {
  const value = (await rl.question(`${prompt} [${defaultValue}]: `)).trim();
  return value || defaultValue;
}

async function askChoice<T extends string>(
  rl: Interface,
  prompt: string,
  choices: readonly T[],
  defaultValue: T,
): Promise<T> {
  while (true) {
    const value = (await rl.question(`${prompt} (${choices.join("/")}) [${defaultValue}]: `)).trim() || defaultValue;
    if (choices.includes(value as T)) return value as T;
    console.log(`请选择其中一个：${choices.join(", ")}`);
  }
}

async function askYesNo(
  rl: Interface,
  prompt: string,
  defaultValue: boolean,
): Promise<boolean> {
  const suffix = defaultValue ? "[Y/n]" : "[y/N]";
  while (true) {
    const value = (await rl.question(`${prompt} ${suffix}: `)).trim().toLowerCase();
    if (!value) return defaultValue;
    if (["y", "yes"].includes(value)) return true;
    if (["n", "no"].includes(value)) return false;
    console.log("请输入 y 或 n。");
  }
}

async function askList(
  rl: Interface,
  prompt: string,
  options: { minItems?: number } = {},
): Promise<string[]> {
  console.log(`${prompt}。每行输入一条，空行结束。`);
  const items: string[] = [];
  while (true) {
    const value = (await rl.question(`  ${items.length + 1}. `)).trim();
    if (!value) {
      if (items.length >= (options.minItems ?? 0)) break;
      console.log(`至少需要输入 ${options.minItems} 条。`);
      continue;
    }
    items.push(value);
  }
  return items;
}

async function askExpectedFailure(
  rl: Interface,
  scenarioId: string,
): Promise<CreateArgs["expectedFailure"]> {
  const enabled = await askYesNo(rl, "这个功能现在是否还没做完，需要跑到缺口后标为预期失败？", false);
  if (!enabled) return undefined;
  const reason = await askRequired(rl, "预期会卡在哪里（用一句人话描述）");
  const stepId = await askWithDefault(rl, "预期失败的 step id，不确定就直接回车", `${scenarioId}.main`);
  const messagePattern = await askWithDefault(rl, "失败日志里应该匹配哪句话，不确定就直接回车", reason);
  return { reason, stepId, messagePattern };
}

function readStringFlag(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function readSwitchFlag(parsed: ParsedArgs, key: string): boolean {
  const value = parsed.flags.get(key);
  if (value === undefined) return false;
  if (value === true) return true;
  throw new Error(`--${key} 不接受值；需要启用时请直接写 --${key}。`);
}

function deriveNames(args: CreateArgs): {
  slug: string;
  pythonModule: string;
  scenarioIdentifier: string;
  prepareIdentifier: string;
  actionIdentifier: string;
  preparationTypeIdentifier: string;
} {
  const slug = args.id.replace(/\./g, "-");
  const pascal = args.id
    .split(/[.-]/g)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
  return {
    slug,
    pythonModule: `${slug.replace(/-/g, "_")}_case`,
    scenarioIdentifier: toCamel(args.id),
    prepareIdentifier: `prepare${pascal}`,
    actionIdentifier: `run${pascal}Case`,
    preparationTypeIdentifier: `${pascal}Preparation`,
  };
}

function toCamel(value: string): string {
  const parts = value.split(/[.-]/g).filter(Boolean);
  return parts
    .map((part, index) => index === 0 ? part : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}

async function writeNewFile(filePath: string, contents: string, force: boolean): Promise<void> {
  if (!force) {
    try {
      await fs.access(filePath);
      throw new Error(`Refusing to overwrite existing file: ${filePath}`);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

async function registerScenario(
  repoRoot: string,
  scenarioId: string,
  names: ReturnType<typeof deriveNames>,
  force: boolean,
): Promise<void> {
  const registryPath = path.join(repoRoot, "tests", "electron", "runner", "scenario-registry.ts");
  const importLine = `import ${names.scenarioIdentifier} from "../scenarios/${names.slug}.scenario";`;
  const raw = await fs.readFile(registryPath, "utf8");
  if (raw.includes(importLine) || raw.includes(names.scenarioIdentifier)) {
    if (force) return;
    throw new Error(`场景看起来已经注册过：${scenarioId}`);
  }
  const withImport = raw.replace(
    /import type \{ ScenarioDefinition, ScenarioProfile \} from "\.\/types";/,
    `${importLine}\nimport type { ScenarioDefinition, ScenarioProfile } from "./types";`,
  );
  if (withImport === raw) {
    throw new Error("找不到 scenario-registry.ts 的 import 插入位置。");
  }
  const withScenario = withImport.replace(
    /^  evidenceBaselineSelfcheck,\n\];/m,
    `  ${names.scenarioIdentifier},\n  evidenceBaselineSelfcheck,\n];`,
  );
  if (withScenario === withImport) {
    throw new Error("找不到 scenario-registry.ts 的场景列表插入位置。");
  }
  await fs.writeFile(registryPath, withScenario, "utf8");
}

function renderScenario(args: CreateArgs, names: ReturnType<typeof deriveNames>): string {
  return `import { executableStep, scenario } from "../runner/scenario";
import { ${names.prepareIdentifier} } from "../fixtures/prepare-${names.slug}";
import { ${names.actionIdentifier} } from "../actions/${names.slug}";

export default scenario({
  id: ${JSON.stringify(args.id)},
  title: ${JSON.stringify(args.title)},
  intent: ${JSON.stringify(args.intent)},
  priority: "P0",
  profiles: ["regression", "data-seeding", "p0-plus"],
  tags: ["electron", ${JSON.stringify(args.domain)}],
  sourceCapability: ${JSON.stringify(args.source)},
  testLayer: ${JSON.stringify(args.layer)},
  dataContract: {
    selfContained: true,
    setup: [
${renderStringArray(args.dataSetup, 6)}
    ],
  },
  interactionContract: ${args.layer === "ui" ? `{
    requiredUserActions: [
${renderStringArray(args.requiredUserActions, 6)}
    ],
    allowedAutomationHelpers: [
      "允许后端准备 run-scoped fixture、登录态 bootstrap、只读 DOM/store 观察和持久化断言。",
      "TODO: CDP/Playwright 只能用于定位元素并派发真实用户输入事件，不能直接改 renderer 状态。",
    ],
    forbiddenShortcuts: [
${renderStringArray(args.forbiddenShortcuts, 6)}
    ],
  }` : "undefined"},
  automationContract: [
    ${JSON.stringify(`UI 成功证据：${args.uiSuccess}`)},
    ${JSON.stringify(`持久化成功证据：${args.persistenceSuccess}`)},
  ],
  automationStatus: ${JSON.stringify(args.status)},
${renderExpectedFailure(args)}
  fixtures: ["run-marker", "TODO"],
  prepare: ${names.prepareIdentifier},
  steps: [
    executableStep(
      ${JSON.stringify(`${args.id}.main`)},
      "TODO: 执行核心用户动作并断言结果",
      ${names.actionIdentifier},
    ),
  ],
});
`;
}

function renderStringArray(items: string[], indent: number): string {
  const prefix = " ".repeat(indent);
  const values = items.length > 0 ? items : ["TODO"];
  return values.map((item) => `${prefix}${JSON.stringify(item)},`).join("\n");
}

function renderExpectedFailure(args: CreateArgs): string {
  if (!args.expectedFailure) return "";
  return `  expectedFailure: {
    reason: ${JSON.stringify(args.expectedFailure.reason)},
    stepId: ${JSON.stringify(args.expectedFailure.stepId)},
    messagePattern: ${JSON.stringify(args.expectedFailure.messagePattern)},
  },
`;
}

function renderPrepare(args: CreateArgs, names: ReturnType<typeof deriveNames>): string {
  return `import type { RunContext } from "../runner/types";
import { parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";

export type ${names.preparationTypeIdentifier} = {
  runId: string;
  marker: string;
  prepared: boolean;
  source: "e2e-create-scaffold";
};

export async function ${names.prepareIdentifier}(
  context: RunContext,
): Promise<${names.preparationTypeIdentifier}> {
  const result = runCommand(
    resolvePythonCommand(context.repoRoot),
    [
      "apps/tabtin_django/manage.py",
      "shell",
      "-c",
      "exec(open('tests/electron/fixtures/${names.pythonModule}.py', encoding='utf-8').read())",
    ],
    {
      cwd: context.repoRoot,
      timeoutMs: 60000,
      env: {
        ...process.env,
        TABTIN_E2E_MODE: "prepare",
        TABTIN_E2E_RUN_ID: context.runId,
      },
    },
  );
  await context.writeText("logs/${names.slug}-prepare-django.log", result.stdout);
  const prepared = parseJsonSentinel<Omit<${names.preparationTypeIdentifier}, "source">>(
    result.stdout,
    "@@E2E@@",
  );
  const summary: ${names.preparationTypeIdentifier} = {
    ...prepared,
    source: "e2e-create-scaffold",
  };
  await context.writeJson("snapshots/${names.slug}-preparation.json", summary);
  return summary;
}
`;
}

function renderAction(args: CreateArgs, names: ReturnType<typeof deriveNames>): string {
  return `import type { RunContext, StepResult } from "../runner/types";
import type { ${names.preparationTypeIdentifier} } from "../fixtures/prepare-${names.slug}";

export async function ${names.actionIdentifier}(context: RunContext): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const prepared = context.preparedData as Partial<${names.preparationTypeIdentifier}>;
  const artifact = await context.writeJson("snapshots/${names.slug}-action-input.json", {
    runId: context.runId,
    scenarioId: context.scenarioId,
    prepared,
  });
  // UI 场景默认从真实用户动作开始：优先复用 actions/real-user-input.ts 的
  // cdpClickByExpression / cdpInsertText，或 Playwright/CDP 等价的鼠标、键盘、拖拽事件。
  // Runtime.evaluate 只能做只读观察、定位辅助或持久化断言，不能直接改 store/localStorage
  // 来替代用户可见步骤。
  return {
    id: ${JSON.stringify(`${args.id}.main`)},
    title: "TODO: 执行核心用户动作并断言结果",
    status: "failed",
    startedAt,
    endedAt: new Date().toISOString(),
    message: "e2e:create 已生成骨架。请补充 Electron 真实用户动作、UI 断言和持久化断言。",
    artifacts: [artifact],
  };
}
`;
}

function renderPython(args: CreateArgs): string {
  return `import json
import os


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required env: {name}")
    return value


def emit(payload: dict) -> None:
    print("@@E2E@@" + json.dumps(payload, ensure_ascii=False, default=str))


def main() -> None:
    mode = require_env("TABTIN_E2E_MODE")
    run_id = require_env("TABTIN_E2E_RUN_ID")
    marker = f"[{run_id}]"
    if mode == "prepare":
        emit({
            "runId": run_id,
            "marker": marker,
            "prepared": False,
            "todo": "TODO: create self-contained data for ${args.id}",
        })
        return
    if mode == "verify":
        emit({
            "runId": run_id,
            "verified": False,
            "todo": "TODO: verify persistence for ${args.id}",
        })
        return
    raise RuntimeError(f"Unknown TABTIN_E2E_MODE: {mode}")


main()
`;
}

function printHelp(): void {
  console.log(`创建 Electron E2E 测试用例骨架。

直接运行会进入简洁向导，只需要填写：场景 id、标题、用户起点、用户操作步骤、成功现象、是否预期失败。
不理解 layer/domain/source/status 时，直接用默认简洁模式即可。

用法：
  pnpm e2e:create --id tabdata.member-mention --title "..." --layer ui --domain tabdata --source "TabData / ..."

参数：
  --id       稳定的场景 id，例如 tabdata.member-mention
  --title    给人看的用例标题
  --layer    ui | logic | infrastructure（默认 ui）
  --domain   场景领域/标签（默认取 id 第一段）
  --source   产品能力来源说明
  --status   ready | planned（默认 ready）
  --planned  等价于 --status planned
  --force    覆盖已生成文件，或跳过已有 registry 项
`);
}

function printScopingQuestions(args?: CreateArgs): void {
  console.log("");
  console.log("实现 action 前，请先确认这些边界：");
  console.log("1. 用户可见的准确起点是什么，哪些数据可以提前作为 fixture 准备？");
  console.log("2. 哪些步骤必须是真实可见的点击、输入、选择、拖拽或提交？");
  console.log("3. UI 上什么产品状态证明成功，后端/持久化里什么记录证明成功？");
  console.log("4. 这个用例禁止哪些捷径，尤其是 service/store/DB/localStorage/DOM dispatchEvent？");
  console.log("5. 如果产品能力还没实现，是否要标记 expectedFailure，并写清楚失败指纹？");
  console.log("");
  console.log("建议下一步命令：");
  if (args) {
    console.log(`  pnpm e2e:list --scenario ${args.id}`);
    console.log(`  pnpm e2e:run --scenario ${args.id}`);
  } else {
    console.log(`  pnpm e2e:create --id tabdoc.comment-mention-member --title "..." --layer ui --domain tabdoc --source "TabDoc / ..."`);
    console.log("  pnpm e2e:list --scenario <scenario-id>");
    console.log("  pnpm e2e:run --scenario <scenario-id>");
  }
  console.log("");
  console.log("实现规则：除非场景 contract 明确豁免，否则每个用户可见 UI 步骤都必须使用真实 CDP/Playwright 输入事件。");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAIL ${message}`);
  process.exit(1);
});
