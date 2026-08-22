import type { RunContext } from "../runner/types";
import { runCommand } from "../runner/process";

export type ElectronRuntimeConfig = {
  apiBaseUrl: string;
};

function isLoopbackApiBaseUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

export function readElectronRuntimeConfig(context: RunContext): ElectronRuntimeConfig {
  const expression = `
(async () => {
  const mod = await import('/src/config/api.ts');
  return JSON.stringify({
    apiBaseUrl: mod.API_CONFIG && mod.API_CONFIG.baseURL,
  });
})()
`;
  const result = runCommand("node", ["scripts/cdp-eval.mjs", expression], {
    cwd: context.repoRoot,
    timeoutMs: 60000,
  });
  const config = JSON.parse(result.stdout.trim()) as Partial<ElectronRuntimeConfig>;
  if (!config.apiBaseUrl) {
    throw new Error(`Electron runtime config is incomplete: ${JSON.stringify(config)}`);
  }
  return { apiBaseUrl: config.apiBaseUrl };
}

export function requireLocalElectronApiBaseUrl(config: ElectronRuntimeConfig): void {
  if (isLoopbackApiBaseUrl(config.apiBaseUrl)) return;
  throw new Error(
    [
      `chat.message-persistence requires Electron to target the local Django API, got ${config.apiBaseUrl}.`,
      "Restart Electron with: cd apps/tabtin-electron && pnpm dev -- --env-file ../../.env",
    ].join(" "),
  );
}
