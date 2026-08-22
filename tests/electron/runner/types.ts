export type ScenarioPriority = "P0" | "P1" | "P2";

export type ScenarioProfile =
  | "smoke"
  | "regression"
  | "data-seeding"
  | "external-ai"
  | "visual"
  | "p0-plus";

export type ScenarioAutomationStatus = "ready" | "planned";

export type StepStatus = "passed" | "failed" | "skipped";

export type ScenarioRunStatus = StepStatus | "expected-failed";

export type ScenarioTestLayer = "ui" | "logic" | "infrastructure";

export type ScenarioDataContract = {
  selfContained: boolean;
  setup: string[];
  externalDependencies?: string[];
};

export type ScenarioInteractionContract = {
  /** User-visible steps that must be driven by real CDP/Playwright input events. */
  requiredUserActions: string[];
  /** Setup, auth bootstrap, readonly observation, and assertions that may be automated without replacing user steps. */
  allowedAutomationHelpers: string[];
  /** Store/service/DB/localStorage/DOM-event shortcuts that must not replace user-visible steps. */
  forbiddenShortcuts: string[];
};

export type TimelineEvent = {
  ts: string;
  scenarioId: string;
  runId: string;
  event: string;
  stepId?: string;
  status?: ScenarioRunStatus;
  payload?: unknown;
};

export type StepResult = {
  id: string;
  title: string;
  status: StepStatus;
  startedAt: string;
  endedAt: string;
  message?: string;
  artifacts?: string[];
  error?: {
    message: string;
    stack?: string;
  };
};

export type RunContext = {
  repoRoot: string;
  runId: string;
  scenarioId: string;
  scenarioArtifactDir: string;
  preparedData: Record<string, unknown>;
  updateBaseline: boolean;
  writeJson: (relativePath: string, value: unknown) => Promise<string>;
  writeText: (relativePath: string, value: string) => Promise<string>;
  writeTimeline: (event: Omit<TimelineEvent, "ts" | "scenarioId" | "runId">) => Promise<void>;
  reportProgress: (phase: string, message: string) => Promise<void>;
};

export type ScenarioStep = {
  id: string;
  title: string;
  run: (context: RunContext) => Promise<StepResult> | StepResult;
};

export type BaselineSnapshot = {
  schemaVersion: 1;
  scenarioId: string;
  title: string;
  automationStatus: ScenarioAutomationStatus;
  profiles: ScenarioProfile[];
  tags: string[];
  sourceCapability: string;
  data: Record<string, unknown>;
};

export type BaselineDiff = {
  status: "missing" | "matched" | "changed" | "updated" | "not-collected";
  baselinePath?: string;
  changes?: Array<{
    path: string;
    expected: unknown;
    actual: unknown;
  }>;
};

export type ScenarioDefinition = {
  id: string;
  title: string;
  intent: string;
  caseFile?: string;
  userFlow?: string[];
  automationContract?: string[];
  testLayer: ScenarioTestLayer;
  dataContract: ScenarioDataContract;
  interactionContract?: ScenarioInteractionContract;
  priority: ScenarioPriority;
  profiles: ScenarioProfile[];
  tags: string[];
  sourceCapability: string;
  sourceCapabilityId?: string;
  automationStatus: ScenarioAutomationStatus;
  expectedFailure?: {
    reason: string;
    stepId?: string;
    messagePattern?: string;
    issue?: string;
  };
  fixtures: string[];
  steps: ScenarioStep[];
  prepare?: (context: RunContext) => Promise<Record<string, unknown>> | Record<string, unknown>;
  collectBaseline?: (context: RunContext) => Promise<BaselineSnapshot> | BaselineSnapshot;
};

export type ScenarioResult = {
  schemaVersion: 1;
  runId: string;
  scenarioId: string;
  title: string;
  priority: ScenarioPriority;
  profiles: ScenarioProfile[];
  tags: string[];
  automationStatus: ScenarioAutomationStatus;
  testLayer: ScenarioTestLayer;
  dataContract: ScenarioDataContract;
  interactionContract?: ScenarioInteractionContract;
  sourceCapability: string;
  expectedFailure?: ScenarioDefinition["expectedFailure"];
  caseFile?: string;
  userFlow?: string[];
  automationContract?: string[];
  startedAt: string;
  endedAt: string;
  status: ScenarioRunStatus;
  skippedReason?: string;
  steps: StepResult[];
  baselineDiff: BaselineDiff;
  artifactDir: string;
};
