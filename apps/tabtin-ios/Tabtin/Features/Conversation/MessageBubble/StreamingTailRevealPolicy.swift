import Foundation

/// 流式尾巴只淡「上一帧之后的后缀」。
/// 重写 / 回退整段当 prefix，不动画；token 快于淡入时只跟最新后缀。
enum StreamingTailRevealPolicy {
    static let incomingFadeDuration: TimeInterval = 0.1
    static let caretBlinkDuration: TimeInterval = 0.53
    static let incomingStartOpacity: Double = 0.4

    struct Reveal: Equatable {
        let prefix: String
        let incoming: String
        let shouldAnimateIncoming: Bool
    }

    static func reveal(previousTail: String, nextTail: String) -> Reveal {
        if nextTail.hasPrefix(previousTail) {
            let incoming = String(nextTail.dropFirst(previousTail.count))
            return Reveal(
                prefix: previousTail,
                incoming: incoming,
                shouldAnimateIncoming: !incoming.isEmpty
            )
        }
        return Reveal(prefix: nextTail, incoming: "", shouldAnimateIncoming: false)
    }
}
