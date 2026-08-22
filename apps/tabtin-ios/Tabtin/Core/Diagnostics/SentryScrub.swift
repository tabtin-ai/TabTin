import Foundation
import Sentry

/// Sentry 事件脱敏。
///
/// 规则口径与 `packages/tabtin-shared/src/diagnostics-redact.ts`（Electron/Daemon 共用）
/// 严格对齐：token / 手机号 / 邮箱 / 家目录用户名不出境。契约见
/// `docs/agent/error-context-schema.md`。iOS 是独立运行时（Swift），无法直接复用
/// TS 包，故在此保留一份同规则的移植——改动任一份都需要同步另一份并跑各自单测。
enum SentryScrub {
    private static func regex(_ pattern: String) -> NSRegularExpression {
        // swiftlint:disable:next force_try — 正则字面量固定，合法性由 SentryScrubTests 兜底。
        try! NSRegularExpression(pattern: pattern)
    }

    /// (正则, 替换模板)。模板用 `$1`/`$2` 引用捕获组，与 TS 侧 `RULES` 逐条对应。
    private static let templateRules: [(NSRegularExpression, String)] = [
        (regex(#"(?i)(bearer\s+)[A-Za-z0-9\-._~+/]{8,}=*"#), "$1<redacted>"),
        (
            regex(
                #"(?i)("?(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie)"?\s*[:=]\s*"?)([^\s"',}]{4,})"#
            ),
            "$1<redacted>"
        ),
        (regex(#"\beyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+"#), "<redacted-jwt>"),
        (regex(#"(/Users/)[^/\s]+"#), "$1<user>"),
        (regex(#"(/home/)[^/\s]+"#), "$1<user>"),
    ]

    /// 邮箱：`local@domain` → `l***@domain`（保留首字符 + 域名，定位问题够用，不暴露全量）。
    private static let emailRegex = regex(#"([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})"#)

    /// 中国大陆手机号：`1[3-9]\d{9}` → `138****5678`。
    private static let phoneRegex = regex(#"\b1[3-9]\d{9}\b"#)

    /// 对一段文本做全量脱敏。空字符串原样返回。
    static func redact(_ input: String) -> String {
        guard !input.isEmpty else { return input }
        var out = input

        for (re, template) in templateRules {
            out = re.stringByReplacingMatches(
                in: out, range: NSRange(out.startIndex..., in: out), withTemplate: template
            )
        }

        out = replacing(emailRegex, in: out) { match, text in
            guard let localRange = Range(match.range(at: 1), in: text),
                  let domainRange = Range(match.range(at: 2), in: text) else { return nil }
            let local = text[localRange]
            let domain = text[domainRange]
            guard let head = local.first else { return nil }
            return "\(head)***@\(domain)"
        }

        out = replacing(phoneRegex, in: out) { match, text in
            guard let fullRange = Range(match.range, in: text) else { return nil }
            let matched = String(text[fullRange])
            guard matched.count == 11 else { return matched }
            let prefix = matched.prefix(3)
            let suffix = matched.suffix(4)
            return "\(prefix)****\(suffix)"
        }

        return out
    }

    /// 用回调按捕获组算替换文本（NSRegularExpression 模板字符串表达不了「取首字符」这类逻辑时用它）。
    private static func replacing(
        _ regex: NSRegularExpression,
        in text: String,
        transform: (NSTextCheckingResult, String) -> String?
    ) -> String {
        let matches = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
        guard !matches.isEmpty else { return text }
        var result = text
        // 从后往前替换，避免前面替换改变后续 match 的 NSRange 偏移。
        for match in matches.reversed() {
            guard let range = Range(match.range, in: result),
                  let replacement = transform(match, result) else { continue }
            result.replaceSubrange(range, with: replacement)
        }
        return result
    }

    /// beforeSend 钩子：对事件文本部位全量脱敏，原地修改并返回。
    /// - `message` / `exceptions[].value` / `breadcrumbs[].message` / `breadcrumbs[].data`（字符串值）过 `redact`；
    /// - `serverName`（设备名，常含真名如「张三的iPhone」）整体丢弃——与 TS 侧 `scrubSentryEvent` 同口径；
    /// - `request` 字段 iOS SDK 不采集请求体，无需额外处理。
    static func scrub(_ event: Event) -> Event {
        event.serverName = nil

        if let formatted = event.message?.formatted {
            event.message = SentryMessage(formatted: redact(formatted))
        }

        event.exceptions?.forEach { exception in
            if let value = exception.value {
                exception.value = redact(value)
            }
        }

        event.breadcrumbs?.forEach { crumb in
            if let message = crumb.message {
                crumb.message = redact(message)
            }
            if let data = crumb.data {
                var redactedData: [String: Any] = [:]
                for (key, value) in data {
                    if let stringValue = value as? String {
                        redactedData[String(describing: key)] = redact(stringValue)
                    } else {
                        redactedData[String(describing: key)] = value
                    }
                }
                crumb.data = redactedData
            }
        }

        return event
    }
}
