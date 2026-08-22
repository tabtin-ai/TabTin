import type { RunContext } from "../runner/types";
import { runCommand } from "../runner/process";

export type ElectronSelection = {
  userId: string;
  organizationId: string;
  organizationName: string;
  spaceId: string;
  spaceName: string;
  spaceKind: string;
};

function resolveWorkspaceSpaceId(
  spaceList: {
    selectedSpaceId?: string | null;
    selectedSpaceKind?: string | null;
    selectionByOrganization?: Record<string, { selectedSpaceId?: string; selectedSpaceKind?: string }>;
  },
  organizationId: string | null,
): { spaceId: string; spaceKind: string } {
  const selectedSpaceId = spaceList.selectedSpaceId || "";
  const selectedSpaceKind = spaceList.selectedSpaceKind || "";
  if (selectedSpaceId && !selectedSpaceId.startsWith("dm:") && selectedSpaceKind !== "dm") {
    return { spaceId: selectedSpaceId, spaceKind: selectedSpaceKind || "workspace" };
  }

  if (organizationId) {
    const perOrganization = spaceList.selectionByOrganization?.[organizationId];
    if (
      perOrganization?.selectedSpaceId &&
      !String(perOrganization.selectedSpaceId).startsWith("dm:") &&
      perOrganization.selectedSpaceKind !== "dm"
    ) {
      return {
        spaceId: perOrganization.selectedSpaceId,
        spaceKind: perOrganization.selectedSpaceKind || "workspace",
      };
    }
  }

  throw new Error(
    "Electron selection requires a workspace Space (not dm:). Open a personal/team Space before running chat.message-persistence.",
  );
}

export function readElectronSelection(context: RunContext): ElectronSelection {
  const expression = `
(async () => {
  const auth = await window.tabtin.auth.get();
  const spaceList = JSON.parse(localStorage.getItem('tabtin-space-list') || '{}').state || {};
  const organizationStore = JSON.parse(localStorage.getItem('tabtin-organization-store') || '{}').state || {};
  const organization = organizationStore.selectedOrganization || {};
  return JSON.stringify({
    userId: auth && auth.userInfo && auth.userInfo.id,
    organizationId: organization.id || null,
    organizationName: organization.name || '[e2e] mirrored organization',
    spaceList,
  });
})()
`;
  const result = runCommand("node", ["scripts/cdp-eval.mjs", expression], {
    cwd: context.repoRoot,
    timeoutMs: 60000,
  });
  const payload = JSON.parse(result.stdout.trim()) as {
    userId?: string;
    organizationId?: string;
    organizationName?: string;
    spaceList?: {
      selectedSpaceId?: string | null;
      selectedSpaceKind?: string | null;
      selectionByOrganization?: Record<string, { selectedSpaceId?: string; selectedSpaceKind?: string }>;
    };
  };
  if (!payload.userId || !payload.organizationId) {
    throw new Error(
      `Electron selection is incomplete: ${JSON.stringify({
        hasUserId: Boolean(payload.userId),
        hasOrganizationId: Boolean(payload.organizationId),
      })}`,
    );
  }
  const resolvedSpace = resolveWorkspaceSpaceId(payload.spaceList ?? {}, payload.organizationId);
  return {
    userId: payload.userId,
    organizationId: payload.organizationId,
    organizationName: payload.organizationName || "[e2e] mirrored organization",
    spaceId: resolvedSpace.spaceId,
    spaceName: "[e2e] mirrored selected Space",
    spaceKind: resolvedSpace.spaceKind,
  };
}
