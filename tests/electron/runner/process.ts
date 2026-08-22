import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export class CommandExecutionError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30000,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new CommandExecutionError(
      [
        `Command failed (${result.status}): ${command} ${args.join(" ")}`,
        result.stdout ? `stdout:\n${result.stdout}` : "",
        result.stderr ? `stderr:\n${result.stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      result.status,
      result.stdout ?? "",
      result.stderr ?? "",
    );
  }

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function resolvePythonCommand(repoRoot: string): string {
  const explicit = process.env.TABTIN_E2E_PYTHON;
  if (explicit) return explicit;

  const venvCandidates = process.platform === "win32"
    ? [
      path.join(repoRoot, "tests", "electron", ".venv", "Scripts", "python.exe"),
      path.join(repoRoot, "apps", "tabtin_django", "venv", "Scripts", "python.exe"),
    ]
    : [
      path.join(repoRoot, "tests", "electron", ".venv", "bin", "python"),
      path.join(repoRoot, "apps", "tabtin_django", "venv", "bin", "python"),
    ];

  const venvPython = venvCandidates.find((candidate) => fs.existsSync(candidate));
  if (venvPython) return venvPython;

  if (process.env.PYTHON) return process.env.PYTHON;

  throw new Error(
    [
      `Electron E2E requires a Python virtualenv with Django dependencies. Checked: ${venvCandidates.join(", ")}.`,
      "Run `pnpm e2e:python:setup` first, or set TABTIN_E2E_PYTHON to a Python executable with Django dependencies installed.",
    ].join(" "),
  );
}

export function parseJsonSentinel<T>(stdout: string, sentinel: string): T {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((item) => item.startsWith(sentinel));
  if (!line) {
    throw new Error(`Command output missing sentinel ${sentinel}`);
  }
  return JSON.parse(line.slice(sentinel.length)) as T;
}
