/**
 * @tabtin/media-capabilities — Unified media capability layer
 *
 * Wraps local FFmpeg / media-core helpers and cloud service capabilities
 * (Django media_generation, speech, music) into a single consumable interface.
 *
 * Usage:
 *   import { generateImage } from '@tabtin/media-capabilities/image';
 *   import { generateVideo } from '@tabtin/media-capabilities/video';
 *   import { synthesizeSpeech } from '@tabtin/media-capabilities/audio';
 *   import { withMiddleware } from '@tabtin/media-capabilities/middleware';
 *
 * Or import everything from root:
 *   import { generateImage, generateVideo } from '@tabtin/media-capabilities';
 */

// Core types
export type {
  ExecutionContext,
  DjangoResponse,
  CapabilityResult,
  Provenance,
  ProviderMetadata,
  SpecificationVersion,
  CapabilityFn,
} from './types.js';

export { CURRENT_SPECIFICATION_VERSION } from './types.js';

// Image capabilities
export {
  generateImage,
  MediaSubmitError,
  submitImage,
  upscaleImage,
  editImage,
  removeBackground,
} from './image/index.js';
export type {
  GenerateImageInput,
  GenerateImageData,
  SubmitImageData,
  UpscaleImageInput,
  UpscaleImageData,
  EditImageInput,
  EditImageData,
  RemoveBackgroundInput,
  RemoveBackgroundData,
} from './image/index.js';

// Video capabilities
export {
  generateVideo,
  reverseCapability,
  stabilizeCapability,
  denoiseCapability,
  speedRampCapability,
  freezeFrameCapability,
  gifExportCapability,
} from './video/index.js';
export type {
  GenerateVideoInput,
  GenerateVideoData,
  ReverseCapabilityInput,
  ReverseCapabilityData,
  StabilizeCapabilityInput,
  StabilizeCapabilityData,
  DenoiseCapabilityInput,
  DenoiseCapabilityData,
  SpeedRampCapabilityInput,
  SpeedRampCapabilityData,
  FreezeFrameCapabilityInput,
  FreezeFrameCapabilityData,
  GifExportCapabilityInput,
  GifExportCapabilityData,
} from './video/index.js';

// Audio capabilities (cloud + local FFmpeg helpers)
export {
  synthesizeSpeech,
  recognizeSpeech,
  submitASR,
  queryASR,
  generateMusic,
  searchSounds,
  isChatAudioAttachment,
  inferAudioFormat,
  formatChatAudioTranscriptBody,
  formatChatAudioTranscriptFailure,
  transcribeChatAudioAttachment,
  isCloudUnreachableAudioUrl,
  isFlashCompatibleAudioFormat,
  classifyChatAudioAsrFailure,
  clearChatAudioTranscriptCache,
} from './audio/index.js';
export type {
  SynthesizeSpeechInput,
  SynthesizeSpeechData,
  RecognizeSpeechInput,
  RecognizeSpeechData,
  SubmitASRInput,
  GenerateMusicInput,
  GenerateMusicData,
  SearchSoundsInput,
  SearchSoundsData,
  ChatAudioAttachment,
  TranscribeChatAudioDeps,
  TranscribeChatAudioResult,
  ChatAudioAsrFailureKind,
} from './audio/index.js';

export {
  separateAudioVideo,
  adjustVolume,
  fadeAudio,
  shiftPitch,
} from './audio/ffmpeg/index.js';
export type {
  SeparateAvInput,
  SeparateAvData,
  AdjustVolumeInput,
  AdjustVolumeData,
  AudioFadeInput,
  AudioFadeData,
  ShiftPitchInput,
  ShiftPitchData,
} from './audio/ffmpeg/index.js';

// Subtitle capabilities
export { translateSubtitle } from './subtitle/index.js';
export type {
  TranslateSubtitleInput,
  TranslateSubtitleData,
} from './subtitle/index.js';

// Middleware
export {
  withMiddleware,
  createRetryMiddleware,
  createRateLimitMiddleware,
  createBillingMiddleware,
  createAuditMiddleware,
  CapabilityError,
  DEFAULT_BILLING_CHECK_PATH,
} from './middleware/index.js';
export type {
  CapabilityMiddleware,
  RetryOptions,
  RateLimitOptions,
  BillingMiddlewareOptions,
  AuditBeginEntry,
  AuditEntry,
  AuditLogEntry,
  AuditMiddlewareOptions,
  MiddlewareMeta,
  WrapExecuteOptions,
} from './middleware/index.js';

// Infrastructure (for host runtime integration)
export { TaskManager } from './infra/task-manager.js';
export type { Task, TaskStatus, TaskProgress, TaskManagerOptions } from './infra/task-manager.js';
export { createProvenance, pollDjangoTask, toErrorMessage } from './infra/helpers.js';
export type { PollOptions, DjangoTaskResult } from './infra/helpers.js';
export { runFFmpeg, findFFmpegAsync } from './infra/ffmpeg-runner.js';
export type { FFmpegRunOptions, FFmpegRunResult } from './infra/ffmpeg-runner.js';

// Route handlers (for CLI Server integration)
export { createVideoHandler, createMediaHandler, createAudioHandler } from './routes/index.js';
export type {
  VideoHandlerDeps,
  VideoHandlerInstance,
  MediaHandlerDeps,
  AudioHandlerDeps,
  RouteHandler,
  DjangoRequestFn,
  EventPublisher,
} from './routes/index.js';
