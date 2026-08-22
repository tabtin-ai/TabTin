import type { RunDocParserTask } from '@tabtin/local-docparse';

/** Application-facing worker pool contract for local document parsing. */
export interface DocParserPort {
  runTask: RunDocParserTask;
  dispose(): Promise<void>;
}
