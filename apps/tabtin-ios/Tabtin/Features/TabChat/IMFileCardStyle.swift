import SwiftUI

/// IM 私信附件文件卡视觉（紧凑横版）：与 Electron `FILE_TYPE_STYLES` 扩展名分色对齐，
/// 移动端为横版矩形（宽约 252、高约 64），白字 + 右上扩展名徽标 + 右下操作钮。
enum IMFileCardStyle {
    static let cardMaxWidth: CGFloat = 252
    static let cardMinHeight: CGFloat = 64
    static let cardCornerRadius: CGFloat = 14
    static let actionSize: CGFloat = 28

    static let unavailableBackground = Color(red: 0x6B / 255, green: 0x72 / 255, blue: 0x80 / 255)

    private static let pdf = Color(red: 0xEF / 255, green: 0x44 / 255, blue: 0x44 / 255)
    private static let doc = Color(red: 0x3B / 255, green: 0x82 / 255, blue: 0xF6 / 255)
    private static let xls = Color(red: 0x05 / 255, green: 0x96 / 255, blue: 0x69 / 255)
    private static let ppt = Color(red: 0xF9 / 255, green: 0x73 / 255, blue: 0x16 / 255)
    private static let md = Color(red: 0x47 / 255, green: 0x55 / 255, blue: 0x69 / 255)
    private static let json = Color(red: 0xF5 / 255, green: 0x9E / 255, blue: 0x0B / 255)
    private static let txt = Color(red: 0x6B / 255, green: 0x72 / 255, blue: 0x80 / 255)
    private static let unknown = Color(red: 0x9C / 255, green: 0xA3 / 255, blue: 0xAF / 255)

    private static let byExt: [String: (Color, String)] = [
        "doc": (doc, "DOC"),
        "docx": (doc, "DOCX"),
        "xls": (xls, "XLS"),
        "xlsx": (xls, "XLSX"),
        "ppt": (ppt, "PPT"),
        "pptx": (ppt, "PPTX"),
        "pdf": (pdf, "PDF"),
        "md": (md, "MD"),
        "markdown": (md, "MD"),
        "json": (json, "JSON"),
        "txt": (txt, "TXT"),
    ]

    struct Resolved {
        let background: Color
        let badge: String
    }

    static func resolve(fileName: String, isUnavailable: Bool = false) -> Resolved {
        let ext = fileExtension(of: fileName)
        if isUnavailable {
            let badge = byExt[ext]?.1 ?? (ext.isEmpty ? "FILE" : ext.uppercased())
            return Resolved(background: unavailableBackground, badge: String(badge.prefix(6)))
        }
        if let mapped = byExt[ext] {
            return Resolved(background: mapped.0, badge: mapped.1)
        }
        let badge = ext.isEmpty ? "?" : ext.uppercased()
        return Resolved(background: unknown, badge: String(badge.prefix(6)))
    }

    static func fileExtension(of fileName: String) -> String {
        let trimmed = fileName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let dot = trimmed.lastIndex(of: "."),
              dot > trimmed.startIndex,
              trimmed.index(after: dot) < trimmed.endIndex
        else { return "" }
        return String(trimmed[trimmed.index(after: dot)...]).lowercased()
    }
}
