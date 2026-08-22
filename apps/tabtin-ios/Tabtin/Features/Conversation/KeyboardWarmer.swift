import UIKit

/// 键盘预热（一次性，整进程仅生效一次）。
///
/// 首次唤起系统输入栈（`UIKeyboardImpl` 懒加载 + RTI 远程输入握手 + QuickType 预测栏初始化）有
/// 数百 ms 的**一次性**系统开销，表现为「首次点输入框卡一下」——与会话内容 / 消息数无关（空会话
/// 同样卡），真机 Release 亦然。无法消除，但可**提前**到空闲时刻付掉，让用户真实点击时已就绪。
///
/// 关键：`becomeFirstResponder()` 只是**触发**输入栈初始化，真正的初始化在随后的 runloop 里异步完成；
/// 同一 runloop 内立刻 `resignFirstResponder()` 会在初始化前就取消，等于白热。故必须**隔一拍再让出**，
/// 给系统时间真正把输入栈拉起来。代价：会有一帧左右的键盘起落（故尽量在启动/首屏阶段预热）。
@MainActor
enum KeyboardWarmer {
    private static var warmed = false

    /// 尽早调用一次（App 启动有 key window 后）。无可用 window 时不消耗 `warmed`，下次再试。
    static func warmIfNeeded() {
        guard !warmed else { return }
        guard let window = activeKeyWindow else { return }
        warmed = true
        let field = UITextField(frame: CGRect(x: 0, y: -100, width: 1, height: 1))
        field.autocorrectionType = .default
        window.addSubview(field)
        field.becomeFirstResponder()
        // 隔一拍再让出：让系统在这期间真正完成输入栈初始化（同步 become→resign 来不及，等于没热）。
        DispatchQueue.main.async {
            field.resignFirstResponder()
            field.removeFromSuperview()
        }
    }

    private static var activeKeyWindow: UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }
    }
}
