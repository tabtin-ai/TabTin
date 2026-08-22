import { z } from 'zod';

// ─── Protocol Version ────────────────────────────────────────────────

export const CHANNEL_PROTOCOL_VERSION = 1 as const;

// ─── Peer & Media ────────────────────────────────────────────────────

export const channelPeerKindSchema = z.enum(['dm', 'group', 'thread']);
export type ChannelPeerKind = z.infer<typeof channelPeerKindSchema>;

export const channelMediaKindSchema = z.enum([
  'image',
  'video',
  'audio',
  'file',
  'sticker',
  'other',
]);
export type ChannelMediaKind = z.infer<typeof channelMediaKindSchema>;

export const channelMediaSchema = z
  .object({
    kind: channelMediaKindSchema,
    url: z.string().url().optional(),
    file_id: z.string().min(1).optional(),
    mime_type: z.string().min(1).optional(),
    filename: z.string().min(1).optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ChannelMedia = z.infer<typeof channelMediaSchema>;

// ─── Base Envelope ───────────────────────────────────────────────────

export const channelBaseSchema = z
  .object({
    schema_version: z.literal(CHANNEL_PROTOCOL_VERSION),
    channel: z.string().min(1),
    account_id: z.string().min(1).optional(),
    organization_id: z.string().min(1).optional(),
    identity_user_id: z.string().min(1).optional(),
    execution_agent_id: z.string().min(1).optional(),
    handling_space_id: z.string().min(1).optional(),
    space_id: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
    thread_id: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ChannelBase = z.infer<typeof channelBaseSchema>;
