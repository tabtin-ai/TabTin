import type { app as electronApp } from 'electron';

type ElectronAppLike = Pick<typeof electronApp, 'whenReady' | 'exit'>;

type SmokeLog = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

export function shouldRunPackagedAuditSmoke(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.TABTIN_PACKAGED_AUDIT_SMOKE;
  return raw === '1' || raw === 'true';
}

export function installPackagedAuditSmokeExit(options: {
  app: ElectronAppLike;
  env?: NodeJS.ProcessEnv;
  log: SmokeLog;
  delayMs?: number;
}): boolean {
  const { app, env = process.env, log, delayMs = 250 } = options;
  if (!shouldRunPackagedAuditSmoke(env)) {
    return false;
  }

  void app
    .whenReady()
    .then(() => {
      log.info(
        `[packaged audit smoke] Electron ready; exiting via app.exit(0) in ${delayMs}ms`,
      );
      setTimeout(() => {
        app.exit(0);
      }, delayMs);
    })
    .catch((error) => {
      log.warn(
        '[packaged audit smoke] app.whenReady failed; exiting with code 1:',
        error,
      );
      app.exit(1);
    });

  return true;
}
