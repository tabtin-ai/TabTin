/**
 * VersionPanel 回归测试
 * CC-003: DiffPreview 渲染
 * CC-017: 加载更多 UI
 * CC-019: 重命名版本错误提示
 * CC-1561: 列表内联命名支持空名称保存
 * CC-024: 恢复操作 loading 状态
 * CC-025: togglePin 错误捕获
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { VersionPanel } from "./VersionPanel";
import { useVersionPanel } from "./useVersionPanel";
import type { VersionAdapter } from "./types";

function makeVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: "v1",
    module: "tabdoc",
    is_snapshot: false,
    is_named: true,
    name: "初稿",
    pinned: false,
    editor_type: "user",
    editor_id: "u1",
    editor_name: "Alice",
    blob_size: 500,
    created_at: new Date().toISOString(),
    expired_at: null,
    ...overrides,
  };
}

function mockOkResponse(data: Record<string, unknown>) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as Response);
}

function mockApiErrorResponse(message: string) {
  const body = { status: "error", message };
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const mockVersions = [makeVersion()];

function getVersionItem(name = "初稿") {
  return screen.getByText(name).closest("[class*='group']");
}

function openActionsMenu(name = "初稿") {
  const versionItem = getVersionItem(name);
  if (!versionItem) {
    throw new Error(`version item not found: ${name}`);
  }
  fireEvent.click(within(versionItem).getByRole("button", { name: "操作" }));
}

describe("VersionPanel expiration time display", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("shows future expiration as time remaining instead of just now", async () => {
    const expiresInSevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    globalThis.fetch = vi.fn().mockReturnValue(
      mockOkResponse({
        status: "ok",
        data: [
          makeVersion({
            is_named: false,
            expired_at: expiresInSevenDays,
          }),
        ],
        total: 1,
      }),
    );

    const adapter: VersionAdapter = {
      resourceType: "tabdoc",
      resourceId: "doc-1",
    };

    render(
      <VersionPanel
        adapter={adapter}
        apiBase="http://localhost:6060/api/collab/v1"
        token="test-token"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('过期于 7 天后')).toBeTruthy();
    });
    expect(screen.queryByText("过期于 刚刚")).toBeNull();
  });

  it("shows default version retention footer notice", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockOkResponse({
        status: "ok",
        data: [makeVersion({ expired_at: null })],
        total: 1,
      }),
    );

    const adapter: VersionAdapter = {
      resourceType: "tabdoc",
      resourceId: "doc-1",
    };

    render(
      <VersionPanel
        adapter={adapter}
        apiBase="http://localhost:6060/api/collab/v1"
        token="test-token"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/未命名版本按套餐保留 7–90 天/)).toBeTruthy();
    });
  });

  it("keeps past creation time formatted as time ago", async () => {
    const createdFiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    globalThis.fetch = vi.fn().mockReturnValue(
      mockOkResponse({
        status: "ok",
        data: [
          makeVersion({
            created_at: createdFiveMinutesAgo,
            expired_at: null,
          }),
        ],
        total: 1,
      }),
    );

    const adapter: VersionAdapter = {
      resourceType: "tabdoc",
      resourceId: "doc-1",
    };

    render(
      <VersionPanel
        adapter={adapter}
        apiBase="http://localhost:6060/api/collab/v1"
        token="test-token"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("5 分钟前")).toBeTruthy();
    });
  });
});

describe("VersionPanel pinned ordering", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders pinned versions before newer unpinned versions", async () => {
    const now = Date.now();
    const newerUnpinned = makeVersion({
      id: "v-new",
      name: "较新的普通版本",
      pinned: false,
      created_at: new Date(now - 5 * 60 * 1000).toISOString(),
    });
    const olderPinned = makeVersion({
      id: "v-pinned",
      name: "较旧的置顶版本",
      pinned: true,
      created_at: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    });

    globalThis.fetch = vi.fn().mockReturnValue(
      mockOkResponse({
        status: "ok",
        data: [newerUnpinned, olderPinned],
        total: 2,
      }),
    );

    const adapter: VersionAdapter = {
      resourceType: "tabdoc",
      resourceId: "doc-1",
    };

    render(
      <VersionPanel
        adapter={adapter}
        apiBase="http://localhost:6060/api/collab/v1"
        token="test-token"
      />,
    );

    const pinnedVersion = await screen.findByText("较旧的置顶版本");
    const unpinnedVersion = screen.getByText("较新的普通版本");
    const pinnedSection = screen.getByText("置顶");
    const todaySection = screen.getByText("今天");

    expect(
      pinnedVersion.compareDocumentPosition(unpinnedVersion) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      pinnedSection.compareDocumentPosition(todaySection) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("CC-003: VersionPanel DiffPreview rendering", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockOkResponse({ status: "ok", data: mockVersions, total: 1 }),
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should render DiffPreview when a version is clicked and adapter provides DiffPreview", async () => {
    const DiffPreview = ({ versionId }: { versionId: string }) => (
      <div data-testid="diff-preview">Preview for {versionId}</div>
    );

    const adapter: VersionAdapter = {
      resourceType: "tabdoc",
      resourceId: "doc-1",
      DiffPreview,
    };

    render(
      <VersionPanel
        adapter={adapter}
        apiBase="http://localhost:6060/api/collab/v1"
        token="test-token"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("初稿")).toBeTruthy();
    });

    const versionItem = screen.getByText("初稿").closest("[class*='group']");
    if (versionItem) {
      fireEvent.click(versionItem);
    }

    await waitFor(() => {
      expect(screen.getByTestId("diff-preview")).toBeTruthy();
      expect(screen.getByText("Preview for v1")).toBeTruthy();
    });
  });

  it("should not render DiffPreview section when adapter has no DiffPreview", async () => {
    const adapter: VersionAdapter = {
      resourceType: "tabdoc",
      resourceId: "doc-1",
    };

    render(
      <VersionPanel
        adapter={adapter}
        apiBase="http://localhost:6060/api/collab/v1"
        token="test-token"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("初稿")).toBeTruthy();
    });

    expect(screen.queryByText("版本预览")).toBeNull();
  });

  it("should hide DiffPreview when close button is clicked", async () => {
    const DiffPreview = ({ versionId }: { versionId: string }) => (
      <div data-testid="diff-preview">Preview for {versionId}</div>
    );

    const adapter: VersionAdapter = {
      resourceType: "tabdoc",
      resourceId: "doc-1",
      DiffPreview,
    };

    render(
      <VersionPanel
        adapter={adapter}
        apiBase="http://localhost:6060/api/collab/v1"
        token="test-token"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("初稿")).toBeTruthy();
    });

    const versionItem = getVersionItem();
    if (versionItem) {
      fireEvent.click(versionItem);
    }

    await waitFor(() => {
      expect(screen.getByTestId("diff-preview")).toBeTruthy();
    });

    const previewHeader = screen.getByText("版本预览").closest("div");
    const closeButton = previewHeader?.querySelector("button");
    expect(closeButton).toBeTruthy();
    fireEvent.click(closeButton as HTMLButtonElement);

    await waitFor(() => {
      expect(screen.queryByTestId("diff-preview")).toBeNull();
    });
  });

  it("should select the version when view conversation is clicked", async () => {
    const DiffPreview = ({ versionId }: { versionId: string }) => (
      <div data-testid="diff-preview">Preview for {versionId}</div>
    );
    const onViewConversation = vi.fn();
    const agentVersion = makeVersion({
      id: "v-agent",
      name: "AI 修改",
      editor_type: "agent",
      agent_run_id: "run-1",
      checkpoint_context: {
        session_id: "session-1",
        user_message_id: "user-msg-1",
        assistant_message_id: "assistant-msg-1",
      },
    });
    globalThis.fetch = vi.fn().mockReturnValue(
      mockOkResponse({ status: "ok", data: [agentVersion], total: 1 }),
    );

    const adapter: VersionAdapter = {
      resourceType: "tabdoc",
      resourceId: "doc-1",
      DiffPreview,
    };

    render(
      <VersionPanel
        adapter={adapter}
        apiBase="http://localhost:6060/api/collab/v1"
        token="test-token"
        onViewConversation={onViewConversation}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("AI 修改")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "查看对话" }));

    expect(onViewConversation).toHaveBeenCalledWith("run-1", {
      sessionId: "session-1",
      messageId: "assistant-msg-1",
    });
    expect(screen.getByTestId("diff-preview")).toBeTruthy();
    expect(screen.getByText("Preview for v-agent")).toBeTruthy();
  });
});

describe("useVersionPanel view conversation behavior", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    const agentVersion = makeVersion({
      id: "v-agent",
      name: "AI 修改",
      editor_type: "agent",
      agent_run_id: "run-1",
      checkpoint_context: {
        session_id: "session-1",
        user_message_id: "user-msg-1",
        assistant_message_id: "assistant-msg-1",
      },
    });
    globalThis.fetch = vi.fn().mockReturnValue(
      mockOkResponse({ status: "ok", data: [agentVersion], total: 1 }),
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should keep the modal open and preview the selected version after view conversation", async () => {
    const onViewConversation = vi.fn();
    const DiffPreview = ({ versionId }: { versionId: string }) => (
      <div data-testid="modal-diff-preview">Preview for {versionId}</div>
    );

    function Harness() {
      const panel = useVersionPanel({
        resourceType: "tabdoc",
        resourceId: "doc-1",
        apiBase: "http://localhost:6060/api/collab/v1",
        token: "test-token",
        DiffPreview,
        onViewConversation,
      });

      return (
        <div>
          <button onClick={panel.toggle}>打开版本历史</button>
          {panel.renderPanel()}
        </div>
      );
    }

    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "打开版本历史" }));
    await waitFor(() => {
      expect(screen.getByText("AI 修改")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "查看对话" }));

    expect(onViewConversation).toHaveBeenCalledWith("run-1", {
      sessionId: "session-1",
      messageId: "assistant-msg-1",
    });
    expect(screen.getAllByText("版本历史").length).toBeGreaterThan(0);
    expect(screen.getByTestId("modal-diff-preview")).toBeTruthy();
    expect(screen.getByText("Preview for v-agent")).toBeTruthy();
  });
});

describe("useVersionPanel restore selection behavior", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should enable footer restore after selecting a version and restore that version", async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body as string | undefined });
      if (url.includes("/restore")) {
        return mockOkResponse({ status: "ok", data: { sync_mode: "resync" } });
      }
      return mockOkResponse({ status: "ok", data: mockVersions, total: 1 });
    });

    const DiffPreview = ({ versionId }: { versionId: string }) => (
      <div data-testid="modal-diff-preview">Preview for {versionId}</div>
    );

    function Harness() {
      const panel = useVersionPanel({
        resourceType: "tabdoc",
        resourceId: "doc-1",
        apiBase: "http://localhost:6060/api/collab/v1",
        token: "test-token",
        DiffPreview,
      });

      return (
        <div>
          <button onClick={panel.toggle}>打开版本历史</button>
          {panel.renderPanel()}
        </div>
      );
    }

    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "打开版本历史" }));
    await waitFor(() => {
      expect(screen.getByText("初稿")).toBeTruthy();
    });

    const footerRestoreButton = screen.getByRole("button", { name: "还原到此版本" });
    expect(footerRestoreButton).toHaveProperty("disabled", true);

    const versionItem = getVersionItem();
    expect(versionItem).toBeTruthy();
    fireEvent.click(versionItem!);

    await waitFor(() => {
      expect(screen.getByTestId("modal-diff-preview")).toBeTruthy();
    });
    expect(footerRestoreButton).toHaveProperty("disabled", false);

    fireEvent.click(versionItem!);
    expect(footerRestoreButton).toHaveProperty("disabled", true);

    fireEvent.click(versionItem!);
    await waitFor(() => {
      expect(screen.getByTestId("modal-diff-preview")).toBeTruthy();
    });
    expect(footerRestoreButton).toHaveProperty("disabled", false);

    fireEvent.click(footerRestoreButton);
    const restoreButtons = screen.getAllByRole("button", { name: "还原到此版本" });
    fireEvent.click(restoreButtons[restoreButtons.length - 1]);

    await waitFor(() => {
      expect(requests.some((req) => req.url.includes("/tabdoc/doc-1/restore"))).toBe(true);
    });
    const restoreRequest = requests.find((req) => req.url.includes("/tabdoc/doc-1/restore"));
    expect(restoreRequest?.body).toBe(JSON.stringify({ version_id: "v1" }));
  });

  it("hides all version mutation controls in readonly mode", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockOkResponse({ status: "ok", data: mockVersions, total: 1 }),
    );

    function ReadonlyHarness() {
      const panel = useVersionPanel({
        resourceType: "tabdoc",
        resourceId: "doc-1",
        apiBase: "http://localhost:6060/api/collab/v1",
        token: "test-token",
        isReadonly: true,
        DiffPreview: ({ versionId }) => <div>Preview for {versionId}</div>,
      });
      return (
        <div>
          <button onClick={panel.toggle}>打开版本历史</button>
          {panel.renderPanel()}
        </div>
      );
    }

    render(<ReadonlyHarness />);
    fireEvent.click(screen.getByRole("button", { name: "打开版本历史" }));

    await waitFor(() => {
      expect(screen.getByText("初稿")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "操作" })).toBeNull();
    expect(screen.queryByRole("button", { name: "还原到此版本" })).toBeNull();
  });
});

// ── CC-017: 加载更多 ──────────────────────────────────
describe("CC-017: Load more button", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should show load more button when total > loaded count", async () => {
    const page = Array.from({ length: 2 }, (_, i) => makeVersion({ id: `v${i}`, name: `v${i}` }));
    globalThis.fetch = vi.fn().mockReturnValue(
      mockOkResponse({ status: "ok", data: page, total: 5 }),
    );

    const adapter: VersionAdapter = { resourceType: "tabdoc", resourceId: "doc-1" };
    render(<VersionPanel adapter={adapter} apiBase="http://localhost" token="t" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "加载更多（2/5）" })).toBeTruthy();
    });
  });

  it("should not show load more when all versions loaded", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockOkResponse({ status: "ok", data: mockVersions, total: 1 }),
    );

    const adapter: VersionAdapter = { resourceType: "tabdoc", resourceId: "doc-1" };
    render(<VersionPanel adapter={adapter} apiBase="http://localhost" token="t" />);

    await waitFor(() => {
      expect(screen.getByText("初稿")).toBeTruthy();
    });
    expect(screen.queryByText(/加载更多/)).toBeNull();
  });
});

// ── CC-019: 重命名版本错误提示 ──────────────────────
describe("CC-019: Rename version error display", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should display error message when rename fails", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return mockOkResponse({ status: "ok", data: mockVersions, total: 1 });
      }
      return mockApiErrorResponse("重命名权限不足");
    });

    const adapter: VersionAdapter = { resourceType: "tabdoc", resourceId: "doc-1" };
    render(<VersionPanel adapter={adapter} apiBase="http://localhost" token="t" />);

    await waitFor(() => expect(screen.getByText("初稿")).toBeTruthy());

    openActionsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "命名此版本" }));

    const versionItem = screen.getByDisplayValue("初稿").closest("[class*='group']");
    expect(versionItem).toBeTruthy();
    const editInput = within(versionItem as HTMLElement).getByDisplayValue("初稿");
    fireEvent.change(editInput, { target: { value: "新名称" } });
    fireEvent.click(within(versionItem as HTMLElement).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(screen.getByText("重命名权限不足")).toBeTruthy();
    });
  });
});

// ── : 列表内联命名支持空名称保存 ──────────────────────
describe("#1561: Inline rename allows an empty name", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("keeps the list save button enabled when inline edit name is empty", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/versions/v1/name")) {
        return mockOkResponse({ status: "ok" });
      }
      return mockOkResponse({
        status: "ok",
        data: [makeVersion({ is_named: false, name: "" })],
        total: 1,
      });
    });
    globalThis.fetch = fetchMock;

    const adapter: VersionAdapter = { resourceType: "tabdoc", resourceId: "doc-1" };
    render(<VersionPanel adapter={adapter} apiBase="http://localhost" token="t" />);

    await waitFor(() => {
      expect(screen.getByLabelText("操作")).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("操作"));
    fireEvent.click(screen.getByRole("menuitem", { name: "命名此版本" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "保存" })).toHaveProperty("disabled", false);
    });

    const inlineInput = screen.getByRole("textbox");
    fireEvent.change(inlineInput, { target: { value: "我的版本" } });
    expect(screen.getByRole("button", { name: "保存" })).toHaveProperty("disabled", false);

    fireEvent.change(inlineInput, { target: { value: "   " } });
    const saveButton = screen.getByRole("button", { name: "保存" });
    expect(saveButton).toHaveProperty("disabled", false);
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost/tabdoc/doc-1/versions/v1/name",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ name: "" }),
        }),
      );
    });
  });

  it("saves an empty name after clearing an existing version name", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/versions/v1/name")) {
        return mockOkResponse({ status: "ok" });
      }
      return mockOkResponse({ status: "ok", data: mockVersions, total: 1 });
    });
    globalThis.fetch = fetchMock;

    const adapter: VersionAdapter = { resourceType: "tabdoc", resourceId: "doc-1" };
    render(<VersionPanel adapter={adapter} apiBase="http://localhost" token="t" />);

    await waitFor(() => expect(screen.getByText("初稿")).toBeTruthy());

    openActionsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "命名此版本" }));

    const versionItem = screen.getByDisplayValue("初稿").closest("[class*='group']") as HTMLElement;
    const saveBtn = within(versionItem).getByRole("button", { name: "保存" });
    expect(saveBtn).toHaveProperty("disabled", false);

    const editInput = within(versionItem).getByDisplayValue("初稿");
    fireEvent.change(editInput, { target: { value: "" } });
    expect(saveBtn).toHaveProperty("disabled", false);
    fireEvent.keyDown(editInput, { key: "Enter" });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost/tabdoc/doc-1/versions/v1/name",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ name: "" }),
        }),
      );
    });
  });
});

// ── CC-024: 恢复操作 loading 状态 ──────────────────────
describe("CC-024: Restore loading state", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should show loading state and disable button during restore", async () => {
    let resolveRestore!: (v: any) => void;
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return mockOkResponse({ status: "ok", data: mockVersions, total: 1 });
      }
      return new Promise((resolve) => {
        resolveRestore = () =>
          resolve({
            ok: true,
            json: () => Promise.resolve({ status: "ok", data: mockVersions, total: 1 }),
            text: () => Promise.resolve(""),
          });
      });
    });

    const adapter: VersionAdapter = { resourceType: "tabdoc", resourceId: "doc-1" };
    render(<VersionPanel adapter={adapter} apiBase="http://localhost" token="t" />);

    await waitFor(() => expect(screen.getByText("初稿")).toBeTruthy());

    openActionsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "还原到此版本" }));
    fireEvent.click(screen.getByText("确认还原到此版本?"));

    await waitFor(() => {
      expect(screen.getByText("...")).toBeTruthy();
    });
    const restoreBtn = screen.getByText("...");
    expect(restoreBtn).toHaveProperty("disabled", true);

    resolveRestore(undefined);
  });
});

// ── CC-025: togglePin 错误捕获 ──────────────────────
describe("CC-025: togglePin error handling", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should display error when togglePin fails", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return mockOkResponse({ status: "ok", data: mockVersions, total: 1 });
      }
      return mockApiErrorResponse("置顶失败");
    });

    const adapter: VersionAdapter = { resourceType: "tabdoc", resourceId: "doc-1" };
    render(<VersionPanel adapter={adapter} apiBase="http://localhost" token="t" />);

    await waitFor(() => expect(screen.getByText("初稿")).toBeTruthy());

    openActionsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "置顶" }));

    await waitFor(() => {
      expect(screen.getByText("置顶失败")).toBeTruthy();
    });
  });

  it("should preserve named-only filter after togglePin refreshes versions", async () => {
    const requests: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      requests.push(url);
      if (url.includes("/pin")) {
        return mockOkResponse({ status: "ok", data: { pinned: true } });
      }
      return mockOkResponse({ status: "ok", data: mockVersions, total: 1 });
    });

    const adapter: VersionAdapter = { resourceType: "tabdoc", resourceId: "doc-1" };
    render(<VersionPanel adapter={adapter} apiBase="http://localhost" token="t" />);

    await waitFor(() => expect(screen.getByText("初稿")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "命名版本" }));
    await waitFor(() => {
      expect(requests.some((url) => url.includes("named_only=true"))).toBe(true);
    });

    openActionsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "置顶" }));

    await waitFor(() => {
      const versionFetches = requests.filter((url) => url.includes("/versions?"));
      expect(versionFetches[versionFetches.length - 1]).toContain("named_only=true");
    });
  });
});
