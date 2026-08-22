import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyCollabAccess: vi.fn(),
}));

vi.mock("../services/django-api.js", () => ({
  verifyCollabAccess: mocks.verifyCollabAccess,
}));

import { createCollabAuthHandler } from "./auth.js";

describe("table collab embedded access context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyCollabAccess.mockResolvedValue({
      authorized: true,
      user_id: "user-1",
      user_name: "Editor",
      permission: "edit",
    });
  });

  it("passes parent_document_id to Django and retains it for revalidation", async () => {
    const connection = { readOnly: false };
    const authenticate = createCollabAuthHandler("table");

    const context = await authenticate({
      documentName: "table:table-1",
      token: "jwt-token",
      connection: connection as any,
      context: {},
      requestParameters: new URLSearchParams({ parent_document_id: "doc-parent" }),
    });

    expect(mocks.verifyCollabAccess).toHaveBeenCalledWith(
      "table",
      "table-1",
      "jwt-token",
      "doc-parent",
    );
    expect(context).toMatchObject({
      resourceType: "table",
      resourceId: "table-1",
      parentDocumentId: "doc-parent",
    });
  });
});
