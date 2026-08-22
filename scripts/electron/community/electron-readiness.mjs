export function waitForElectronReady({
  child,
  timeoutMs = 600_000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timer);
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      if (error) reject(error);
      else resolve();
    };

    const onMessage = (message) => {
      if (message?.type === 'tabtin-community-ready') finish();
      if (message?.type === 'tabtin-community-fatal') {
        finish(
          new Error(message.summary || 'Electron 启动失败，请查看上方日志。'),
        );
      }
    };
    const onError = (error) => finish(error);
    const onExit = (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      finish(new Error(`Electron 在就绪前退出（${reason}）`));
    };
    const timer = setTimeoutImpl(() => {
      finish(
        new Error(
          `等待 ${Math.ceil(timeoutMs / 1_000)} 秒后 Electron 仍未就绪，请检查上方构建日志。`,
        ),
      );
    }, timeoutMs);

    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}
