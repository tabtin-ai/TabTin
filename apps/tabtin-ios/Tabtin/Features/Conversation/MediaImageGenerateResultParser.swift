import Foundation

/// 从 `tabtin media image generate` 的 tool_result / stdout 信封中抽取成品图 URL。
///
/// 行为对齐 Electron `parseMediaImageGenerateResult.ts`：
/// - 剥 `<approval_note>...</approval_note>` 前缀
/// - 递归 unwrap：`stdout` / `content` / `data` / `data.data`（深度 ≤ 6）
/// - URL 优先级：`stored_urls` → `result_urls` → `result_url` → `imageUrls` / `image_urls` → `url`
/// - 截断文本正则兜底，并把 `\u0026` 解成 `&`
enum MediaImageGenerateResultParser {
    static func parse(_ raw: String?) -> String? {
        guard let raw else { return nil }
        return parse(jsonObject: raw)
    }

    static func parse(jsonObject: Any?) -> String? {
        guard let jsonObject else { return nil }
        let layers = unwrapLayers(jsonObject)

        for layer in layers {
            if let rec = asRecord(layer), let url = pickUrlFromTaskPayload(rec) {
                return url
            }
        }

        for layer in layers {
            if let text = layer as? String, let url = extractUrlFromTruncatedMediaStdout(text) {
                return url
            }
            if let rec = asRecord(layer),
               let stdout = rec["stdout"] as? String,
               let url = extractUrlFromTruncatedMediaStdout(stdout) {
                return url
            }
        }

        return nil
    }

    /// 还原截断 JSON / LLM 抄写时残留的 `\uXXXX` escape，得到可加载的 URL。
    static func normalizeMediaImageUrl(_ raw: String?) -> String? {
        guard var url = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !url.isEmpty else {
            return nil
        }
        url = decodeUnicodeEscapes(url)
        guard url.hasPrefix("https://") || url.hasPrefix("http://") else {
            return nil
        }
        return url
    }

    /// 截断 stdout 兜底：优先 `"result_urls"` / `"result_url"`，再退到任意 https 图链。
    static func extractUrlFromTruncatedMediaStdout(_ text: String) -> String? {
        guard !text.isEmpty else { return nil }

        if let match = firstCapture(
            in: text,
            pattern: #""result_urls"\s*:\s*\[\s*"((?:\\.|[^"\\])*)""#
        ), let url = normalizeMediaImageUrl(match) {
            return url
        }

        if let match = firstCapture(
            in: text,
            pattern: #""result_url"\s*:\s*"((?:\\.|[^"\\])*)""#
        ), let url = normalizeMediaImageUrl(match) {
            return url
        }

        if let match = firstMatch(
            in: text,
            pattern: #"https://[^\s"'\\]+(?:\\u0026[^\s"'\\]*)*"#
        ) {
            return normalizeMediaImageUrl(match)
        }

        return nil
    }
}

// MARK: - Private helpers

private extension MediaImageGenerateResultParser {
    static func asRecord(_ value: Any?) -> [String: Any]? {
        guard let dict = value as? [String: Any] else { return nil }
        return dict
    }

    static func tryParseJson(_ text: String) -> Any? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("{") || trimmed.hasPrefix("[") else { return nil }
        guard let data = trimmed.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    /// tool_result 常带 `<approval_note>...</approval_note>` 前缀，剥掉后再找 JSON。
    static func stripApprovalNote(_ text: String) -> String {
        let pattern = #"</approval_note>\s*([\s\S]*)$"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range),
              match.numberOfRanges > 1,
              let captureRange = Range(match.range(at: 1), in: text) else {
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return String(text[captureRange]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// 从混合文本里抽出第一段顶层 `{...}`（括号平衡）。
    static func extractBalancedJsonObject(_ text: String) -> String? {
        guard let start = text.firstIndex(of: "{") else { return nil }
        var depth = 0
        var inString = false
        var escape = false
        var index = start
        while index < text.endIndex {
            let ch = text[index]
            if inString {
                if escape {
                    escape = false
                } else if ch == "\\" {
                    escape = true
                } else if ch == "\"" {
                    inString = false
                }
            } else if ch == "\"" {
                inString = true
            } else if ch == "{" {
                depth += 1
            } else if ch == "}" {
                depth -= 1
                if depth == 0 {
                    return String(text[start...index])
                }
            }
            index = text.index(after: index)
        }
        return nil
    }

    static func urlFromUnknownCandidate(_ candidate: Any?) -> String? {
        if let string = candidate as? String {
            return normalizeMediaImageUrl(string)
        }
        guard let array = candidate as? [Any] else { return nil }
        for item in array {
            guard let string = item as? String else { continue }
            if let url = normalizeMediaImageUrl(string) {
                return url
            }
        }
        return nil
    }

    static func firstHttpsUrl(_ candidates: Any?...) -> String? {
        for candidate in candidates {
            if let url = urlFromUnknownCandidate(candidate) {
                return url
            }
        }
        return nil
    }

    static func pickUrlFromTaskPayload(_ payload: [String: Any]) -> String? {
        firstHttpsUrl(
            payload["stored_urls"],
            payload["result_urls"],
            payload["result_url"],
            payload["imageUrls"],
            payload["image_urls"],
            payload["url"]
        )
    }

    static func unwrapLayers(_ raw: Any, depth: Int = 0) -> [Any] {
        if depth > 6 { return [] }
        var out: [Any] = [raw]

        if let string = raw as? String {
            let stripped = stripApprovalNote(string)
            if stripped != string {
                out.append(stripped)
            }
            if let balanced = extractBalancedJsonObject(stripped),
               let parsed = tryParseJson(balanced) {
                out.append(contentsOf: unwrapLayers(parsed, depth: depth + 1))
            } else if let parsed = tryParseJson(stripped) {
                out.append(contentsOf: unwrapLayers(parsed, depth: depth + 1))
            }
            return out
        }

        guard let rec = asRecord(raw) else { return out }

        if let stdout = rec["stdout"] as? String,
           !stdout.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            out.append(contentsOf: unwrapLayers(stdout, depth: depth + 1))
        }
        if let content = rec["content"] as? String,
           !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            out.append(contentsOf: unwrapLayers(content, depth: depth + 1))
        }
        if let data = rec["data"] {
            out.append(contentsOf: unwrapLayers(data, depth: depth + 1))
            if let nested = asRecord(data), let nestedData = nested["data"] {
                out.append(contentsOf: unwrapLayers(nestedData, depth: depth + 1))
            }
        }
        return out
    }

    static func decodeUnicodeEscapes(_ text: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: #"\\u([0-9a-fA-F]{4})"#) else {
            return text
        }
        let nsText = text as NSString
        let matches = regex.matches(in: text, options: [], range: NSRange(location: 0, length: nsText.length))
        guard !matches.isEmpty else { return text }

        var result = text
        for match in matches.reversed() {
            guard match.numberOfRanges > 1,
                  let hexRange = Range(match.range(at: 1), in: result),
                  let fullRange = Range(match.range(at: 0), in: result),
                  let code = UInt32(result[hexRange], radix: 16),
                  let scalar = UnicodeScalar(code) else { continue }
            result.replaceSubrange(fullRange, with: String(Character(scalar)))
        }
        return result
    }

    static func firstCapture(in text: String, pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range),
              match.numberOfRanges > 1,
              let captureRange = Range(match.range(at: 1), in: text) else {
            return nil
        }
        return String(text[captureRange])
    }

    static func firstMatch(in text: String, pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range),
              let matchRange = Range(match.range, in: text) else {
            return nil
        }
        return String(text[matchRange])
    }
}
