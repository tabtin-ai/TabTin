import Foundation

/// 多维表数值类字段的卡片显示格式。与 Android `TabDataNumberFormat` 逐字节对齐。
///
/// percent 正典是 Web `formatPercentCellValue`（table-ui cellValueUtils.ts:65）以及
/// `formatMobileCardValue`（mobileTablePrimitives.ts:127）：后端存小数比值
///（`0.85` = 85%），显示时 `* 100`、最多两位小数、去掉尾随零、加 `%`。
/// 不认字段 `precision`，也没有千分位。
enum NativeTabDataNumberFormatPolicy {
    /// 空值或非有限数字返回 `nil`，由调用方回落到原文。
    static func formatPercent(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let ratio = Double(trimmed), ratio.isFinite else {
            return nil
        }
        return formatPercentRatio(ratio)
    }

    static func formatPercentRatio(_ ratio: Double) -> String {
        let fixed = String(format: "%.2f", ratio * 100)
        let stripped = fixed.replacingOccurrences(
            of: #"\.?0+$"#,
            with: "",
            options: .regularExpression
        )
        return stripped + "%"
    }

    /// 详情编辑框里的百分点数，与 `formatPercent` 同一套取整，但不带 `%`。
    /// `0.85` → `85`，`0.123` → `12.3`。空值或脏数据返回 `nil`。
    static func formatPercentEditorPoints(_ raw: String) -> String? {
        formatPercent(raw)?.trimmingCharacters(in: CharacterSet(charactersIn: "%"))
    }

    /// 与 Web `parsePercentPointsToRatio` 对齐：用户输入百分点数，本地 `/100` 得到比值。
    /// 空输入是清空，不是 0。中间态（`-`、`8.`）返回 `nil` 且 `isPercentEditorIntermediate` 为 true。
    static func parsePercentPointsToRatio(_ text: String) -> Double? {
        let cleaned = text.replacingOccurrences(of: #"\s*%\s*$"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return nil }
        guard let number = Double(cleaned), number.isFinite else { return nil }
        return number / 100
    }

    static func isPercentEditorIntermediate(_ text: String) -> Bool {
        let cleaned = text.replacingOccurrences(of: #"\s*%\s*$"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.isEmpty { return false }
        if cleaned == "-" || cleaned == "+" || cleaned == "." || cleaned == "-." || cleaned == "+." {
            return true
        }
        if cleaned.hasSuffix("."), Double(String(cleaned.dropLast())) != nil {
            return true
        }
        return Double(cleaned) == nil
    }

    /// 把编辑框文本提交成线上比值串。
    /// 显示点与原比值格式化结果相同则原样保留，避免 `85/100` 浮点漂移。
    static func commitPercentEditor(typed: String, storedRatioRaw: String) -> NativeTabDataPercentEditorCommit {
        let cleaned = typed.replacingOccurrences(of: #"\s*%\s*$"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.isEmpty { return .empty }
        if isPercentEditorIntermediate(typed) { return .intermediate }
        if let storedPoints = formatPercentEditorPoints(storedRatioRaw), storedPoints == cleaned {
            return .ratio(storedRatioRaw.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        guard let points = Decimal(string: cleaned, locale: Locale(identifier: "en_US_POSIX")) else {
            return .intermediate
        }
        let ratio = points / Decimal(100)
        return .ratio(NSDecimalNumber(decimal: ratio).stringValue)
    }

    /// 与 Web grid `symbol + number.toFixed(precision)` 对齐。没有千分位。
    static func formatCurrency(_ raw: String, symbol: String = "¥", precision: Int = 2) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let number = Double(trimmed), number.isFinite else {
            return nil
        }
        let places = max(precision, 0)
        let amount = String(format: "%.\(places)f", locale: Locale(identifier: "en_US_POSIX"), number)
        return symbol + amount
    }

    static func currencySymbol(_ options: [String: AnyCodable]?) -> String {
        if let text = scalarText(options?["symbol"]?.value), !text.isEmpty {
            return text
        }
        return "¥"
    }

    static func currencyPrecision(_ options: [String: AnyCodable]?) -> Int {
        min(max(scalarInt(options?["precision"]?.value) ?? 2, 0), 10)
    }

    static func clampRating(_ raw: String, max: Int = 5) -> Int? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let number = Double(trimmed), number.isFinite else {
            return nil
        }
        guard number == Foundation.floor(number) else { return nil }
        let upper = Swift.max(max, 0)
        return Swift.min(Swift.max(Int(number), 0), upper)
    }

    static func ratingMax(_ options: [String: AnyCodable]?) -> Int {
        min(max(scalarInt(options?["max"]?.value) ?? 5, 1), 10)
    }

    static func formatRatingStars(_ raw: String, max: Int = 5) -> String? {
        guard let value = clampRating(raw, max: max) else { return nil }
        let filled = String(repeating: "★", count: value)
        let empty = String(repeating: "☆", count: Swift.max(max - value, 0))
        return filled + empty
    }

    /// 与 Android `TabDataNumberFormat.scalarText` 对齐：只认字符串。
    private static func scalarText(_ raw: Any?) -> String? {
        raw as? String
    }

    /// 与 Android `TabDataNumberFormat.scalarInt` 对齐：Number / String。
    private static func scalarInt(_ raw: Any?) -> Int? {
        switch raw {
        case let int as Int:
            return int
        case let double as Double:
            return Int(double)
        case let string as String:
            return Int(string)
        default:
            return nil
        }
    }
}

enum NativeTabDataPercentEditorCommit: Equatable {
    case empty
    case ratio(String)
    case intermediate
}
