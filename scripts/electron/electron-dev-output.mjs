export const ELECTRON_READY_MARKER = '[tabtin-community] electron-ready';

const FATAL_OUTPUT_PATTERN =
  /(?:Build failed|ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)|Could not resolve|failed to resolve import)/i;
const OUTPUT_BUFFER_LIMIT = 16_384;

export function createElectronDevOutputMonitor(emit) {
  let settled = false;
  let buffer = '';

  return {
    inspect(chunk) {
      if (settled) return;
      buffer = `${buffer}${chunk.toString('utf8')}`.slice(-OUTPUT_BUFFER_LIMIT);

      if (buffer.includes(ELECTRON_READY_MARKER)) {
        settled = true;
        emit({ type: 'tabtin-community-ready' });
        return;
      }

      if (FATAL_OUTPUT_PATTERN.test(buffer)) {
        settled = true;
        emit({
          type: 'tabtin-community-fatal',
          summary: 'Electron 构建或模块解析失败，请查看上方日志。',
        });
      }
    },
  };
}
