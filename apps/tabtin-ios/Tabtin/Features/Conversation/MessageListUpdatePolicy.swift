import Foundation
import Observation

/// 单个正文块的引用型展示叶子。流式纯文本增长只改这里，让 Observation 的失效范围
/// 停在 Markdown 叶子，不再向上传播到整条气泡或整列消息。
@Observable
@MainActor
final class MessageTextLeafModel: Identifiable {
    let id: String
    private(set) var block: TextBlock
    private(set) var isStreaming: Bool
    /// 便于回归测试确认纯文本更新确实命中叶子路径。
    private(set) var generation = 0

    init(block: TextBlock, isStreaming: Bool) {
        id = block.id
        self.block = block
        self.isStreaming = isStreaming
    }

    func replace(block: TextBlock, isStreaming: Bool) {
        guard self.block != block || self.isStreaming != isStreaming else { return }
        self.block = block
        self.isStreaming = isStreaming
        generation += 1
    }
}

/// 单条消息的引用型展示模型。
///
/// `structuralMessage` 只在 block 结构、引用、流式终态等结构事实变化时更新；纯文本 delta
/// 只写对应的 `MessageTextLeafModel`。`latestMessage` 保留完整最新快照供动作回调读取，但不参与
/// Observation，避免一个 token 让整条气泡重新求值。
@Observable
@MainActor
final class MessageRowModel: Identifiable {
    let id: String
    private(set) var structuralMessage: ChatMessage
    private(set) var textLeaves: [String: MessageTextLeafModel]
    private(set) var structuralGeneration = 0
    @ObservationIgnored private var latestMessage: ChatMessage

    init(message: ChatMessage) {
        id = message.id
        structuralMessage = message
        latestMessage = message
        textLeaves = Self.makeTextLeaves(for: message)
    }

    /// 只允许正文字符串变化进入叶子路径；任何结构或元数据变化都交回完整发布。
    @discardableResult
    func applyTextLeaves(from next: ChatMessage) -> Bool {
        guard next.id == id,
              Self.normalizingText(in: latestMessage) == Self.normalizingText(in: next),
              Self.textPresenceShape(in: latestMessage) == Self.textPresenceShape(in: next)
        else { return false }

        let nextBlocks = Self.textBlocks(in: next)
        guard nextBlocks.contains(where: { textLeaves[$0.id]?.block != $0 }) else {
            return false
        }
        guard nextBlocks.allSatisfy({ textLeaves[$0.id] != nil }) else {
            return false
        }

        latestMessage = next
        for block in nextBlocks {
            textLeaves[block.id]?.replace(block: block, isStreaming: next.isStreaming)
        }
        return true
    }

    func replaceStructure(with next: ChatMessage) {
        precondition(next.id == id, "MessageRowModel identity cannot change")
        guard latestMessage != next || structuralMessage != next else { return }
        latestMessage = next
        structuralMessage = next
        textLeaves = Self.makeTextLeaves(for: next, reusing: textLeaves)
        structuralGeneration += 1
    }

    /// 用户在流式期间触发复制等动作时，读取权威的最新内容而非旧结构快照。
    func snapshot() -> ChatMessage {
        latestMessage
    }

    private static func textBlocks(in message: ChatMessage) -> [TextBlock] {
        message.blocks.compactMap { block in
            guard case let .text(text) = block else { return nil }
            return text
        }
    }

    private static func makeTextLeaves(
        for message: ChatMessage,
        reusing existing: [String: MessageTextLeafModel] = [:]
    ) -> [String: MessageTextLeafModel] {
        Dictionary(uniqueKeysWithValues: textBlocks(in: message).map { block in
            if let leaf = existing[block.id] {
                leaf.replace(block: block, isStreaming: message.isStreaming)
                return (block.id, leaf)
            }
            return (block.id, MessageTextLeafModel(block: block, isStreaming: message.isStreaming))
        })
    }

    private static func normalizingText(in message: ChatMessage) -> ChatMessage {
        var normalized = message
        normalized.blocks = message.blocks.map { block in
            guard case var .text(text) = block else { return block }
            text.text = ""
            return .text(text)
        }
        return normalized
    }

    /// 空白正文会和 thinking/tool 一起归入步骤组；首个可见字符会把消息切回普通气泡。
    /// 这条边界必须走结构发布，否则叶子模型尚未挂到实际渲染树，用户会看不到正文。
    private static func textPresenceShape(in message: ChatMessage) -> [Bool] {
        textBlocks(in: message).map {
            $0.text.contains { !$0.isWhitespace }
        }
    }
}
