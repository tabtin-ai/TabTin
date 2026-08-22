import { runCommand } from "../runner/process";
import type { RunContext } from "../runner/types";

export type CdpInputResult = {
  ok?: boolean;
  action?: string;
  target?: {
    error?: string;
    bodyText?: string;
    [key: string]: unknown;
  };
  from?: {
    error?: string;
    [key: string]: unknown;
  };
  to?: {
    error?: string;
    [key: string]: unknown;
  };
  length?: number;
  combo?: string;
  deltaX?: number;
  deltaY?: number;
  steps?: number;
  delayMs?: number;
  holdMs?: number;
  nativeDrag?: boolean;
};

export type CdpClickOptions = {
  timeoutMs?: number;
  targetLabel?: string;
  page?: "main" | "modal" | "toast" | "overlay";
};

function commandOptions(options: { timeoutMs?: number; page?: CdpClickOptions["page"] }): string | undefined {
  const payload: Record<string, unknown> = {};
  if (options.timeoutMs !== undefined) payload.timeoutMs = options.timeoutMs;
  if (options.page !== undefined) payload.page = options.page;
  return Object.keys(payload).length > 0 ? JSON.stringify(payload) : undefined;
}

function runCdpInput(
  context: RunContext,
  command: string,
  value: string,
  options: { timeoutMs?: number; page?: CdpClickOptions["page"] } = {},
): CdpInputResult {
  const args = ["scripts/cdp-input.mjs", command, value];
  const serializedOptions = commandOptions(options);
  if (serializedOptions) args.push(serializedOptions);
  const result = runCommand("node", args, {
    cwd: context.repoRoot,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  return JSON.parse(result.stdout.trim()) as CdpInputResult;
}

/**
 * Execute a real CDP mouse click at a point resolved from the renderer DOM.
 *
 * The expression must only locate and return a visible target point. It must not
 * mutate renderer state or dispatch DOM events itself. Product actions should
 * use this helper for clicks unless a scenario explicitly documents a non-UI
 * helper in its interaction contract.
 */
export async function cdpClickByExpression(
  context: RunContext,
  artifactName: string,
  expression: string,
  options: CdpClickOptions = {},
): Promise<CdpInputResult> {
  const result = runCommand("node", [
    "scripts/cdp-input.mjs",
    "click",
    expression,
    commandOptions(options) ?? "",
  ].filter(Boolean), {
    cwd: context.repoRoot,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  await context.writeText(`logs/${artifactName}.log`, result.stdout);
  const payload = JSON.parse(result.stdout.trim()) as CdpInputResult;
  if (!payload.ok || payload.target?.error) {
    throw new Error(
      `CDP real-user click failed for ${options.targetLabel ?? artifactName}: ${JSON.stringify(payload.target)}`,
    );
  }
  return payload;
}

async function cdpPointActionByExpression(
  context: RunContext,
  artifactName: string,
  command: "double-click" | "right-click" | "hover",
  expression: string,
  options: CdpClickOptions = {},
): Promise<CdpInputResult> {
  const payload = runCdpInput(context, command, expression, options);
  await context.writeText(`logs/${artifactName}.log`, JSON.stringify(payload, null, 2));
  if (!payload.ok || payload.target?.error) {
    throw new Error(
      `CDP real-user ${command} failed for ${options.targetLabel ?? artifactName}: ${JSON.stringify(payload.target)}`,
    );
  }
  return payload;
}

export function cdpDoubleClickByExpression(
  context: RunContext,
  artifactName: string,
  expression: string,
  options: CdpClickOptions = {},
): Promise<CdpInputResult> {
  return cdpPointActionByExpression(context, artifactName, "double-click", expression, options);
}

export function cdpRightClickByExpression(
  context: RunContext,
  artifactName: string,
  expression: string,
  options: CdpClickOptions = {},
): Promise<CdpInputResult> {
  return cdpPointActionByExpression(context, artifactName, "right-click", expression, options);
}

export function cdpHoverByExpression(
  context: RunContext,
  artifactName: string,
  expression: string,
  options: CdpClickOptions = {},
): Promise<CdpInputResult> {
  return cdpPointActionByExpression(context, artifactName, "hover", expression, options);
}

export type CdpTextInputOptions = {
  timeoutMs?: number;
};

/**
 * Type text into the currently focused control through CDP `Input.insertText`.
 *
 * Callers must focus the target first with `cdpClickByExpression`; inserting
 * text without an explicit preceding click does not satisfy UI interaction
 * coverage for a user-facing input step.
 */
export async function cdpInsertText(
  context: RunContext,
  artifactName: string,
  text: string,
  options: CdpTextInputOptions & Pick<CdpClickOptions, "page"> = {},
): Promise<CdpInputResult> {
  const result = runCommand("node", [
    "scripts/cdp-input.mjs",
    "insert-text",
    text,
    commandOptions(options) ?? "",
  ].filter(Boolean), {
    cwd: context.repoRoot,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  await context.writeText(`logs/${artifactName}.log`, result.stdout);
  const payload = JSON.parse(result.stdout.trim()) as CdpInputResult;
  if (!payload.ok) {
    throw new Error(`CDP real-user text input failed for ${artifactName}: ${result.stdout}`);
  }
  return payload;
}

export type CdpKeyOptions = {
  timeoutMs?: number;
  page?: CdpClickOptions["page"];
};

export async function cdpPressKey(
  context: RunContext,
  artifactName: string,
  combo: string,
  options: CdpKeyOptions = {},
): Promise<CdpInputResult> {
  const payload = runCdpInput(context, "key", combo, options);
  await context.writeText(`logs/${artifactName}.log`, JSON.stringify(payload, null, 2));
  if (!payload.ok) {
    throw new Error(`CDP real-user key failed for ${artifactName}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

export type CdpWheelOptions = {
  timeoutMs?: number;
  page?: CdpClickOptions["page"];
  targetLabel?: string;
  deltaX?: number;
  deltaY?: number;
};

export async function cdpWheelByExpression(
  context: RunContext,
  artifactName: string,
  expression: string,
  options: CdpWheelOptions = {},
): Promise<CdpInputResult> {
  const payload = runCdpInput(
    context,
    "wheel",
    JSON.stringify({
      expression,
      deltaX: options.deltaX ?? 0,
      deltaY: options.deltaY ?? 0,
      page: options.page,
      timeoutMs: options.timeoutMs,
    }),
    options,
  );
  await context.writeText(`logs/${artifactName}.log`, JSON.stringify(payload, null, 2));
  if (!payload.ok || payload.target?.error) {
    throw new Error(
      `CDP real-user wheel failed for ${options.targetLabel ?? artifactName}: ${JSON.stringify(payload.target)}`,
    );
  }
  return payload;
}

export type CdpDragOptions = {
  timeoutMs?: number;
  page?: CdpClickOptions["page"];
  targetLabel?: string;
  steps?: number;
  delayMs?: number;
  holdMs?: number;
  dragData?: {
    items: Array<{
      mimeType: string;
      data: string;
      title?: string;
      baseURL?: string;
    }>;
    dragOperationsMask?: number;
  };
};

export async function cdpDragBetweenExpressions(
  context: RunContext,
  artifactName: string,
  fromExpression: string,
  toExpression: string,
  options: CdpDragOptions = {},
): Promise<CdpInputResult> {
  const payload = runCdpInput(
    context,
    "drag",
    JSON.stringify({
      fromExpression,
      toExpression,
      steps: options.steps,
      delayMs: options.delayMs,
      holdMs: options.holdMs,
      dragData: options.dragData,
      page: options.page,
      timeoutMs: options.timeoutMs,
    }),
    options,
  );
  await context.writeText(`logs/${artifactName}.log`, JSON.stringify(payload, null, 2));
  if (!payload.ok || payload.from?.error || payload.to?.error) {
    throw new Error(
      `CDP real-user drag failed for ${options.targetLabel ?? artifactName}: ${JSON.stringify({
        from: payload.from,
        to: payload.to,
      })}`,
    );
  }
  await context.writeJson(`snapshots/${artifactName}-drag-path.json`, payload);
  return payload;
}

export type CdpFocusAndTypeOptions = CdpClickOptions & {
  clearBefore?: boolean;
  submitKey?: string;
};

export async function cdpFocusAndType(
  context: RunContext,
  artifactName: string,
  focusExpression: string,
  text: string,
  options: CdpFocusAndTypeOptions = {},
): Promise<CdpInputResult[]> {
  const results: CdpInputResult[] = [];
  results.push(await cdpClickByExpression(context, `${artifactName}-focus`, focusExpression, options));
  if (options.clearBefore) {
    results.push(await cdpPressKey(context, `${artifactName}-select-all`, "Control+A", options));
    results.push(await cdpPressKey(context, `${artifactName}-clear`, "Backspace", options));
  }
  results.push(await cdpInsertText(context, `${artifactName}-insert-text`, text, options));
  if (options.submitKey) {
    results.push(await cdpPressKey(context, `${artifactName}-submit`, options.submitKey, options));
  }
  return results;
}
