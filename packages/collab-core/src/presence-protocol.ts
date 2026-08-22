/**
 * Unified Presence Protocol for TabTin
 *
 * Standardized Awareness data structures across all collaboration modules:
 * - TabDoc, TabData, TabSlide, TabVideo, TabWhiteboard
 *
 * Each module stores its cursor/selection state in module-specific fields
 * within this shared protocol.
 */

// ================================================================
// Core Types
// ================================================================

/**
 * Standard user identity in Awareness
 */
export interface PresenceUser {
  id: string;
  name: string;
  color: string;
  avatar?: string;
  /** 'user' for humans, 'agent' for AI agents */
  type: 'user' | 'agent';
}

/**
 * Module-specific cursor/selection state (flat discriminated union).
 *
 * All modules write cursor data directly via `setAwareness('cursor', { module, ...fields, timestamp })`.
 * The `module` field serves as discriminator.
 */
export type PresenceCursor = PresenceCursorData & { timestamp?: number };

/**
 * Union of module-specific cursor data
 */
export type PresenceCursorData =
  | TabDocCursorData
  | TabDataCursorData
  | TabSlideCursorData
  | TabVideoCursorData
  | TabWhiteboardCursorData;

/** TabDoc: text editor cursor position */
export interface TabDocCursorData {
  module: 'tabdoc';
  /** Tiptap selection anchor position */
  anchor: number;
  /** Tiptap selection head position */
  head: number;
}

/** TabData: cell focus */
export interface TabDataCursorData {
  module: 'tabdata';
  /** Focused record ID */
  recordId: string | null;
  /** Focused field ID */
  fieldId: string | null;
}

/** TabSlide: page/element selection */
export interface TabSlideCursorData {
  module: 'tabslide';
  /** Current page ID */
  pageId: string | null;
  /** Selected element IDs */
  elementIds: string[];
}

/** TabVideo: timeline element selection */
export interface TabVideoCursorData {
  module: 'tabvideo';
  /** Selected timeline element IDs */
  elementIds: string[];
}

/** TabWhiteboard: cursor position + node selection */
export interface TabWhiteboardCursorData {
  module: 'tabwhiteboard';
  /** Cursor x coordinate on canvas (null = no cursor) */
  x: number | null;
  /** Cursor y coordinate on canvas (null = no cursor) */
  y: number | null;
  /** Selected node IDs */
  selectedNodes: string[];
}

/**
 * Full Awareness state for a single client
 */
export interface PresenceState {
  user: PresenceUser;
  cursor: PresenceCursor | null;
  /** Last active timestamp (for idle detection) */
  lastActive: number;
}

// ================================================================
// Space-Level Presence
// ================================================================

/**
 * Space-level presence entry — who is viewing/editing what in the space.
 *
 * Used by the sidebar to show "Alice is editing Design File X" etc.
 */
export interface SpacePresenceEntry {
  user: PresenceUser;
  /** Resource being viewed/edited */
  resource: {
    type: 'document' | 'table' | 'slide' | 'video' | 'whiteboard';
    id: string;
    name: string;
  };
  /** 'viewing' or 'editing' */
  activity: 'viewing' | 'editing';
  lastActive: number;
}

// ================================================================
// Agent Presence
// ================================================================

/**
 * Agent-specific presence fields.
 *
 * When an Agent is editing a document, its Awareness state includes
 * these additional fields so the UI can render agent-specific indicators.
 */
export interface AgentPresenceExtension {
  /** Agent task description (shown in UI) */
  taskDescription?: string;
  /** Agent progress (0-100) */
  progress?: number;
  /** Agent state */
  agentState: 'working' | 'idle' | 'error';
}

// ================================================================
// Helpers
// ================================================================

/**
 * Build a standard PresenceState from user info and cursor data.
 */
export function buildPresenceState(
  user: PresenceUser,
  cursor: PresenceCursor | null = null,
): PresenceState {
  return {
    user,
    cursor,
    lastActive: Date.now(),
  };
}

/**
 * Check if a presence state is stale (user likely disconnected).
 */
export function isPresenceStale(
  state: PresenceState,
  maxAgeMs: number = 90_000,
): boolean {
  return Date.now() - state.lastActive > maxAgeMs;
}

/**
 * Type guard: check if a cursor payload is a TabVideo selection.
 *
 * Works with the flat format actually sent via Awareness:
 * `{ module: 'tabvideo', elementIds: string[], timestamp?: number }`
 */
export function isTabVideoCursor(
  cursor: unknown,
): cursor is TabVideoCursorData & { timestamp?: number } {
  if (!cursor || typeof cursor !== 'object') return false;
  const c = cursor as Record<string, unknown>;
  return c.module === 'tabvideo' && Array.isArray(c.elementIds);
}

/**
 * Type guard: check if a cursor payload is a TabWhiteboard selection.
 */
export function isTabWhiteboardCursor(
  cursor: unknown,
): cursor is TabWhiteboardCursorData & { timestamp?: number } {
  if (!cursor || typeof cursor !== 'object') return false;
  const c = cursor as Record<string, unknown>;
  return c.module === 'tabwhiteboard' && Array.isArray(c.selectedNodes);
}

/**
 * Extract presence states from Y.js Awareness, filtering stale entries.
 */
export function extractActivePresence(
  awarenessStates: Map<number, Record<string, unknown>>,
  localClientId: number,
  maxAgeMs: number = 90_000,
): PresenceState[] {
  const result: PresenceState[] = [];

  for (const [clientId, rawState] of awarenessStates) {
    if (clientId === localClientId) continue;

    const state = rawState as unknown as PresenceState;
    if (!state?.user?.id) continue;
    if (isPresenceStale(state, maxAgeMs)) continue;

    result.push(state);
  }

  return result;
}
