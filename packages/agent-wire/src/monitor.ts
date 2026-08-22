/**
 * Monitor wire protocol — event types and schemas for process monitoring.
 *
 * Two namespaces:
 * - agent.action.monitor.*  : Backend → Device (control commands)
 * - agent.monitor.*         : Device → Backend (stdout events, heartbeat, lifecycle)
 */

import { z } from 'zod';

// ─── Action Events (Backend → Device) ────────────────────────────────

export const MonitorActionEvents = {
  START: 'agent.action.monitor_start',
  STOP: 'agent.action.monitor_stop',
} as const;

export type MonitorActionEventType = typeof MonitorActionEvents[keyof typeof MonitorActionEvents];

// ─── Device Events (Device → Backend) ────────────────────────────────

export const MonitorDeviceEvents = {
  /** A filtered stdout line from the monitored process. */
  EVENT: 'agent.monitor.event',
  /** Periodic heartbeat (30s interval) proving the device-side monitor is alive. */
  HEARTBEAT: 'agent.monitor.heartbeat',
  /** The monitored process exited (stream ended). */
  STREAM_ENDED: 'agent.monitor.stream_ended',
  /** The monitor failed to start or crashed. */
  FAILED: 'agent.monitor.failed',
} as const;

export type MonitorDeviceEventType = typeof MonitorDeviceEvents[keyof typeof MonitorDeviceEvents];

// ─── Schemas: Backend → Device ───────────────────────────────────────

export const MonitorStartSchema = z.object({
  type: z.literal(MonitorActionEvents.START),
  monitor_id: z.string(),
  thread_id: z.string(),
  command: z.string(),
  description: z.string(),
  notify_on: z.enum(['every_line', 'on_error', 'on_pattern', 'on_build']),
  pattern: z.string().nullable().optional(),
  working_directory: z.string().nullable().optional(),
});

export type MonitorStart = z.infer<typeof MonitorStartSchema>;

export const MonitorStopSchema = z.object({
  type: z.literal(MonitorActionEvents.STOP),
  monitor_id: z.string(),
});

export type MonitorStop = z.infer<typeof MonitorStopSchema>;

// ─── Schemas: Device → Backend ───────────────────────────────────────

export const MonitorEventSchema = z.object({
  type: z.literal(MonitorDeviceEvents.EVENT),
  monitor_id: z.string(),
  line: z.string(),
  timestamp: z.number(),
  description: z.string().optional(),
});

export type MonitorEvent = z.infer<typeof MonitorEventSchema>;

export const MonitorHeartbeatSchema = z.object({
  type: z.literal(MonitorDeviceEvents.HEARTBEAT),
  monitor_id: z.string(),
  timestamp: z.number(),
});

export type MonitorHeartbeat = z.infer<typeof MonitorHeartbeatSchema>;

export const MonitorStreamEndedSchema = z.object({
  type: z.literal(MonitorDeviceEvents.STREAM_ENDED),
  monitor_id: z.string(),
  exit_code: z.number().nullable().optional(),
  last_output: z.string().optional(),
});

export type MonitorStreamEnded = z.infer<typeof MonitorStreamEndedSchema>;

export const MonitorFailedSchema = z.object({
  type: z.literal(MonitorDeviceEvents.FAILED),
  monitor_id: z.string(),
  reason: z.string(),
});

export type MonitorFailed = z.infer<typeof MonitorFailedSchema>;

/** Union of all device→backend monitor messages. */
export const MonitorDeviceMessageSchema = z.discriminatedUnion('type', [
  MonitorEventSchema,
  MonitorHeartbeatSchema,
  MonitorStreamEndedSchema,
  MonitorFailedSchema,
]);

export type MonitorDeviceMessage = z.infer<typeof MonitorDeviceMessageSchema>;
