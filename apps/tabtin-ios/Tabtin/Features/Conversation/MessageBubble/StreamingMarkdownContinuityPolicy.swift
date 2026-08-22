import Foundation

/// 流式才切稳定区 / 尾巴。收束不重新切分全文：
/// 若仍是流式期冻住的前缀，只把尾巴转成 Markdown；对不上再整段 parse。
enum StreamingMarkdownContinuityPolicy {
    enum TailRenderer: Equatable {
        case plainText
        case markdown
    }

    struct Layout: Equatable {
        let stable: String
        let tail: String
        let tailRenderer: TailRenderer

        var hasStable: Bool { !stable.isEmpty }
        var stableIdentity: String { stable }
    }

    static func layout(
        content: String,
        isStreaming: Bool,
        lastStreamingStable: String = ""
    ) -> Layout {
        if isStreaming {
            let parts = StreamingMarkdownSplitter.split(content)
            return Layout(
                stable: parts.stable,
                tail: parts.tail,
                tailRenderer: .plainText
            )
        }
        if !lastStreamingStable.isEmpty, content.hasPrefix(lastStreamingStable) {
            return Layout(
                stable: lastStreamingStable,
                tail: String(content.dropFirst(lastStreamingStable.count)),
                tailRenderer: .markdown
            )
        }
        return Layout(stable: "", tail: content, tailRenderer: .markdown)
    }
}
