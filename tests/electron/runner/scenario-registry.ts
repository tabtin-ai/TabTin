import agentControlledCommand from "../scenarios/agent-controlled-command.scenario";
import chatMessagePersistence from "../scenarios/chat-message-persistence.scenario";
import chatViewportAnchorPreservation from "../scenarios/chat-viewport-anchor-preservation.scenario";
import chatViewportTurnEnd from "../scenarios/chat-viewport-turn-end.scenario";
import evidenceBaselineSelfcheck from "../scenarios/evidence-baseline-selfcheck.scenario";
import fileSharedVisibleToMember from "../scenarios/file-shared-visible-to-member.scenario";
import tabdataBasicRecord from "../scenarios/tabdata-basic-record.scenario";
import tabdataHierarchyParentFieldSwitch from "../scenarios/tabdata-hierarchy-parent-field-switch.scenario";
import tabdataMdlNew001 from "../scenarios/tabdata-mdl-new-001.scenario";
import tabdataMdlNew002 from "../scenarios/tabdata-mdl-new-002.scenario";
import tabdataMdlPln001 from "../scenarios/tabdata-mdl-pln-001.scenario";
import tabdataMdlPln002 from "../scenarios/tabdata-mdl-pln-002.scenario";
import tabdataMdlRel001 from "../scenarios/tabdata-mdl-rel-001.scenario";
import tabdataMemberMention from "../scenarios/tabdata-member-mention.scenario";
import tabdataEmbeddedCollabParentPermission from "../scenarios/tabdata-embedded-collab-parent-permission.scenario";
import tabdataSelectOptionManagement from "../scenarios/tabdata-select-option-management.scenario";
import tabdocBasicEdit from "../scenarios/tabdoc-basic-edit.scenario";
import tabdocCommentMentionMember from "../scenarios/tabdoc-comment-mention-member.scenario";
import tabdocTabSwitchPreservesContent from "../scenarios/tabdoc-tab-switch-preserves-content.scenario";
import workspaceBasic from "../scenarios/workspace-basic.scenario";
import fileDragMoveBetweenFolders from "../scenarios/file-drag-move-between-folders.scenario";
import tabdocLongTitleWrap from "../scenarios/tabdoc-long-title-wrap.scenario";
import cloudDriveTrashSyncCloudDocs from "../scenarios/cloud-drive-trash-sync-cloud-docs.scenario";
import tabchatExternalContactLifecycle from "../scenarios/tabchat-external-contact-lifecycle.scenario";
import type { ScenarioDefinition, ScenarioProfile } from "./types";

export const scenarios: ScenarioDefinition[] = [
  workspaceBasic,
  chatMessagePersistence,
  chatViewportAnchorPreservation,
  chatViewportTurnEnd,
  agentControlledCommand,
  tabdocBasicEdit,
  tabdocCommentMentionMember,
  tabdocTabSwitchPreservesContent,
  tabdataBasicRecord,
  tabdataHierarchyParentFieldSwitch,
  tabdataMdlNew001,
  tabdataMdlNew002,
  tabdataMdlPln001,
  tabdataMdlPln002,
  tabdataMdlRel001,
  tabdataMemberMention,
  tabdataEmbeddedCollabParentPermission,
  tabdataSelectOptionManagement,
  fileSharedVisibleToMember,
  fileDragMoveBetweenFolders,
  tabdocLongTitleWrap,
  cloudDriveTrashSyncCloudDocs,
  tabchatExternalContactLifecycle,
  evidenceBaselineSelfcheck,
];

export function findScenario(id: string): ScenarioDefinition | undefined {
  return scenarios.find((scenario) => scenario.id === id);
}

export function selectScenarios(filters: {
  profile?: ScenarioProfile;
  tag?: string;
  scenarioId?: string;
}): ScenarioDefinition[] {
  return scenarios.filter((scenario) => {
    if (filters.scenarioId && scenario.id !== filters.scenarioId) return false;
    if (filters.profile && !scenario.profiles.includes(filters.profile)) return false;
    if (filters.tag && !scenario.tags.includes(filters.tag)) return false;
    return true;
  });
}

export function assertUniqueScenarioIds(): void {
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    if (seen.has(scenario.id)) {
      throw new Error(`Duplicate Electron E2E scenario id: ${scenario.id}`);
    }
    seen.add(scenario.id);
  }
}

export function assertScenarioContracts(): void {
  for (const scenario of scenarios) {
    if (scenario.automationStatus !== "ready") continue;
    if (scenario.expectedFailure && (!scenario.expectedFailure.stepId || !scenario.expectedFailure.messagePattern)) {
      throw new Error(`Ready Electron E2E expected failure must be scoped by stepId and messagePattern: ${scenario.id}`);
    }
    if (!scenario.dataContract.selfContained) {
      throw new Error(`Ready Electron E2E scenario must be self-contained: ${scenario.id}`);
    }
    if (scenario.testLayer !== "ui") continue;
    const contract = scenario.interactionContract;
    if (!contract || contract.requiredUserActions.length === 0) {
      throw new Error(`Ready UI Electron E2E scenario must declare required user actions: ${scenario.id}`);
    }
    if (contract.forbiddenShortcuts.length === 0) {
      throw new Error(`Ready UI Electron E2E scenario must declare forbidden shortcuts: ${scenario.id}`);
    }
  }
}
