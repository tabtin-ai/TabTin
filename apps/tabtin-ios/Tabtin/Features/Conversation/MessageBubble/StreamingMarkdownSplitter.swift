import Foundation

/// 流式 Markdown 增量切分，对齐 Electron `splitStreamingMarkdown`。
///
/// - 稳定区：最后一个「双换行」之前的完整顶层块，内容不再变化，SwiftUI 可复用上一帧渲染结果。
/// - 尾部区：仍在增长的最后一块，每帧用轻量视图上屏。
///
/// 未闭合的代码围栏会整块退回尾部区：截断 fence 会让 Markdown 解析出错。
enum StreamingMarkdownSplitter {
    /// 内容太短时整体走尾部：切分省下的解析量覆盖不了两段视图的开销。
    private static let minSplittableLength = 200
    /// 稳定区太短同样不值得单独渲染。
    private static let minStableLength = 100

    static func split(_ content: String) -> (stable: String, tail: String) {
        guard content.count >= minSplittableLength else { return ("", content) }
        guard let doubleNewlineOffset = lastDoubleNewlineOffset(in: content),
              doubleNewlineOffset >= minStableLength else {
            return ("", content)
        }

        var splitOffset = doubleNewlineOffset + 2
        let candidateEnd = content.index(content.startIndex, offsetBy: splitOffset)
        let fenceOffsets = fenceLineOffsets(in: content[..<candidateEnd])

        // 围栏数为奇数 = 稳定区里有没闭合的代码块，退到该围栏之前，整块交给尾部区。
        if !fenceOffsets.count.isMultiple(of: 2) {
            guard let lastFenceOffset = fenceOffsets.last, lastFenceOffset > 0 else {
                return ("", content)
            }
            splitOffset = lastFenceOffset
        }

        let splitIndex = content.index(content.startIndex, offsetBy: splitOffset)
        return (String(content[..<splitIndex]), String(content[splitIndex...]))
    }

    /// 最后一个 `\n\n` 的起始偏移（字符计），等价 TS 的 `lastIndexOf('\n\n')`。
    private static func lastDoubleNewlineOffset(in content: String) -> Int? {
        var result: Int?
        var previousWasNewline = false
        var offset = 0
        for character in content {
            if character == "\n" {
                if previousWasNewline { result = offset - 1 }
                previousWasNewline = true
            } else {
                previousWasNewline = false
            }
            offset += 1
        }
        return result
    }

    /// 每个代码围栏行的起始偏移，对齐 TS 的 `/^(`{3,}|~{3,})/`。
    private static func fenceLineOffsets(in text: Substring) -> [Int] {
        var offsets: [Int] = []
        var offset = 0
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if isFenceLine(line) { offsets.append(offset) }
            offset += line.count + 1
        }
        return offsets
    }

    private static func isFenceLine(_ line: Substring) -> Bool {
        let trimmed = line.drop { $0.isWhitespace }
        guard let marker = trimmed.first, marker == "`" || marker == "~" else { return false }
        return trimmed.prefix { $0 == marker }.count >= 3
    }
}
