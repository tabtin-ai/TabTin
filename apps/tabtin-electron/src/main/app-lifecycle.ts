import { app, autoUpdater as nativeAutoUpdater, session } from 'electron'

export interface AppLifecycleLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export interface AppLifecycleController {
  start: () => void
  isQuitting: () => boolean
}

export interface AppLifecycleControllerOptions {
  isDev: boolean
  systemUserAgent: string
  log: AppLifecycleLogger
  onReady: () => Promise<void> | void
  onSecondInstance: (argv: string[]) => void
  onActivate: () => void
  onBeforeQuit: () => void | Promise<void>
  onWillQuit?: () => void
  /**
   * 退出前置守卫（W2.5 T9）。
   * 在 onBeforeQuit 之前调用，让 renderer 询问用户"有未保存改动是否仍要退出"。
   * 返回 'cancel' → e.preventDefault() + 不进入 isQuitting=true，下次 ⌘Q 重新询问。
   * 返回 'continue' / undefined → 走原 onBeforeQuit + app.quit。
   *
   * 未提供时（单元测试 / 老调用方）相当于"始终 continue"，保持向后兼容。
   */
  onExitGuard?: () => Promise<'continue' | 'cancel'>
  /**
   * 托盘常驻：返回 true 时 window-all-closed 不触发 app.quit()。
   * 托盘模式下窗口只是 hide 通常不会触发该事件，这是防御性兜底（窗口被
   * 意外销毁时保持进程存活，可从托盘重建窗口）。
   */
  isTrayResident?: () => boolean
}

export function createAppLifecycleController(
  options: AppLifecycleControllerOptions,
): AppLifecycleController {
  let isQuitting = false
  let isQuittingForUpdate = false
  let started = false

  const start = () => {
    if (started) {
      return
    }
    started = true

    // autoUpdater.quitAndInstall() 会先关闭所有窗口，再触发 app.before-quit。
    // 必须在窗口 close 事件之前标记更新退出，否则 macOS 的托盘常驻策略会把
    // 更新器发起的关窗误判为普通关窗并改成 hide，阻断 Squirrel.Mac 的
    // 「关窗 → 退出 → 安装 → 重启」链路。
    //
    // 这里不直接把 isQuitting 置为 true：before-quit 仍需进入统一的异步清理，
    // 只跳过普通退出守卫，避免更新重启再次询问用户或被用户取消。
    nativeAutoUpdater.on('before-quit-for-update', () => {
      isQuittingForUpdate = true
      options.log.info('收到 before-quit-for-update，进入更新退出流程')
    })

    // 信号兜底（SIGINT / SIGTERM）。
    //
    // 重要事实：在 `electron-vite dev` + Ctrl-C 场景下，Electron 的原生信号处理会
    // 直接触发 `before-quit`，本 JS handler 通常不会被调用（实测日志里从无"收到信号"）。
    // 所以这里**不再自己起"优雅退出计时器"**——旧实现那个 SIGINT_FORCE_TIMEOUT_MS
    // 定时器既与 before-quit 的 CLEANUP_TIMEOUT_MS 重复、又因 handler 不触发而形同虚设。
    //
    // 本 handler 仅作为「信号确实到达 JS 层」场景的兜底（直接 `kill -INT/-TERM <主进程pid>`、
    // 非 electron-vite 直启、headless 等）：
    //   - 首次信号 → 转交 app.quit()，收敛到 before-quit 统一退出路径
    //     （其内部 CLEANUP_TIMEOUT_MS + finalizeQuit 提供真正生效的超时硬退兜底）；
    //   - 重复信号（用户连按 / 反复 kill）→ 立即 process.exit(1) 硬杀，不再等待。
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        if (isQuitting) {
          options.log.warn(`重复收到 ${signal}，立即强制退出`)
          process.exit(1)
        }
        options.log.info(`收到 ${signal} 信号，开始退出...`)
        app.quit()
      })
    }

    app.on('second-instance', (_event, argv) => {
      options.onSecondInstance(argv)
    })

    app.on('activate', () => {
      if (isQuitting) {
        return
      }
      // macOS 会在 app 'ready' 之前就派发 activate（dock 图标点击 / 冷启动竞态）。
      // 此时 onActivate 的建窗链路会访问只在 ready 后可用的 `screen` 模块，抛
      // "The 'screen' module can't be used before the app 'ready' event" 直接崩
      // 。ready 前的 activate 一律忽略——whenReady → onReady 会
      // 创建首个窗口，不会丢窗口。
      if (!app.isReady()) {
        options.log.warn('activate 在 app ready 前触发，已忽略（首窗由 onReady 创建）')
        return
      }
      options.onActivate()
    })

    app.on('before-quit', (e) => {
      if (isQuitting) {
        return
      }

      e.preventDefault()

      const runCleanupAndQuit = () => {
        isQuitting = true
        const CLEANUP_TIMEOUT_MS = options.isDev ? 5_000 : 10_000

        // 退出收尾。dev 与 prod 走不同路径：
        //
        // dev：业务清理（PTY 快照 / CLI Server / EventPersistence / SiteAccessMemory）在
        //   onBeforeQuit 里已全部 flush 完。剩下的是 Chromium 多进程（GPU / Renderer /
        //   Utility helper）的原生 graceful teardown——这段没有任何 JS 日志，且耗时随
        //   session 存活时长与内嵌浏览器使用量增长（长 session 可达十几秒）。electron-vite
        //   父进程通过 `ps.on('close', process.exit)` 死等 Electron 子进程被完全 reap 才退出，
        //   于是终端迟迟拿不回提示符（用户感知的"⌘Q/Ctrl-C 后卡很久"）。
        //   dev 下这段 teardown 无价值（下次 pnpm dev 全部重建），直接 app.exit(0) 硬退出跳过。
        //
        // prod：保留 app.quit() 优雅路径——auto-update 安装、will-quit 错误上报 flush 依赖它。
        const finalizeQuit = () => {
          if (options.isDev) {
            options.log.info('[exit] dev 硬退出 app.exit(0)，跳过 Chromium 原生 teardown')
            app.exit(0)
          } else {
            app.quit()
          }
        }

        // 真正生效的退出兜底：onBeforeQuit 异步清理期间 JS 事件循环仍在跑，此计时器必定触发。
        // 超时即认为清理卡死，强制 finalizeQuit（dev 硬退 / prod 放行 app.quit）。
        const timeoutId = setTimeout(() => {
          options.log.error(`before-quit 清理超时（${CLEANUP_TIMEOUT_MS}ms），强制退出`)
          finalizeQuit()
        }, CLEANUP_TIMEOUT_MS)

        Promise.resolve(options.onBeforeQuit())
          .catch((err) => {
            options.log.error('before-quit 清理异常:', err)
          })
          .finally(() => {
            clearTimeout(timeoutId)
            finalizeQuit()
          })
      }

      // W2.5 T9: 退出前置守卫；询问 renderer 有无 dirty 资源 + 等用户决策。
      // 守卫期间维持 isQuitting=false，cancel 时下次 ⌘Q 仍可重新询问。
      const guard = options.onExitGuard
      if (isQuittingForUpdate || !guard) {
        runCleanupAndQuit()
        return
      }
      guard()
        .then((choice) => {
          if (choice === 'cancel') {
            options.log.info('用户取消退出 (exit-guard=cancel)，保持运行')
            return
          }
          runCleanupAndQuit()
        })
        .catch((err) => {
          // 守卫异常：保守降级 = 继续退出（不能因为守卫挂了就不让用户退出）
          options.log.error('exit-guard 异常，降级 continue:', err)
          runCleanupAndQuit()
        })
    })

    // SC-002: 使用 prependListener 确保 IPC 注销等关键清理逻辑
    // 优先于 mainErrorReporter 等其他 will-quit handler 执行，
    // 避免其他 handler 调用 e.preventDefault() 时跳过本回调。
    app.prependListener('will-quit', () => {
      options.onWillQuit?.()
    })

    app.on('window-all-closed', () => {
      // SC-007: 退出流程已在进行中时不要重复触发 app.quit()，
      // 避免 before-quit 清理未完成时被打断
      if (isQuitting) return
      if (options.isTrayResident?.()) return
      if (process.platform !== 'darwin' || options.isDev) {
        app.quit()
      }
    })

    app.whenReady().then(async () => {
      session.defaultSession.setUserAgent(options.systemUserAgent)
      options.log.info('DefaultSession UA 设置完成:', options.systemUserAgent)
      await options.onReady()
    }).catch((err) => {
      options.log.error('应用启动失败（onReady 异常）:', err)
      app.quit()
    })
  }

  return {
    start,
    // 更新器关闭窗口时 before-quit 尚未触发；此时也必须让窗口绕过托盘隐藏和
    // window-close 守卫。普通退出仍只由 isQuitting 控制，行为不变。
    isQuitting: () => isQuitting || isQuittingForUpdate,
  }
}
