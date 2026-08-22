import Foundation

struct ComposerMessageQuote: Equatable {
    let author: String
    let content: String
    let reply: String
    let payload: String
}

enum MessageQuote {
    static func payload(for message: ChatMessage) -> String? {
        guard !message.isStreaming else { return nil }
        let content = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return nil }
        let author = message.role == .assistant ? "Agent" : "我"
        let quoted = content.split(separator: "\n", omittingEmptySubsequences: false)
            .map { "> \($0)" }
            .joined(separator: "\n")
        return "> \(author)：\n\(quoted)\n\n"
    }

    static func parseComposerDraft(_ draft: String) -> ComposerMessageQuote? {
        guard let separator = draft.range(of: "\n\n") else { return nil }

        let quoteBlock = String(draft[..<separator.lowerBound])
        let lines = quoteBlock.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let author: String
        switch lines.first {
        case "> Agent：": author = "Agent"
        case "> 我：": author = "我"
        default: return nil
        }

        let contentLines = lines.dropFirst().compactMap { line -> String? in
            if line.hasPrefix("> ") { return String(line.dropFirst(2)) }
            if line == ">" { return "" }
            return nil
        }
        guard contentLines.count == lines.count - 1, !contentLines.isEmpty else { return nil }

        return ComposerMessageQuote(
            author: author,
            content: contentLines.joined(separator: "\n"),
            reply: String(draft[separator.upperBound...]),
            payload: String(draft[..<separator.upperBound])
        )
    }

    static func replacingComposerQuote(in draft: String, with message: ChatMessage) -> String? {
        guard let newPayload = payload(for: message) else { return nil }
        return newPayload + removingComposerQuote(from: draft)
    }

    static func removingComposerQuote(from draft: String) -> String {
        parseComposerDraft(draft)?.reply ?? draft
    }
}
