export { synthesizeSpeech } from './tts.js';
export type { SynthesizeSpeechInput, SynthesizeSpeechData } from './tts.js';

export { recognizeSpeech, submitASR, queryASR } from './asr.js';
export type {
  RecognizeSpeechInput,
  RecognizeSpeechData,
  SubmitASRInput,
} from './asr.js';

export {
  isChatAudioAttachment,
  inferAudioFormat,
  isCloudUnreachableAudioUrl,
  isFlashCompatibleAudioFormat,
  classifyChatAudioAsrFailure,
  clearChatAudioTranscriptCache,
  formatChatAudioTranscriptBody,
  formatChatAudioTranscriptFailure,
  transcribeChatAudioAttachment,
} from './transcribeChatAttachment.js';
export type {
  ChatAudioAttachment,
  TranscribeChatAudioDeps,
  TranscribeChatAudioResult,
  ChatAudioAsrFailureKind,
} from './transcribeChatAttachment.js';

export { generateMusic } from './music.js';
export type { GenerateMusicInput, GenerateMusicData } from './music.js';

export { searchSounds } from './sounds.js';
export type { SearchSoundsInput, SearchSoundsData } from './sounds.js';
