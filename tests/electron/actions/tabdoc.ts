import type { RunContext, StepResult } from "../runner/types";
import { CommandExecutionError, runCommand } from "../runner/process";
import type { TabDocBasicEditPreparation } from "../fixtures/prepare-tabdoc-basic-edit";

function requireTabDocPreparation(context: RunContext): TabDocBasicEditPreparation {
  const data = context.preparedData;
  if (
    typeof data.docId !== "string" ||
    typeof data.spaceId !== "string" ||
    typeof data.title !== "string" ||
    typeof data.editMarkdown !== "string"
  ) {
    throw new Error("tabdoc.basic-edit requires prepared docId, spaceId, title and editMarkdown.");
  }
  return data as unknown as TabDocBasicEditPreparation;
}

export async function runTabDocBasicEditProbe(context: RunContext): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const prepared = requireTabDocPreparation(context);
  let logPath = "";
  try {
    const result = runCommand(
      "node",
      [
        "scripts/tabdoc-probe-drive.mjs",
        "e2e",
        "--doc",
        prepared.docId,
        "--space",
        prepared.spaceId,
        "--title",
        prepared.title,
        "--markdown",
        prepared.editMarkdown,
      ],
      {
        cwd: context.repoRoot,
        timeoutMs: 90000,
      },
    );
    logPath = await context.writeText("logs/tabdoc-probe-drive.log", result.stdout);
  } catch (error) {
    if (error instanceof CommandExecutionError) {
      await context.writeText("logs/tabdoc-probe-drive.log", error.stdout);
      await context.writeText("logs/tabdoc-probe-drive.stderr.log", error.stderr);
    }
    throw error;
  }

  return {
    id: "tabdoc.edit-and-save-through-probe",
    title: "通过真实 Electron TabDoc probe 编辑并保存",
    status: "passed",
    startedAt,
    endedAt: new Date().toISOString(),
    message: "TabDoc edit/save dataflow passed through Electron probe.",
    artifacts: [logPath],
  };
}
