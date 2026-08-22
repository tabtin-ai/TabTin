import { describe, expect, it } from "vitest";
import { CloseCode, CollabStatus } from "../types.js";
import {
  resolveCollabSyncMode,
  shouldConsumeLegacyDomainDelta,
} from "../syncMode.js";

describe("resolveCollabSyncMode", () => {
  it("uses collab mode when provider is available and no fallback is required", () => {
    expect(
      resolveCollabSyncMode({
        providerConfigured: true,
        status: CollabStatus.SYNCED,
      }),
    ).toEqual({ mode: "collab" });
  });

  it("uses resource-level legacy mode for disabled or unavailable collab", () => {
    expect(
      resolveCollabSyncMode({
        collabDisabled: true,
        providerConfigured: true,
        status: CollabStatus.SYNCED,
      }),
    ).toEqual({ mode: "legacy", reason: "flag_disabled" });

    expect(
      resolveCollabSyncMode({
        providerConfigured: false,
        status: CollabStatus.INITIAL,
      }),
    ).toEqual({ mode: "legacy", reason: "collab_unavailable" });
  });

  it("uses legacy mode when shard/subdoc support is required but unavailable", () => {
    expect(
      resolveCollabSyncMode({
        providerConfigured: true,
        status: CollabStatus.SYNCED,
        shardingRequired: true,
        shardingAvailable: false,
      }),
    ).toEqual({ mode: "legacy", reason: "sharding_unavailable" });
  });

  it("uses legacy mode for force-close legacy fallback and runtime timeout", () => {
    expect(
      resolveCollabSyncMode({
        providerConfigured: true,
        status: CollabStatus.FORCE_CLOSED,
        forceCloseCode: CloseCode.DOCUMENT_TOO_LARGE,
      }),
    ).toEqual({ mode: "legacy", reason: "force_closed" });

    expect(
      resolveCollabSyncMode({
        providerConfigured: true,
        status: CollabStatus.DISCONNECTED,
        disconnectTimedOut: true,
      }),
    ).toEqual({ mode: "legacy", reason: "runtime_fallback" });
  });

  it("honors forcedLegacyReason for field visibility rest_projection ", () => {
    expect(
      resolveCollabSyncMode({
        forcedLegacyReason: "field_visibility_restricted",
        providerConfigured: true,
        status: CollabStatus.SYNCED,
      }),
    ).toEqual({ mode: "legacy", reason: "field_visibility_restricted" });
  });

  it("classifies 4403 as a permanent permission state instead of reconnectable network failure", () => {
    expect(
      resolveCollabSyncMode({
        providerConfigured: true,
        status: CollabStatus.FORCE_CLOSED,
        forceCloseCode: CloseCode.PERMISSION_DENIED,
      }),
    ).toEqual({ mode: "legacy", reason: "permission_denied" });
  });
});

describe("shouldConsumeLegacyDomainDelta", () => {
  it("never consumes domain deltas in collab mode", () => {
    expect(
      shouldConsumeLegacyDomainDelta({
        syncMode: "collab",
        eventKind: "domain",
      }),
    ).toBe(false);
  });

  it("consumes domain deltas only in legacy mode", () => {
    expect(
      shouldConsumeLegacyDomainDelta({
        syncMode: "legacy",
        eventKind: "domain",
      }),
    ).toBe(true);
  });

  it("does not classify control or metadata events as legacy domain deltas", () => {
    expect(
      shouldConsumeLegacyDomainDelta({
        syncMode: "legacy",
        eventKind: "control",
      }),
    ).toBe(false);
    expect(
      shouldConsumeLegacyDomainDelta({
        syncMode: "legacy",
        eventKind: "metadata",
      }),
    ).toBe(false);
  });
});
