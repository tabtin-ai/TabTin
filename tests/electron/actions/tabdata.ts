import type { RunContext, StepResult } from "../runner/types";
import { CommandExecutionError, parseJsonSentinel, resolvePythonCommand, runCommand } from "../runner/process";
import type { TabDataFirstFivePreparation } from "../fixtures/prepare-tabdata-first-five";
import type { TabDataMemberMentionPreparation } from "../fixtures/prepare-tabdata-member-mention";

type TabDataCaseId =
  | "MDL-NEW-001"
  | "MDL-NEW-002"
  | "MDL-PLN-001"
  | "MDL-PLN-002"
  | "MDL-REL-001"
  | "SELECT-OPTION-MANAGEMENT";

type TabDataRuntimePreparation = {
  runId: string;
  marker: string;
  userId: string;
  organizationId: string;
  spaceId: string;
};

type TableSummary = {
  id: string;
  name: string;
  field_count: number;
  row_count: number;
  record_count: number;
  fields: Array<{
    id?: string;
    name: string;
    field_type: string;
    is_primary: boolean;
    config?: Record<string, unknown>;
  }>;
};

type RendererTabDataHomeEvidence = {
  ready: boolean;
  bodyText: string;
  visibleButtons: string[];
  foundNames: string[];
};

type SelectOptionManagementPreparePayload = {
  table: TableSummary;
  tableCreated: boolean;
  field: {
    id: string;
    name: string;
    choices: unknown[];
  };
  records: {
    usedRecordIds: string[];
    controlRecordId: string;
  };
};

type SelectOptionManagementRenameVerification = {
  table: TableSummary;
  field: {
    id: string;
    name: string;
    choices: unknown[];
  };
  renameUsedOption: {
    expectedLabel: string;
    affectedRecordIds: string[];
    recordValuesAfterRename: Array<string | null>;
    allRecordsMigrated: boolean;
    controlRecordId: string;
    controlRecordValueAfterRename: string | null;
    controlRecordUnchanged: boolean;
  };
};

type TabDataMemberMentionVerification = {
  recordId: string;
  fieldId: string;
  expectedUserId: string;
  actualValue: unknown;
  matched: boolean;
};

function requireTabDataPreparation(context: RunContext): TabDataFirstFivePreparation {
  const data = context.preparedData;
  if (
    typeof data.runId !== "string" ||
    typeof data.marker !== "string" ||
    typeof data.userId !== "string" ||
    typeof data.organizationId !== "string" ||
    typeof data.spaceId !== "string"
  ) {
    throw new Error("tabdata first-five scenarios require prepared runId, marker, userId, organizationId and spaceId.");
  }
  return data as unknown as TabDataFirstFivePreparation;
}

function requireTabDataMemberMentionPreparation(context: RunContext): TabDataMemberMentionPreparation {
  const data = context.preparedData;
  if (
    typeof data.runId !== "string" ||
    typeof data.marker !== "string" ||
    typeof data.userId !== "string" ||
    typeof data.organizationId !== "string" ||
    typeof data.spaceId !== "string" ||
    typeof (data as { table?: { id?: unknown } }).table?.id !== "string" ||
    typeof (data as { record?: { id?: unknown } }).record?.id !== "string" ||
    typeof (data as { fields?: { assignee?: { id?: unknown } } }).fields?.assignee?.id !== "string" ||
    typeof (data as { candidateMember?: { userId?: unknown } }).candidateMember?.userId !== "string"
  ) {
    throw new Error("tabdata.member-mention requires prepared table, record, assignee field and candidate member.");
  }
  return data as unknown as TabDataMemberMentionPreparation;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeForProgress(value: unknown): string {
  const text = JSON.stringify(redactForProgress(value));
  if (!text) return "no observation yet";
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function redactForProgress(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 5).map(redactForProgress);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/body|content|markdown|text|token|input|value/i.test(key)) {
      output[key] = "<redacted>";
    } else {
      output[key] = redactForProgress(item);
    }
  }
  return output;
}

function evalRendererJson<T>(
  context: RunContext,
  expression: string,
  options: { timeoutMs?: number } = {},
): T {
  const result = runCommand("node", ["scripts/cdp-eval.mjs", expression], {
    cwd: context.repoRoot,
    timeoutMs: options.timeoutMs ?? 70000,
  });
  return JSON.parse(result.stdout.trim()) as T;
}

async function runDjango<T>(
  context: RunContext,
  prepared: TabDataFirstFivePreparation,
  mode: string,
  logName: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ payload: T; artifacts: string[] }> {
  try {
    const result = runCommand(
      resolvePythonCommand(context.repoRoot),
      [
        "apps/tabtin_django/manage.py",
        "shell",
        "-c",
        "exec(open('tests/electron/fixtures/tabdata_first_five_case.py', encoding='utf-8').read())",
      ],
      {
        cwd: context.repoRoot,
        timeoutMs: 90000,
        env: {
          ...process.env,
          ...extraEnv,
          TABTIN_E2E_MODE: mode,
          TABTIN_E2E_RUN_ID: prepared.runId,
          TABTIN_E2E_USER_ID: prepared.userId,
          TABTIN_E2E_ORGANIZATION_ID: prepared.organizationId,
          TABTIN_E2E_SPACE_ID: prepared.spaceId,
        },
      },
    );
    const logPath = await context.writeText(`logs/${logName}.django.log`, result.stdout);
    return {
      payload: parseJsonSentinel<T>(result.stdout, "@@E2E@@"),
      artifacts: [logPath],
    };
  } catch (error) {
    if (error instanceof CommandExecutionError) {
      const stdoutPath = await context.writeText(`logs/${logName}.django.log`, error.stdout);
      const stderrPath = await context.writeText(`logs/${logName}.django.stderr.log`, error.stderr);
      error.message = `${error.message}\nArtifacts: ${stdoutPath}, ${stderrPath}`;
    }
    throw error;
  }
}

function openTabDataHomeExpression(prepared: TabDataRuntimePreparation): string {
  return `
(() => {
  const prepared = ${JSON.stringify(prepared)};
  const settingsKey = 'tabtin-prefs-settings-space';
  const settingsRaw = localStorage.getItem(settingsKey);
  const settingsData = settingsRaw ? JSON.parse(settingsRaw) : { state: {}, version: 1 };
  settingsData.state = { ...(settingsData.state || {}), isOpen: false };
  localStorage.setItem(settingsKey, JSON.stringify(settingsData));
  const key = 'tabtin-prefs-context-tabs';
  const raw = localStorage.getItem(key);
  const data = raw ? JSON.parse(raw) : { state: {}, version: 1 };
  const state = data.state || (data.state = {});
  const scope = 'desktop:organization:' + prepared.organizationId + ':user:' + prepared.userId;
  state.activeKeyBySpace = state.activeKeyBySpace || {};
  state.displayKeyBySpace = state.displayKeyBySpace || {};
  state.tabOrderBySpace = state.tabOrderBySpace || {};
  state.itemsBySpace = state.itemsBySpace || {};
  const order = state.tabOrderBySpace[scope] || [];
  if (!order.includes('apphome:tabdata')) order.unshift('apphome:tabdata');
  state.activeKeyBySpace[scope] = 'apphome:tabdata';
  state.displayKeyBySpace[scope] = 'apphome:tabdata';
  state.tabOrderBySpace[scope] = order;
  state.itemsBySpace[scope] = state.itemsBySpace[scope] || {};
  localStorage.setItem(key, JSON.stringify(data));
  location.reload();
  return JSON.stringify({ ok: true, scope });
})()
`;
}

function tabDataHomeEvidenceExpression(expectedNames: string[] = []): string {
  return `
(() => {
  const bodyText = document.body.innerText || '';
  const visibleButtons = Array.from(document.querySelectorAll('button'))
    .filter((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
    .map((button) => (button.innerText || button.textContent || '').trim())
    .filter(Boolean);
  const expectedNames = ${JSON.stringify(expectedNames)};
  const foundNames = expectedNames.filter((name) => bodyText.includes(name));
  return JSON.stringify({
    ready: bodyText.includes('多维表') && (
      expectedNames.length > 0
        ? foundNames.length === expectedNames.length
        : bodyText.includes('新建表格')
    ),
    bodyText: bodyText.slice(0, 9000),
    visibleButtons,
    foundNames,
  });
})()
`;
}

async function pollRenderer<T>(
  context: RunContext,
  expressionFactory: () => string,
  isDone: (value: T) => boolean,
  options: { timeoutMs: number; intervalMs: number; label?: string },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let last: T | undefined;
  let lastProgressAt = 0;
  while (Date.now() < deadline) {
    last = evalRendererJson<T>(context, expressionFactory());
    if (isDone(last)) return last;
    const now = Date.now();
    if (options.timeoutMs >= 10000 && now - lastProgressAt >= 5000) {
      lastProgressAt = now;
      await context.reportProgress(
        "WAIT",
        `${options.label ?? "renderer condition"} still waiting; last=${summarizeForProgress(last)}`,
      );
    }
    await sleep(options.intervalMs);
  }
  throw new Error(`Timed out waiting for renderer condition. Last value: ${JSON.stringify(last)}`);
}

async function openTabDataHome(
  context: RunContext,
  prepared: TabDataRuntimePreparation,
  expectedNames: string[] = [],
): Promise<{ evidence: RendererTabDataHomeEvidence; artifacts: string[] }> {
  const reload = runCommand("node", ["scripts/cdp-eval.mjs", openTabDataHomeExpression(prepared)], {
    cwd: context.repoRoot,
    timeoutMs: 30000,
  });
  const reloadLog = await context.writeText("logs/tabdata-open-home-cdp.log", reload.stdout);
  await sleep(5000);
  const evidence = await pollRenderer<RendererTabDataHomeEvidence>(
    context,
    () => tabDataHomeEvidenceExpression(expectedNames),
    (value) => value.ready && expectedNames.every((name) => value.foundNames.includes(name)),
    { timeoutMs: 45000, intervalMs: 3000, label: "TabData home ready" },
  );
  const snapshot = await context.writeJson("snapshots/tabdata-home-renderer.json", evidence);
  return { evidence, artifacts: [reloadLog, snapshot] };
}

async function waitForTableViewOpen(
  context: RunContext,
  tableName: string,
  snapshotName: string,
): Promise<{ evidence: { opened: boolean; bodyText: string }; artifact: string }> {
  await sleep(8000);
  const evidence = await pollRenderer<{ opened: boolean; bodyText: string }>(
    context,
    () => tableViewOpenEvidenceExpression(tableName),
    (value) => value.opened,
    { timeoutMs: 45000, intervalMs: 3000, label: `TabData table view ${tableName}` },
  );
  const artifact = await context.writeJson(snapshotName, evidence);
  return { evidence, artifact };
}

function clickNewTableExpression(): string {
  return `
(async () => {
  const buttons = Array.from(document.querySelectorAll('button'));
  const button = buttons.find((item) => {
    const text = (item.innerText || item.textContent || '').trim();
    const rect = item.getBoundingClientRect();
    return text === '新建表格' && rect.width > 0 && rect.height > 0;
  });
  if (!button) {
    return JSON.stringify({
      clicked: false,
      reason: 'new table button not found',
      bodyText: (document.body.innerText || '').slice(0, 6000),
    });
  }
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 9000));
  const bodyText = document.body.innerText || '';
  return JSON.stringify({
    clicked: true,
    bodyText: bodyText.slice(0, 9000),
    enteredEditor: bodyText.includes('表格视图') || bodyText.includes('已同步'),
    hasUntitledTable: bodyText.includes('未命名表格'),
    hasCustomerList: bodyText.includes('客户清单'),
  });
})()
`;
}

function openTableResourceExpression(
  prepared: TabDataRuntimePreparation,
  table: { id: string; name: string },
): string {
  return `
(async () => {
  const prepared = ${JSON.stringify(prepared)};
  const table = ${JSON.stringify(table)};
  const tableName = table.name;
  const candidates = Array.from(document.querySelectorAll('*'))
    .filter((element) => {
      const text = (element.innerText || element.textContent || '').trim();
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && text === tableName;
    });
  const mainPaneCandidates = candidates.filter((element) => element.getBoundingClientRect().left > 300);
  const target = (mainPaneCandidates.length ? mainPaneCandidates : candidates)
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (br.width * br.height) - (ar.width * ar.height);
    })[0];
  if (!target) {
    return JSON.stringify({
      opened: false,
      reason: 'table resource row not found',
      bodyText: (document.body.innerText || '').slice(0, 9000),
    });
  }
  const rect = target.getBoundingClientRect();
  const activationTarget = target.closest('button,[role="button"],a,tr,li,[data-resource-id],[data-context-item-id]') || target;
  const activationRect = activationTarget.getBoundingClientRect();
  const x = activationRect.left + Math.min(Math.max(activationRect.width / 2, 20), activationRect.width - 8);
  const y = rect.top + rect.height / 2;
  for (const detail of [1, 2]) {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      activationTarget.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        detail,
        buttons: type === 'pointerdown' || type === 'mousedown' ? 1 : 0,
      }));
    }
    if (detail === 2) {
      activationTarget.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        detail,
        buttons: 0,
      }));
    }
    if (typeof activationTarget.click === 'function') {
      activationTarget.click();
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  let bodyText = document.body.innerText || '';
  const deadline = Date.now() + 15000;
  while (!(bodyText.includes('表格视图') && bodyText.includes(tableName)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    bodyText = document.body.innerText || '';
  }
  return JSON.stringify({
    opened: bodyText.includes('表格视图') && bodyText.includes(tableName),
    clicked: { x, y, targetText: (target.innerText || target.textContent || '').trim() },
    bodyText: bodyText.slice(0, 9000),
  });
})()
`;
}

function tableViewOpenEvidenceExpression(tableName: string): string {
  return `
(() => {
  const tableName = ${JSON.stringify(tableName)};
  const bodyText = document.body.innerText || '';
  return JSON.stringify({
    opened: bodyText.includes('表格视图') && bodyText.includes(tableName),
    bodyText: bodyText.slice(0, 9000),
  });
})()
`;
}

function openSelectFieldPanelExpression(payload: SelectOptionManagementPreparePayload): string {
  return `
(async () => {
  const tableId = ${JSON.stringify(payload.table.id)};
  const fieldId = ${JSON.stringify(payload.field.id)};
  const [{ getOrCreateTableStore }, { useFieldSettingStore }] = await Promise.all([
    import('/src/components/table/tableStorePool.ts'),
    import('/src/stores/useFieldSettingStore.ts'),
  ]);
  const store = getOrCreateTableStore(tableId);
  if (!store.getState().fields?.length) {
    await store.getState().loadFields(tableId);
  }
  const field = store.getState().fields.find((item) => item.id === fieldId);
  if (!field) {
    return JSON.stringify({
      opened: false,
      reason: 'select field not found in renderer store',
      fields: store.getState().fields.map((item) => ({ id: item.id, name: item.name, type: item.field_type })),
    });
  }
  useFieldSettingStore.getState().openForEdit(fieldId, undefined, tableId);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const bodyText = document.body.innerText || '';
  const inputs = Array.from(document.querySelectorAll('input'))
    .filter((input) => {
      const rect = input.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
    .map((input) => ({
      value: input.value,
      placeholder: input.placeholder,
    }));
  return JSON.stringify({
    opened: bodyText.includes('编辑字段') && bodyText.includes('选项列表'),
    bodyText: bodyText.slice(0, 9000),
    field: { id: field.id, name: field.name, options: field.options },
    inputs,
  });
})()
`;
}

function renameSelectChoiceAndSaveExpression(
  payload: SelectOptionManagementPreparePayload,
  beforeLabel: string,
  afterLabel: string,
): string {
  return `
(async () => {
  const tableId = ${JSON.stringify(payload.table.id)};
  const fieldId = ${JSON.stringify(payload.field.id)};
  const beforeLabel = ${JSON.stringify(beforeLabel)};
  const afterLabel = ${JSON.stringify(afterLabel)};

  function clickElement(element) {
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      element.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY,
        buttons: type.includes('up') ? 0 : 1,
      }));
    }
  }

  function setNativeValue(input, value) {
    input.focus();
    input.select?.();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const visibleInputs = Array.from(document.querySelectorAll('input')).filter((input) => {
    const rect = input.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  const choiceInput = visibleInputs.find((input) => input.value === beforeLabel);
  if (!choiceInput) {
    return JSON.stringify({
      saved: false,
      reason: 'choice input not found',
      visibleInputs: visibleInputs.map((input) => ({ value: input.value, placeholder: input.placeholder })),
      bodyText: (document.body.innerText || '').slice(0, 9000),
    });
  }

  setNativeValue(choiceInput, afterLabel);
  await new Promise((resolve) => setTimeout(resolve, 250));

  const saveButton = Array.from(document.querySelectorAll('button'))
    .filter((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
    .find((button) => (button.innerText || button.textContent || '').trim() === '保存');
  if (!saveButton) {
    return JSON.stringify({
      saved: false,
      reason: 'save button not found',
      bodyText: (document.body.innerText || '').slice(0, 9000),
    });
  }
  clickElement(saveButton);

  const [{ getOrCreateTableStore }, { useFieldSettingStore }] = await Promise.all([
    import('/src/components/table/tableStorePool.ts'),
    import('/src/stores/useFieldSettingStore.ts'),
  ]);
  const store = getOrCreateTableStore(tableId);
  const deadline = Date.now() + 20000;
  let lastField = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!useFieldSettingStore.getState().isOpen) {
      await store.getState().loadFields(tableId);
      lastField = store.getState().fields.find((item) => item.id === fieldId) || null;
      break;
    }
  }
  if (!lastField) {
    lastField = store.getState().fields.find((item) => item.id === fieldId) || null;
  }
  return JSON.stringify({
    saved: Boolean(lastField),
    field: lastField ? { id: lastField.id, name: lastField.name, options: lastField.options } : null,
    drawerStillOpen: useFieldSettingStore.getState().isOpen,
    bodyText: (document.body.innerText || '').slice(0, 9000),
  });
})()
`;
}

async function listTables(
  context: RunContext,
  prepared: TabDataFirstFivePreparation,
  logName: string,
): Promise<{ tables: TableSummary[]; artifacts: string[] }> {
  const result = await runDjango<{ tables: TableSummary[] }>(context, prepared, "list_tables", logName);
  return { tables: result.payload.tables, artifacts: result.artifacts };
}

async function verifyNewTableCreatedByUi(
  context: RunContext,
  prepared: TabDataFirstFivePreparation,
  beforeTableIds: string[],
  logName: string,
  options: { createdAfter: string },
): Promise<{ originalName: string; table: TableSummary; artifacts: string[] }> {
  const result = await runDjango<{ originalName: string; table: TableSummary }>(
    context,
    prepared,
    "verify_new_table",
    logName,
    {
      TABTIN_E2E_BEFORE_TABLE_IDS: JSON.stringify(beforeTableIds),
      TABTIN_E2E_CREATED_AFTER: options.createdAfter,
      TABTIN_E2E_UI_TABLE_NAME_PREFIX: `[${prepared.runId}]`,
    },
  );
  return {
    originalName: result.payload.originalName,
    table: result.payload.table,
    artifacts: result.artifacts,
  };
}

async function runMdlNew001(context: RunContext, prepared: TabDataFirstFivePreparation): Promise<StepResult> {
  const artifacts: string[] = [];
  const before = await listTables(context, prepared, "mdl-new-001-before");
  artifacts.push(...before.artifacts);
  const home = await openTabDataHome(context, prepared);
  artifacts.push(...home.artifacts);

  const clickStartedAt = new Date().toISOString();
  const clickEvidence = evalRendererJson<{
    clicked: boolean;
    reason?: string;
    bodyText: string;
    enteredEditor?: boolean;
    hasUntitledTable?: boolean;
    hasCustomerList?: boolean;
  }>(context, clickNewTableExpression(), { timeoutMs: 70000 });
  artifacts.push(await context.writeJson("snapshots/mdl-new-001-click-new-table.json", clickEvidence));

  if (!clickEvidence.clicked) {
    return {
      status: "failed",
      message: clickEvidence.reason ?? "TabData new table button was not clickable.",
      artifacts,
    } as StepResult;
  }

  const after = await verifyNewTableCreatedByUi(
    context,
    prepared,
    before.tables.map((table) => table.id),
    "mdl-new-001-after",
    { createdAfter: clickStartedAt },
  );
  artifacts.push(...after.artifacts);
  artifacts.push(await context.writeJson("snapshots/mdl-new-001-created-table.json", after.table));

  const issues: string[] = [];
  if (!clickEvidence.enteredEditor) issues.push("创建后没有直接进入表格编辑态。");
  if (after.originalName !== "客户清单") {
    issues.push(`期望创建时填写并保存表名“客户清单”，实际新表名为“${after.originalName}”。`);
  }
  if (!clickEvidence.hasCustomerList) {
    issues.push("Electron 编辑态没有显示“客户清单”。");
  }

  return {
    status: issues.length > 0 ? "failed" : "passed",
    message: issues.length > 0
      ? `MDL-NEW-001 failed: ${issues.join(" ")}`
      : "MDL-NEW-001 passed: named table was created and opened in edit mode.",
    artifacts,
  } as StepResult;
}

async function runMdlNew002(context: RunContext, prepared: TabDataFirstFivePreparation): Promise<StepResult> {
  const artifacts: string[] = [];
  const before = await listTables(context, prepared, "mdl-new-002-before");
  artifacts.push(...before.artifacts);
  artifacts.push(...(await openTabDataHome(context, prepared)).artifacts);

  const clickStartedAt = new Date().toISOString();
  const clickEvidence = evalRendererJson<{
    clicked: boolean;
    reason?: string;
  }>(context, clickNewTableExpression(), { timeoutMs: 70000 });
  artifacts.push(await context.writeJson("snapshots/mdl-new-002-empty-name-click.json", clickEvidence));
  if (!clickEvidence.clicked) {
    return {
      status: "failed",
      message: clickEvidence.reason ?? "TabData new table button was not clickable.",
      artifacts,
    } as StepResult;
  }

  const defaultName = await verifyNewTableCreatedByUi(
    context,
    prepared,
    before.tables.map((table) => table.id),
    "mdl-new-002-default-name",
    { createdAfter: clickStartedAt },
  );
  artifacts.push(...defaultName.artifacts);

  const special = await runDjango<{
    emptyBackendName: { accepted: boolean; error?: string; message?: string };
    specialTable: TableSummary;
  }>(context, prepared, "MDL-NEW-002", "mdl-new-002-special-name");
  artifacts.push(...special.artifacts);
  artifacts.push(await context.writeJson("snapshots/mdl-new-002-backend.json", special.payload));

  const resourceNames = [defaultName.table.name, special.payload.specialTable.name];
  artifacts.push(...(await openTabDataHome(context, prepared, resourceNames)).artifacts);

  const issues: string[] = [];
  if (!defaultName.originalName.includes("未命名表格")) {
    issues.push(`空名创建期望默认命名包含“未命名表格”，实际为“${defaultName.originalName}”。`);
  }
  if (!special.payload.specialTable.name.includes("客户/2026 版")) {
    issues.push(`特殊字符表名未保留，实际为“${special.payload.specialTable.name}”。`);
  }

  return {
    status: issues.length > 0 ? "failed" : "passed",
    message: issues.length > 0
      ? `MDL-NEW-002 failed: ${issues.join(" ")}`
      : "MDL-NEW-002 passed: default naming and special-character table persistence are visible in TabData resources.",
    artifacts,
  } as StepResult;
}

function hasField(table: TableSummary, name: string, fieldType: string): boolean {
  return table.fields.some((field) => field.name === name && field.field_type === fieldType);
}

async function runBackendCase<T>(
  context: RunContext,
  prepared: TabDataFirstFivePreparation,
  caseId: Exclude<TabDataCaseId, "MDL-NEW-001" | "MDL-NEW-002">,
): Promise<{ payload: T; artifacts: string[] }> {
  const result = await runDjango<T>(context, prepared, caseId, caseId.toLowerCase());
  await context.writeJson(`snapshots/${caseId.toLowerCase()}.json`, result.payload);
  return result;
}

async function runMemberMentionDjango<T>(
  context: RunContext,
  prepared: TabDataMemberMentionPreparation,
  mode: "verify",
  logName: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ payload: T; artifacts: string[] }> {
  try {
    const result = runCommand(
      resolvePythonCommand(context.repoRoot),
      [
        "apps/tabtin_django/manage.py",
        "shell",
        "-c",
        "exec(open('tests/electron/fixtures/tabdata_member_mention_case.py', encoding='utf-8').read())",
      ],
      {
        cwd: context.repoRoot,
        timeoutMs: 60000,
        env: {
          ...process.env,
          ...extraEnv,
          TABTIN_E2E_MODE: mode,
          TABTIN_E2E_RUN_ID: prepared.runId,
          TABTIN_E2E_USER_ID: prepared.userId,
          TABTIN_E2E_ORGANIZATION_ID: prepared.organizationId,
          TABTIN_E2E_SPACE_ID: prepared.spaceId,
        },
      },
    );
    const logPath = await context.writeText(`logs/${logName}.django.log`, result.stdout);
    return {
      payload: parseJsonSentinel<T>(result.stdout, "@@E2E@@"),
      artifacts: [logPath],
    };
  } catch (error) {
    if (error instanceof CommandExecutionError) {
      const stdoutPath = await context.writeText(`logs/${logName}.django.log`, error.stdout);
      const stderrPath = await context.writeText(`logs/${logName}.django.stderr.log`, error.stderr);
      error.message = `${error.message}\nArtifacts: ${stdoutPath}, ${stderrPath}`;
    }
    throw error;
  }
}

async function runMdlPln001(context: RunContext, prepared: TabDataFirstFivePreparation): Promise<StepResult> {
  const artifacts: string[] = [];
  const { payload, artifacts: djangoArtifacts } = await runBackendCase<{ table: TableSummary }>(
    context,
    prepared,
    "MDL-PLN-001",
  );
  artifacts.push(...djangoArtifacts);
  artifacts.push(...(await openTabDataHome(context, prepared, [payload.table.name])).artifacts);

  const issues: string[] = [];
  if (!hasField(payload.table, "姓名", "text")) issues.push("缺少文本字段“姓名”。");
  if (!hasField(payload.table, "岗位", "select")) issues.push("缺少单选字段“岗位”。");
  if (!hasField(payload.table, "入职日期", "date")) issues.push("缺少日期字段“入职日期”。");
  if (payload.table.fields.some((field) => field.field_type === "link")) {
    issues.push("简单单实体需求不应创建关联字段。");
  }

  return {
    status: issues.length > 0 ? "failed" : "passed",
    message: issues.length > 0
      ? `MDL-PLN-001 failed: ${issues.join(" ")}`
      : "MDL-PLN-001 passed: simple requirement became one flat table with text/select/date fields.",
    artifacts,
  } as StepResult;
}

async function runMdlPln002(context: RunContext, prepared: TabDataFirstFivePreparation): Promise<StepResult> {
  const artifacts: string[] = [];
  const { payload, artifacts: djangoArtifacts } = await runBackendCase<{
    projectTable: TableSummary;
    taskTable: TableSummary;
    taskLinkField: { id: string; config: Record<string, unknown> };
    symmetricField: { id: string; name: string; config: Record<string, unknown> } | null;
    rollupField: { id: string; name: string; config: Record<string, unknown> } | null;
  }>(context, prepared, "MDL-PLN-002");
  artifacts.push(...djangoArtifacts);
  artifacts.push(...(await openTabDataHome(context, prepared, [payload.projectTable.name, payload.taskTable.name])).artifacts);

  const issues: string[] = [];
  if (!payload.projectTable.name.includes("项目建模验收")) issues.push("未创建项目表。");
  if (!payload.taskTable.name.includes("任务建模验收")) issues.push("未创建任务表。");
  if (payload.taskLinkField.config.relationship !== "ManyOne") issues.push("任务表到项目表的关联不是 ManyOne。");
  if (!payload.symmetricField) issues.push("项目表侧缺少反向关联字段。");
  if (!payload.rollupField) issues.push("项目表侧缺少总工时汇总字段。");

  return {
    status: issues.length > 0 ? "failed" : "passed",
    message: issues.length > 0
      ? `MDL-PLN-002 failed: ${issues.join(" ")}`
      : "MDL-PLN-002 passed: project/task model split into linked tables with rollup support.",
    artifacts,
  } as StepResult;
}

async function runMdlRel001(context: RunContext, prepared: TabDataFirstFivePreparation): Promise<StepResult> {
  const artifacts: string[] = [];
  const { payload, artifacts: djangoArtifacts } = await runBackendCase<{
    projectTable: TableSummary;
    taskTable: TableSummary;
    relationResult: {
      link_records_task_side: number;
      link_records_project_side: number;
      alpha_task_count: number;
      beta_task_count: number;
      alpha_rollup: number;
      beta_rollup: number;
    };
  }>(context, prepared, "MDL-REL-001");
  artifacts.push(...djangoArtifacts);
  artifacts.push(...(await openTabDataHome(context, prepared, [payload.projectTable.name, payload.taskTable.name])).artifacts);

  const relation = payload.relationResult;
  const issues: string[] = [];
  if (relation.link_records_task_side !== 3) issues.push(`任务侧关联记录数应为 3，实际 ${relation.link_records_task_side}。`);
  if (relation.link_records_project_side !== 3) issues.push(`项目侧反向关联记录数应为 3，实际 ${relation.link_records_project_side}。`);
  if (relation.alpha_task_count !== 2) issues.push(`Alpha 应关联 2 条任务，实际 ${relation.alpha_task_count}。`);
  if (relation.beta_task_count !== 1) issues.push(`Beta 应关联 1 条任务，实际 ${relation.beta_task_count}。`);
  if (relation.alpha_rollup !== 7) issues.push(`Alpha 总工时应为 7，实际 ${relation.alpha_rollup}。`);
  if (relation.beta_rollup !== 3) issues.push(`Beta 总工时应为 3，实际 ${relation.beta_rollup}。`);

  return {
    status: issues.length > 0 ? "failed" : "passed",
    message: issues.length > 0
      ? `MDL-REL-001 failed: ${issues.join(" ")}`
      : "MDL-REL-001 passed: task records link to projects and project-side reverse links/rollups are correct.",
    artifacts,
  } as StepResult;
}

function memberMentionAtInputExpression(prepared: TabDataMemberMentionPreparation): string {
  return `
(async () => {
  const prepared = ${JSON.stringify(prepared)};
  const [{ useOrganizationStore }] = await Promise.all([
    import('/src/stores/useOrganizationStore.ts'),
  ]);
  if (typeof useOrganizationStore.getState().loadMembers === 'function') {
    await useOrganizationStore.getState().loadMembers(prepared.organizationId);
  }

  function visible(element) {
    const rect = element?.getBoundingClientRect?.();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  }

  function dispatchMouse(element, type, x, y, detail = 1) {
    element.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type.includes('up') ? 0 : 1,
      detail,
    }));
  }

  const canvases = Array.from(document.querySelectorAll('canvas')).filter(visible);
  const canvas = canvases.sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return (br.width * br.height) - (ar.width * ar.height);
  })[0] || null;
  if (!canvas) {
    return JSON.stringify({
      openedEditor: false,
      reason: 'visible grid canvas not found',
      bodyText: (document.body.innerText || '').slice(0, 4000),
    });
  }

  const stage = document.querySelector('[data-t-grid-stage]') || canvas.closest('[data-t-grid-stage]');
  if (!stage) {
    return JSON.stringify({
      openedEditor: false,
      reason: 'grid interaction stage not found',
      bodyText: (document.body.innerText || '').slice(0, 4000),
    });
  }

  const rect = stage.getBoundingClientRect();
  const activeOverlay = document.querySelector('[data-grid-overlay="cell-editor"]');
  const activeRect = activeOverlay?.getBoundingClientRect();
  const x = activeRect
    ? Math.min(activeRect.right + Math.max(activeRect.width / 2, 72), rect.right - 24)
    : rect.left + Math.min(Math.max(rect.width * 0.42, 320), rect.width - 24);
  const y = activeRect
    ? activeRect.top + activeRect.height / 2
    : rect.top + Math.min(Math.max(48, rect.height * 0.08), rect.height - 24);
  dispatchMouse(stage, 'mousemove', x, y);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  dispatchMouse(stage, 'mousedown', x, y);
  dispatchMouse(stage, 'mouseup', x, y);
  dispatchMouse(stage, 'click', x, y, 1);
  await new Promise((resolve) => setTimeout(resolve, 180));
  dispatchMouse(stage, 'mousemove', x, y, 2);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  dispatchMouse(stage, 'mousedown', x, y, 2);
  dispatchMouse(stage, 'mouseup', x, y, 2);
  dispatchMouse(stage, 'click', x, y, 2);
  dispatchMouse(stage, 'dblclick', x, y, 2);
  await new Promise((resolve) => setTimeout(resolve, 1200));

  let editor = document.querySelector('.tt-grid-user-editor');
  if (!editor) {
    return JSON.stringify({
      openedEditor: false,
      reason: 'member editor did not open after cell double click',
      click: { x, y },
      stageRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      activeOverlayRect: activeRect
        ? { left: activeRect.left, top: activeRect.top, width: activeRect.width, height: activeRect.height }
        : null,
      bodyText: (document.body.innerText || '').slice(0, 4000),
    });
  }
  const input = editor.querySelector('input');
  if (!input) {
    return JSON.stringify({
      openedEditor: true,
      typedAt: false,
      reason: 'member editor input not found',
      editorText: editor.innerText,
    });
  }

  input.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, '@');
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '@' }));
  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '@' }));
  await new Promise((resolve) => setTimeout(resolve, 1000));

  editor = document.querySelector('.tt-grid-user-editor');
  const options = Array.from(document.querySelectorAll('.tt-grid-user-editor [role="option"]')).map((option) => ({
    text: (option.innerText || option.textContent || '').trim(),
    visible: visible(option),
  }));
  const candidateNeedles = [prepared.candidateMember.displayName, prepared.candidateMember.email].filter(Boolean);
  const candidateVisible = options.some((option) =>
    candidateNeedles.some((needle) => option.text.includes(needle))
  );
  return JSON.stringify({
    openedEditor: Boolean(editor),
    typedAt: true,
    candidateVisible,
    optionCount: options.length,
    options,
    inputValue: input.value,
  });
})()
`;
}

function selectMemberCandidateExpression(prepared: TabDataMemberMentionPreparation): string {
  return `
(async () => {
  const prepared = ${JSON.stringify(prepared)};
  function clickElement(element) {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      element.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        buttons: type === 'pointerdown' || type === 'mousedown' ? 1 : 0,
      }));
    }
    if (typeof element.click === 'function') {
      element.click();
    }
  }
  const candidateNeedles = [prepared.candidateMember.displayName, prepared.candidateMember.email].filter(Boolean);
  const options = Array.from(document.querySelectorAll('.tt-grid-user-editor [role="option"]'));
  const target = options.find((option) => {
    const text = (option.innerText || option.textContent || '').trim();
    return candidateNeedles.some((needle) => text.includes(needle));
  });
  if (!target) {
    return JSON.stringify({
      clicked: false,
      reason: 'candidate member option not found',
      options: options.map((option) => (option.innerText || option.textContent || '').trim()),
    });
  }
  clickElement(target);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  return JSON.stringify({
    clicked: true,
    editorStillOpen: Boolean(document.querySelector('.tt-grid-user-editor')),
    bodyText: (document.body.innerText || '').slice(0, 4000),
  });
})()
`;
}

function reloadExpression(): string {
  return `
(() => {
  setTimeout(() => location.reload(), 300);
  return JSON.stringify({ reloading: true });
})()
`;
}

export async function runTabDataMemberMentionCase(context: RunContext): Promise<StepResult> {
  const artifacts: string[] = [];
  const prepared = requireTabDataMemberMentionPreparation(context);

  await context.reportProgress("TABDATA", "open TabData home for member mention");
  artifacts.push(...(await openTabDataHome(context, prepared, [prepared.table.name])).artifacts);

  await context.reportProgress("TABDATA", `open member mention table ${prepared.table.name}`);
  const openResource = evalRendererJson<{
    opened: boolean;
    reloading?: boolean;
    reason?: string;
    bodyText: string;
  }>(context, openTableResourceExpression(prepared, prepared.table), { timeoutMs: 70000 });
  artifacts.push(await context.writeJson("snapshots/tabdata-member-mention-open-table.json", openResource));
  if (!openResource.opened) {
    if (openResource.reloading) {
      const opened = await waitForTableViewOpen(
        context,
        prepared.table.name,
        "snapshots/tabdata-member-mention-open-table-ready.json",
      );
      artifacts.push(opened.artifact);
    } else {
    return {
      status: "failed",
      message: openResource.reason ?? "tabdata.member-mention failed: could not open prepared TabData table.",
      artifacts,
    } as StepResult;
    }
  }

  await context.reportProgress("TABDATA", "click user field cell and type @");
  const atEvidence = evalRendererJson<{
    openedEditor: boolean;
    typedAt?: boolean;
    candidateVisible?: boolean;
    reason?: string;
  }>(context, memberMentionAtInputExpression(prepared), { timeoutMs: 70000 });
  artifacts.push(await context.writeJson("snapshots/tabdata-member-mention-at-input.json", atEvidence));
  if (!atEvidence.openedEditor || !atEvidence.typedAt || !atEvidence.candidateVisible) {
    return {
      status: "failed",
      message: atEvidence.reason ?? "tabdata.member-mention failed: @ input did not show the expected member candidate.",
      artifacts,
    } as StepResult;
  }

  await context.reportProgress("TABDATA", "select member candidate");
  const selectEvidence = evalRendererJson<{
    clicked: boolean;
    reason?: string;
  }>(context, selectMemberCandidateExpression(prepared), { timeoutMs: 70000 });
  artifacts.push(await context.writeJson("snapshots/tabdata-member-mention-select-candidate.json", selectEvidence));
  if (!selectEvidence.clicked) {
    return {
      status: "failed",
      message: selectEvidence.reason ?? "tabdata.member-mention failed: candidate member option was not selected.",
      artifacts,
    } as StepResult;
  }

  await context.reportProgress("TABDATA", "verify selected member persisted");
  const verify = await runMemberMentionDjango<TabDataMemberMentionVerification>(
    context,
    prepared,
    "verify",
    "tabdata-member-mention-verify",
    {
      TABTIN_E2E_RECORD_ID: prepared.record.id,
      TABTIN_E2E_FIELD_ID: prepared.fields.assignee.id,
      TABTIN_E2E_EXPECTED_USER_ID: prepared.candidateMember.userId,
    },
  );
  artifacts.push(...verify.artifacts);
  artifacts.push(await context.writeJson("snapshots/tabdata-member-mention-verify.json", verify.payload));
  if (!verify.payload.matched) {
    return {
      status: "failed",
      message: `tabdata.member-mention failed: persisted value ${JSON.stringify(verify.payload.actualValue)} did not match ${verify.payload.expectedUserId}.`,
      artifacts,
    } as StepResult;
  }

  await context.reportProgress("TABDATA", "reload and reopen table");
  try {
    evalRendererJson(context, reloadExpression(), { timeoutMs: 15000 });
  } catch (error) {
    await context.writeText(
      "logs/tabdata-member-mention-reload-trigger-error.log",
      error instanceof Error ? error.message : String(error),
    );
  }
  await sleep(10000);
  artifacts.push(...(await openTabDataHome(context, prepared, [prepared.table.name])).artifacts);
  const reopen = evalRendererJson<{
    opened: boolean;
    reloading?: boolean;
    reason?: string;
    bodyText: string;
  }>(context, openTableResourceExpression(prepared, prepared.table), { timeoutMs: 70000 });
  artifacts.push(await context.writeJson("snapshots/tabdata-member-mention-reopen-table.json", reopen));
  if (!reopen.opened) {
    if (reopen.reloading) {
      const opened = await waitForTableViewOpen(
        context,
        prepared.table.name,
        "snapshots/tabdata-member-mention-reopen-table-ready.json",
      );
      artifacts.push(opened.artifact);
    } else {
    return {
      status: "failed",
      message: reopen.reason ?? "tabdata.member-mention failed: could not reopen table after reload.",
      artifacts,
    } as StepResult;
    }
  }

  return {
    status: "passed",
    message: "tabdata.member-mention passed: @ input showed member candidate, selection persisted, and table reopened after reload.",
    artifacts,
  } as StepResult;
}

async function runSelectOptionManagement(
  context: RunContext,
  prepared: TabDataFirstFivePreparation,
): Promise<StepResult> {
  const artifacts: string[] = [];
  await context.reportProgress("TABDATA", "prepare select-option fixture");
  const preparedCase = await runDjango<SelectOptionManagementPreparePayload>(
    context,
    prepared,
    "SELECT-OPTION-MANAGEMENT-PREPARE",
    "select-option-management-prepare",
  );
  artifacts.push(...preparedCase.artifacts);
  const payload = preparedCase.payload;
  artifacts.push(await context.writeJson("snapshots/select-option-management-prepared.json", payload));
  await context.reportProgress("TABDATA", "open TabData home");
  artifacts.push(...(await openTabDataHome(context, prepared, [payload.table.name])).artifacts);

  await context.reportProgress("TABDATA", `open table ${payload.table.name}`);
  const openResource = evalRendererJson<{
    opened: boolean;
    reloading?: boolean;
    reason?: string;
    bodyText: string;
  }>(context, openTableResourceExpression(prepared, payload.table), { timeoutMs: 70000 });
  artifacts.push(await context.writeJson("snapshots/select-option-management-open-table.json", openResource));
  if (!openResource.opened) {
    if (openResource.reloading) {
      const opened = await waitForTableViewOpen(
        context,
        payload.table.name,
        "snapshots/select-option-management-open-table-ready.json",
      );
      artifacts.push(opened.artifact);
    } else {
    return {
      status: "failed",
      message: openResource.reason ?? "SELECT-OPTION-MANAGEMENT failed: could not open prepared TabData table.",
      artifacts,
    } as StepResult;
    }
  }

  await context.reportProgress("TABDATA", "open status field panel");
  const openPanel = evalRendererJson<{
    opened: boolean;
    reason?: string;
    bodyText: string;
    inputs?: Array<{ value: string; placeholder: string }>;
    field?: { id: string; name: string; options?: Record<string, unknown> };
  }>(context, openSelectFieldPanelExpression(payload), { timeoutMs: 70000 });
  artifacts.push(await context.writeJson("snapshots/select-option-management-open-field-panel.json", openPanel));
  if (!openPanel.opened) {
    return {
      status: "failed",
      message: openPanel.reason ?? "SELECT-OPTION-MANAGEMENT failed: could not open select field settings panel.",
      artifacts,
    } as StepResult;
  }

  await context.reportProgress("TABDATA", "rename option in UI");
  const renameEvidence = evalRendererJson<{
    saved: boolean;
    reason?: string;
    field?: { id: string; name: string; options?: Record<string, unknown> } | null;
    drawerStillOpen?: boolean;
    visibleInputs?: Array<{ value: string; placeholder: string }>;
    bodyText: string;
  }>(context, renameSelectChoiceAndSaveExpression(payload, "进行中", "处理中"), { timeoutMs: 70000 });
  artifacts.push(await context.writeJson("snapshots/select-option-management-ui-rename.json", renameEvidence));

  if (!renameEvidence.saved) {
    return {
      status: "failed",
      message: renameEvidence.reason ?? "SELECT-OPTION-MANAGEMENT failed: UI rename action did not save.",
      artifacts,
    } as StepResult;
  }

  await context.reportProgress("TABDATA", "verify renamed records");
  const verify = await runDjango<SelectOptionManagementRenameVerification>(
    context,
    prepared,
    "SELECT-OPTION-MANAGEMENT-VERIFY-RENAME",
    "select-option-management-verify-rename",
    {
      TABTIN_E2E_TABLE_ID: payload.table.id,
      TABTIN_E2E_FIELD_ID: payload.field.id,
      TABTIN_E2E_USED_RECORD_IDS: JSON.stringify(payload.records.usedRecordIds),
      TABTIN_E2E_CONTROL_RECORD_ID: payload.records.controlRecordId,
      TABTIN_E2E_EXPECTED_LABEL: "处理中",
      TABTIN_E2E_EXPECTED_CONTROL_LABEL: "待处理",
    },
  );
  artifacts.push(...verify.artifacts);
  artifacts.push(await context.writeJson("snapshots/select-option-management-verify-rename.json", verify.payload));
  await context.reportProgress("TABDATA", "evaluate assertions");

  const fieldChoices = verify.payload.field.choices.map((choice) => {
    if (typeof choice === "string") return choice;
    if (choice && typeof choice === "object") {
      const record = choice as Record<string, unknown>;
      const label = record.label ?? record.value;
      if (typeof label === "string") return label;
    }
    return JSON.stringify(choice);
  });
  const issues: string[] = [];
  if (!fieldChoices.includes("处理中")) {
    issues.push(`字段选项列表没有保存新名称“处理中”，实际为 ${fieldChoices.join(", ")}。`);
  }
  if (fieldChoices.includes("进行中")) {
    issues.push("字段选项列表仍包含旧名称“进行中”。");
  }
  if (!verify.payload.renameUsedOption.allRecordsMigrated) {
    issues.push(
      `重命名已用选项后，已有记录未同步变为“处理中”，实际值为 ${verify.payload.renameUsedOption.recordValuesAfterRename.join(", ")}。`,
    );
  }
  if (!verify.payload.renameUsedOption.controlRecordUnchanged) {
    issues.push(
      `未使用旧选项的对照记录不应变化，实际值为 ${verify.payload.renameUsedOption.controlRecordValueAfterRename ?? "null"}。`,
    );
  }

  return {
    status: issues.length > 0 ? "failed" : "passed",
    message: issues.length > 0
      ? `SELECT-OPTION-MANAGEMENT failed: ${issues.join(" ")}`
      : "SELECT-OPTION-MANAGEMENT passed: CDP-driven option rename propagated to records that already used the option.",
    artifacts,
  } as StepResult;
}

export async function runTabDataFirstFiveCase(
  context: RunContext,
  caseId: TabDataCaseId,
): Promise<StepResult> {
  const prepared = requireTabDataPreparation(context);
  switch (caseId) {
    case "MDL-NEW-001":
      return runMdlNew001(context, prepared);
    case "MDL-NEW-002":
      return runMdlNew002(context, prepared);
    case "MDL-PLN-001":
      return runMdlPln001(context, prepared);
    case "MDL-PLN-002":
      return runMdlPln002(context, prepared);
    case "MDL-REL-001":
      return runMdlRel001(context, prepared);
    case "SELECT-OPTION-MANAGEMENT":
      return runSelectOptionManagement(context, prepared);
    default:
      throw new Error(`Unsupported TabData first-five case: ${caseId satisfies never}`);
  }
}
