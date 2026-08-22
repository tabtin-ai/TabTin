import Foundation

struct IMTextLink: Equatable {
    let url: URL
    let range: NSRange
}

@MainActor
private enum IMTextLinkDetection {
    static let detector = try? NSDataDetector(
        types: NSTextCheckingResult.CheckingType.link.rawValue
    )
}

@MainActor
func findIMTextLinks(in content: String) -> [IMTextLink] {
    guard let detector = IMTextLinkDetection.detector, !content.isEmpty else { return [] }
    let fullRange = NSRange(content.startIndex..<content.endIndex, in: content)
    return detector.matches(in: content, options: [], range: fullRange).compactMap { match in
        guard let sourceRange = Range(match.range, in: content) else { return nil }
        let source = content[sourceRange].lowercased()
        // NSDataDetector 会把裸域名补成 http；先校验原文 scheme，再校验解析结果，避免扩大可点击范围。
        guard source.hasPrefix("http://") || source.hasPrefix("https://"),
              let url = match.url,
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else { return nil }
        return IMTextLink(url: url, range: match.range)
    }
}

@MainActor
func attributedIMText(_ content: String) -> AttributedString {
    var attributed = AttributedString(content)
    for link in findIMTextLinks(in: content) {
        guard let stringRange = Range(link.range, in: content),
              let lowerBound = AttributedString.Index(stringRange.lowerBound, within: attributed),
              let upperBound = AttributedString.Index(stringRange.upperBound, within: attributed) else {
            continue
        }
        attributed[lowerBound..<upperBound].link = link.url
    }
    return attributed
}
