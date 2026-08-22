// TabDesktop 模块零（v2.1）· 占位 Swift 源文件
//
// 这个文件不被任何 build 命令实际编译——它的存在意义是：
// 1. 证明 Swift 源码 + 文件结构在 packages/tabtin-desktop-native/native/swift/
//    下成立，未来模块二 / 模块四的执行 Agent 启用 native 编译时，按本目录
//    结构添加真实 Swift 文件即可（不需要重新设计目录布局）；
// 2. 给即将到来的 SCContentFilter / CGEventTap / AXUIElement 实现一个"目录
//    祖先"——它们会作为 EscCGEventTap.swift / SCContentFilter.swift /
//    AXTree.swift 加在本目录下；
// 3. 让 grep `Swift` 在本仓库下首次出现 TabDesktop 用途的源代码（之前仅
//    reference/ 下有 claude-code 的 Swift），帮助未来 Agent / 工程师 onboarding。
//
// 真实编译启用步骤见 ../README.md "升级路径" 段。

import Foundation

/// 占位类。模块零阶段不导出任何 N-API 绑定，本类不会被 Node.js 端引用。
@objc public final class TabDesktopHelloWorld: NSObject {
    /// 占位入口方法。返回字符串而非 Bool，方便未来 native binding 测试时验证
    /// JS ↔ Swift 字符串透传 happy path。
    @objc public static func greet() -> String {
        return "TabDesktop native (v2.1 模块零占位 · Swift hello world)"
    }
}
