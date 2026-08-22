import Foundation

#if DEBUGSWIFT_ENABLED
import DebugSwift
#endif

/// DebugSwift 集成（移植自旧 `apps/tabtin-ios` 同名 `DebugTools`）。
///
/// 仅在 `DEBUGSWIFT_ENABLED` 编译条件下启动：悬浮球面板提供网络抓包 / 性能 / 日志 / 沙盒浏览等开发期工具。
/// Debug 与 Release 配置均启用；是否默认连开发环境只由 `DEBUG` 编译条件决定。
enum DebugTools {
    #if DEBUGSWIFT_ENABLED
    @MainActor private static let debugSwift = DebugSwift()
    /// DebugSwift 的 `hide()` 会惰性初始化它自己的 WindowManager。应用启动期在
    /// `show()` 之前直接调用会重入 `dispatch_once` 并触发 SIGTRAP，因此只允许隐藏
    /// 已经真正展示过的悬浮窗。
    @MainActor private static var hasShownFloatingWindow = false
    #endif

    /// 启动悬浮调试面板。在 `@main` App.init 调一次。
    @MainActor
    static func start() {
        #if DEBUGSWIFT_ENABLED
        debugSwift.setup()
        if DebugEnvironmentStore.isDebugSwiftVisible {
            showFloatingWindow()
        }
        #endif
    }

    @MainActor
    static func setFloatingWindowVisible(_ visible: Bool) {
        #if DEBUGSWIFT_ENABLED
        if visible {
            showFloatingWindow()
        } else if hasShownFloatingWindow {
            debugSwift.hide()
        }
        #endif
    }

    #if DEBUGSWIFT_ENABLED
    @MainActor
    private static func showFloatingWindow() {
        hasShownFloatingWindow = true
        debugSwift.show()
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(150))
            debugSwift.show()
        }
    }
    #endif

    /// 给 URLSession 配置注入网络抓包（DEBUG）。各 `URLSessionConfiguration` 创建后、
    /// 建 `URLSession` 前调用，DebugSwift 面板「Network」即可看到请求/响应。
    static func instrument(_ configuration: URLSessionConfiguration) {
        #if DEBUGSWIFT_ENABLED
        DebugSwift.Network.shared.injectIntoConfiguration(configuration)
        #endif
    }
}
