import type {
  BaselineSnapshot,
  RunContext,
  ScenarioDefinition,
  ScenarioStep,
  StepResult,
} from "./types";

export function scenario(definition: ScenarioDefinition): ScenarioDefinition {
  return definition;
}

export function plannedStep(id: string, title: string, message: string): ScenarioStep {
  return {
    id,
    title,
    run: async () => {
      const now = new Date().toISOString();
      return {
        id,
        title,
        status: "skipped",
        startedAt: now,
        endedAt: now,
        message,
      };
    },
  };
}

export function executableStep(
  id: string,
  title: string,
  run: (context: RunContext) => Promise<Omit<StepResult, "id" | "title" | "startedAt" | "endedAt">>
): ScenarioStep {
  return {
    id,
    title,
    run: async (context) => {
      const startedAt = new Date().toISOString();
      const result = await run(context);
      const endedAt = new Date().toISOString();
      return {
        id,
        title,
        startedAt,
        endedAt,
        ...result,
      };
    },
  };
}

export function metadataBaseline(
  definition: ScenarioDefinition,
  context: RunContext,
  data: Record<string, unknown>
): BaselineSnapshot {
  return {
    schemaVersion: 1,
    scenarioId: definition.id,
    title: definition.title,
    automationStatus: definition.automationStatus,
    profiles: definition.profiles,
    tags: definition.tags,
    sourceCapability: definition.sourceCapability,
    data,
  };
}
