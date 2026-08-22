import Foundation

/// WS 网关连接生命周期状态。移植自 apps/tabtin-ios（去掉被控相关分支）。
enum WSConnectionState: Equatable {
    case disconnected
    case connecting
    case authenticating
    case connected
    case reconnecting(attempt: Int)
    case authFailed
    case reconnectGaveUp
}
