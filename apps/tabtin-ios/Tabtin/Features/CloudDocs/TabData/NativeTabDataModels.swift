import Foundation

struct NativeTabDataTable: Decodable, Sendable, Equatable {
    let id: String
    let name: String
    let organizationId: String?
    let defaultViewId: String?
    let currentUserRole: String?

    enum CodingKeys: String, CodingKey {
        case id, name
        case organizationId = "organization_id"
        case defaultViewId = "default_view_id"
        case currentUserRole = "current_user_role"
    }

    var canEdit: Bool {
        guard let role = currentUserRole?.lowercased() else { return false }
        return ["owner", "admin", "editor"].contains(role)
    }
}

enum NativeTabDataFieldKind: String, Decodable, Sendable {
    case text
    case longText = "long_text"
    case number
    case currency
    case percent
    case rating
    case select
    case singleSelect = "single_select"
    case multiSelect = "multi_select"
    case checkbox
    case date
    case createdTime = "created_time"
    case lastModifiedTime = "last_modified_time"
    case url
    case email
    case phone
    case user
    case createdBy = "created_by"
    case lastModifiedBy = "last_modified_by"
    case attachment
    case link
    case button
    case skill
    case unknown

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: Self.normalize(value)) ?? .unknown
    }

    /// 与 `packages/table-kernel/src/types/field.ts` 的 `normalizeFieldType()` 对齐。
    static func normalize(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "text" }
        let key = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return aliases[key] ?? key
    }

    private static let aliases: [String: String] = [
        "string": "text",
        "textarea": "long_text",
        "integer": "number",
        "float": "number",
        "bool": "checkbox",
        "boolean": "checkbox",
        "single_select": "select",
        "multiple_select": "multi_select",
        "multiselect": "multi_select",
        "file": "attachment",
        "image": "attachment",
        "enum": "select",
    ]

    /// 只写后端契约明确、能在系统控件中无损表达的字段。date 有 DatePicker
    /// 与 NativeTabDataDateCodec 兜住；user 有成员选择器。created_by / last_modified_by
    /// 是系统计算字段，必须保持只读。附件仍缺上传链路，继续引导完整编辑器。
    var isEditable: Bool {
        switch self {
        case .text, .longText, .number, .currency, .percent, .rating,
             .select, .singleSelect, .multiSelect, .checkbox, .date,
             .url, .email, .phone, .user:
            true
        default:
            false
        }
    }

    var isLongText: Bool { self == .longText }

    var isPerson: Bool {
        switch self {
        case .user, .createdBy, .lastModifiedBy:
            true
        default:
            false
        }
    }
}

/// 移动端只开放已经具备无损原生编辑器的高频字段类型。
enum NativeTabDataCreateFieldType: String, CaseIterable, Identifiable, Sendable {
    case text
    case longText = "long_text"
    case number
    case select
    case multiSelect = "multi_select"
    case checkbox

    var id: String { rawValue }
    var requiresChoices: Bool { self == .select || self == .multiSelect }
}

enum NativeTabDataCreateFieldValidationError: Equatable, Sendable {
    case emptyName
    case nameTooLong
    case duplicateName
    case missingChoices
}

struct NativeTabDataCreateFieldRequest: Equatable, Sendable {
    let tableId: String
    let name: String
    let fieldType: NativeTabDataCreateFieldType
    let choices: [String]

    init(
        tableId: String,
        name: String,
        fieldType: NativeTabDataCreateFieldType,
        choices: [String] = []
    ) {
        self.tableId = tableId
        self.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        self.fieldType = fieldType
        var seen = Set<String>()
        self.choices = choices.compactMap { rawChoice in
            let choice = rawChoice.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !choice.isEmpty, seen.insert(choice).inserted else { return nil }
            return choice
        }
    }

    func validationError(existingFields: [NativeTabDataField]) -> NativeTabDataCreateFieldValidationError? {
        if name.isEmpty { return .emptyName }
        if name.count > 100 { return .nameTooLong }
        if existingFields.contains(where: {
            $0.name.compare(name, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
        }) {
            return .duplicateName
        }
        if fieldType.requiresChoices, choices.isEmpty { return .missingChoices }
        return nil
    }

    var body: [String: Any] {
        var result: [String: Any] = [
            "table_id": tableId,
            "name": name,
            "field_type": fieldType.rawValue,
        ]
        if fieldType.requiresChoices {
            result["options"] = ["choices": choices]
        }
        return result
    }
}

struct NativeTabDataField: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let name: String
    let fieldType: NativeTabDataFieldKind
    let isPrimary: Bool
    let isHidden: Bool
    let order: Int
    let options: [String: AnyCodable]?
    /// 与 Django / table-kernel 的 `isMultipleCellValue` 对齐；user 默认 false。
    let isMultipleCellValue: Bool

    enum CodingKeys: String, CodingKey {
        case id, name, options, order
        case fieldType = "field_type"
        case isPrimary = "is_primary"
        case isHidden = "is_hidden"
        case isMultipleCellValue
        case isMultipleCellValueSnake = "is_multiple_cell_value"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        fieldType = try container.decode(NativeTabDataFieldKind.self, forKey: .fieldType)
        isPrimary = try container.decodeIfPresent(Bool.self, forKey: .isPrimary) ?? false
        isHidden = try container.decodeIfPresent(Bool.self, forKey: .isHidden) ?? false
        order = try container.decodeIfPresent(Int.self, forKey: .order) ?? 0
        options = try container.decodeIfPresent([String: AnyCodable].self, forKey: .options)
        isMultipleCellValue = try container.decodeIfPresent(Bool.self, forKey: .isMultipleCellValue)
            ?? container.decodeIfPresent(Bool.self, forKey: .isMultipleCellValueSnake)
            ?? false
    }

    /// user 的多选看 `options.multiple` 或顶层 `isMultipleCellValue`；二者任一为真即多选。
    var allowsMultipleUsers: Bool {
        guard fieldType == .user else { return false }
        return isMultipleCellValue || options?["multiple"]?.boolValue == true
    }

    var selectOptions: [NativeTabDataSelectOption] {
        let configured = options?["choices"]?.arrayValue
            ?? options?["options"]?.arrayValue
            ?? (options?["options"]?.dictValue?["choices"] as? [Any])
        return configured?.compactMap { item in
            if let value = item as? String {
                return NativeTabDataSelectOption(value: value, label: value, color: nil)
            }
            guard let dictionary = item as? [String: Any] else { return nil }
            let value = dictionary["value"] as? String
                ?? dictionary["id"] as? String
                ?? dictionary["name"] as? String
                ?? dictionary["label"] as? String
            guard let value, !value.isEmpty else { return nil }
            let label = dictionary["label"] as? String
                ?? dictionary["name"] as? String
                ?? value
            return NativeTabDataSelectOption(
                value: value,
                label: label,
                color: dictionary["color"] as? String
            )
        } ?? []
    }

    func displayText(
        for value: NativeTabDataValue,
        raw: AnyCodable? = nil,
        directory: NativeTabDataMemberDirectory = .empty,
        copy: NativeTabDataMemberCopy = .localized
    ) -> String {
        if fieldType.isPerson {
            return resolvedMembers(from: raw, value: value, directory: directory, copy: copy)
                .map(\.displayName)
                .joined(separator: " · ")
        }
        let rendered: String
        if case .selections(let values) = value {
            let labels = Dictionary(uniqueKeysWithValues: selectOptions.map { ($0.value, $0.label) })
            rendered = values.map { labels[$0] ?? $0 }.joined(separator: " · ")
        } else if fieldType == .percent, case .number(let rawNumber) = value,
                  let formatted = NativeTabDataNumberFormatPolicy.formatPercent(rawNumber) {
            rendered = formatted
        } else if fieldType == .currency, case .number(let rawNumber) = value,
                  let formatted = NativeTabDataNumberFormatPolicy.formatCurrency(
                    rawNumber,
                    symbol: NativeTabDataNumberFormatPolicy.currencySymbol(options),
                    precision: NativeTabDataNumberFormatPolicy.currencyPrecision(options)
                  ) {
            rendered = formatted
        } else if fieldType == .rating, case .number(let rawNumber) = value,
                  let formatted = NativeTabDataNumberFormatPolicy.formatRatingStars(
                    rawNumber,
                    max: NativeTabDataNumberFormatPolicy.ratingMax(options)
                  ) {
            rendered = formatted
        } else {
            rendered = value.displayText
        }
        guard hidesInternalIdentity, NativeTabDataDisplayText.looksLikeInternalId(rendered) else {
            return rendered
        }
        return ""
    }

    func resolvedMembers(
        from raw: AnyCodable?,
        value: NativeTabDataValue? = nil,
        directory: NativeTabDataMemberDirectory = .empty,
        copy: NativeTabDataMemberCopy = .localized
    ) -> [NativeTabDataMemberRef] {
        guard fieldType.isPerson else { return [] }
        return NativeTabDataMemberDirectoryResolver.resolve(
            raw?.value ?? value?.personResolverInput,
            directory: directory,
            copy: copy
        )
    }

    /// 关联 / 查找仍隐藏内部 ID。人员字段改走目录解析，不再用空串掩盖。
    private var hidesInternalIdentity: Bool {
        switch fieldType {
        case .link:
            true
        default:
            false
        }
    }
}

struct NativeTabDataSelectOption: Identifiable, Equatable, Sendable {
    let value: String
    let label: String
    let color: String?
    var id: String { value }
}

struct NativeTabDataFilterSet: Equatable, Sendable {
    let conjunction: String
    private let raw: [String: AnyCodable]

    init?(raw: [String: AnyCodable]) {
        let object = raw.mapValues(\.value)
        guard let conjunction = Self.validatedConjunction(object["conjunction"]),
              let items = object["filterSet"] as? [Any],
              items.allSatisfy(Self.isValidItem)
        else { return nil }
        self.conjunction = conjunction
        self.raw = raw
    }

    var jsonObject: [String: Any] { raw.mapValues(\.value) }

    private static func isValidItem(_ value: Any) -> Bool {
        guard let item = value as? [String: Any] else { return false }
        if item["filterSet"] != nil || item["conjunction"] != nil {
            guard validatedConjunction(item["conjunction"]) != nil,
                  let children = item["filterSet"] as? [Any]
            else { return false }
            return children.allSatisfy(isValidItem)
        }
        let field = (item["field_id"] as? String) ?? (item["field"] as? String)
        let operatorName = item["operator"] as? String
        return field?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            && operatorName?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }

    private static func validatedConjunction(_ value: Any?) -> String? {
        guard let value = value as? String else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return ["and", "or"].contains(normalized) ? normalized : nil
    }
}

struct NativeTabDataView: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let name: String
    let viewType: String
    let order: Int
    let filterSet: NativeTabDataFilterSet?
    let filters: [[String: AnyCodable]]
    let sorts: [[String: AnyCodable]]
    let groups: [[String: AnyCodable]]
    let config: [String: AnyCodable]
    let visibleFields: [String]
    let fieldOrder: [String]
    let columnMeta: [String: AnyCodable]
    let isLocked: Bool

    enum CodingKeys: String, CodingKey {
        case id, name, config, filter, filters, sorts, groups, order
        case viewType = "view_type"
        case visibleFields = "visible_fields"
        case fieldOrder = "field_order"
        case columnMeta = "column_meta"
        case isLocked = "is_locked"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        viewType = try container.decodeIfPresent(String.self, forKey: .viewType) ?? "grid"
        order = try container.decodeIfPresent(Int.self, forKey: .order) ?? 0
        if let rawFilter = try? container.decode([String: AnyCodable].self, forKey: .filter) {
            filterSet = NativeTabDataFilterSet(raw: rawFilter)
        } else {
            filterSet = nil
        }
        // 旧版桌面端会把部分看板配置写成对象（而不是数组）；这不应让整个视图解码失败。
        filters = (try? container.decodeIfPresent([[String: AnyCodable]].self, forKey: .filters)) ?? []
        sorts = (try? container.decodeIfPresent([[String: AnyCodable]].self, forKey: .sorts)) ?? []
        groups = (try? container.decodeIfPresent([[String: AnyCodable]].self, forKey: .groups)) ?? []
        config = try container.decodeIfPresent([String: AnyCodable].self, forKey: .config) ?? [:]
        visibleFields = try container.decodeIfPresent([String].self, forKey: .visibleFields) ?? []
        fieldOrder = try container.decodeIfPresent([String].self, forKey: .fieldOrder) ?? []
        columnMeta = try container.decodeIfPresent([String: AnyCodable].self, forKey: .columnMeta) ?? [:]
        isLocked = try container.decodeIfPresent(Bool.self, forKey: .isLocked) ?? false
    }

    var supportsNativeCards: Bool {
        NativeTabDataSurfacePolicy.supportsNativeCards(viewType: viewType)
    }

    var isKanban: Bool {
        NativeTabDataSurfacePolicy.kind(viewType: viewType) == .kanban
    }

    var configuredFilterLogic: String {
        let normalized = config["filter_logic"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return normalized == "or" ? "or" : "and"
    }

    var groupFieldKey: String? {
        config["group_by_field"]?.stringValue
            ?? config["group_field"]?.stringValue
            ?? groups.first?["field_id"]?.stringValue
            ?? groups.first?["field"]?.stringValue
    }

    var titleFieldKey: String? {
        config["card_title_field"]?.stringValue
            ?? config["title_field"]?.stringValue
    }

    var coverFieldKey: String? {
        config["card_cover_field"]?.stringValue
            ?? config["cover_field"]?.stringValue
    }
}

struct NativeTabDataRecord: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let tableId: String?
    var fields: [String: AnyCodable]
    var version: Int64

    enum CodingKeys: String, CodingKey {
        case id, fields, data, version
        case tableId = "table_id"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        tableId = try container.decodeIfPresent(String.self, forKey: .tableId)
        let keyedFields = try container.decodeIfPresent([String: AnyCodable].self, forKey: .fields) ?? [:]
        let legacyData = try container.decodeIfPresent([String: AnyCodable].self, forKey: .data) ?? [:]
        fields = keyedFields.isEmpty ? legacyData : keyedFields
        version = (try? container.decodeIfPresent(Int64.self, forKey: .version))
            ?? (try? container.decodeIfPresent(String.self, forKey: .version).flatMap(Int64.init))
            ?? 1
    }

    init(id: String, tableId: String?, fields: [String: AnyCodable], version: Int64) {
        self.id = id
        self.tableId = tableId
        self.fields = fields
        self.version = version
    }
}

struct NativeTabDataFieldList: Decodable, Sendable {
    let fields: [NativeTabDataField]
}

struct NativeTabDataViewList: Decodable, Sendable {
    let views: [NativeTabDataView]
}

struct NativeTabDataRecordList: Decodable, Sendable {
    let records: [NativeTabDataRecord]
    let total: Int?
    let matchedTotal: Int?
    let page: Int?
    let pageSize: Int?
    let metadata: NativeTabDataViewMetadata?

    enum CodingKeys: String, CodingKey {
        case records, total, page, metadata
        case matchedTotal = "matched_total"
        case pageSize = "page_size"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // 看板响应把记录放在 metadata.groups[].records，顶层不会携带 records。
        records = try container.decodeIfPresent([NativeTabDataRecord].self, forKey: .records) ?? []
        total = try container.decodeIfPresent(Int.self, forKey: .total)
        matchedTotal = try container.decodeIfPresent(Int.self, forKey: .matchedTotal)
        page = try container.decodeIfPresent(Int.self, forKey: .page)
        pageSize = try container.decodeIfPresent(Int.self, forKey: .pageSize)
        metadata = try container.decodeIfPresent(NativeTabDataViewMetadata.self, forKey: .metadata)
    }

    init(
        records: [NativeTabDataRecord],
        total: Int?,
        matchedTotal: Int?,
        page: Int?,
        pageSize: Int?,
        metadata: NativeTabDataViewMetadata?
    ) {
        self.records = records
        self.total = total
        self.matchedTotal = matchedTotal
        self.page = page
        self.pageSize = pageSize
        self.metadata = metadata
    }
}

extension NativeTabDataRecordList {
    static let empty = NativeTabDataRecordList(
        records: [], total: 0, matchedTotal: 0, page: 1, pageSize: 30, metadata: nil
    )
}

enum NativeTabDataReadIdentityError: LocalizedError {
    case mismatchedRecordTable

    var errorDescription: String? { L10n.TabData.conflictMessage }
}

struct NativeTabDataViewMetadata: Decodable, Sendable {
    let groups: [NativeTabDataRecordGroup]
    let needsConfiguration: Bool

    enum CodingKeys: String, CodingKey {
        case groups
        case needsConfiguration = "needs_configuration"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if !container.contains(.groups) {
            groups = []
        } else if try container.decodeNil(forKey: .groups) {
            groups = []
        } else if var groupContainer = try? container.nestedUnkeyedContainer(forKey: .groups) {
            var decodedGroups: [NativeTabDataRecordGroup] = []
            while !groupContainer.isAtEnd {
                // 单个异常分组不应让整张看板进入“数据解析失败”；保留其余可读分组。
                if let group = try? groupContainer.decode(NativeTabDataRecordGroup.self) {
                    decodedGroups.append(group)
                }
            }
            groups = decodedGroups
        } else {
            // 兼容旧客户端把分组编码成「分组值 -> 分组对象」或「分组值 -> 记录数组」的形态。
            if let keyedGroups = try? container.decode([String: NativeTabDataRecordGroup].self, forKey: .groups) {
                groups = keyedGroups.map { key, group in group.withFallbackLabel(key) }
            } else if let keyedRecords = try? container.decode([String: [NativeTabDataRecord]].self, forKey: .groups) {
                groups = keyedRecords.map { key, records in
                    NativeTabDataRecordGroup(groupLabel: key, records: records)
                }
            } else {
                // 部分筛选视图把 `groups` 用作字段/节点配置对象，而真正记录仍在顶层。
                _ = try container.decode([String: AnyCodable].self, forKey: .groups)
                groups = []
            }
        }
        needsConfiguration = try container.decodeIfPresent(Bool.self, forKey: .needsConfiguration) ?? false
    }
}

struct NativeTabDataRecordGroup: Decodable, Identifiable, Sendable {
    let groupValue: AnyCodable
    let groupLabel: String
    let color: String?
    var records: [NativeTabDataRecord]
    let count: Int
    var offset: Int
    let perGroupLimit: Int
    var hasMore: Bool

    enum CodingKeys: String, CodingKey {
        case color, records, count, offset
        case groupValue = "group_value"
        case groupLabel = "group_label"
        case perGroupLimit = "per_group_limit"
        case hasMore = "has_more"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        groupValue = try container.decodeIfPresent(AnyCodable.self, forKey: .groupValue) ?? AnyCodable(NSNull())
        groupLabel = try container.decodeIfPresent(String.self, forKey: .groupLabel) ?? ""
        color = try container.decodeIfPresent(String.self, forKey: .color)
        records = try container.decodeIfPresent([NativeTabDataRecord].self, forKey: .records) ?? []
        count = (try? container.decodeIfPresent(Int.self, forKey: .count))
            ?? (try? container.decodeIfPresent(String.self, forKey: .count).flatMap(Int.init))
            ?? records.count
        offset = (try? container.decodeIfPresent(Int.self, forKey: .offset))
            ?? (try? container.decodeIfPresent(String.self, forKey: .offset).flatMap(Int.init))
            ?? 0
        perGroupLimit = (try? container.decodeIfPresent(Int.self, forKey: .perGroupLimit))
            ?? (try? container.decodeIfPresent(String.self, forKey: .perGroupLimit).flatMap(Int.init))
            ?? 20
        hasMore = try container.decodeIfPresent(Bool.self, forKey: .hasMore) ?? false
    }

    init(groupLabel: String, records: [NativeTabDataRecord]) {
        self.groupValue = AnyCodable(groupLabel)
        self.groupLabel = groupLabel
        self.color = nil
        self.records = records
        self.count = records.count
        self.offset = 0
        self.perGroupLimit = max(20, records.count)
        self.hasMore = false
    }

    init(groupValue: Any, groupLabel: String) {
        self.groupValue = AnyCodable(groupValue)
        self.groupLabel = groupLabel
        self.color = nil
        self.records = []
        self.count = 0
        self.offset = 0
        self.perGroupLimit = 20
        self.hasMore = false
    }

    func withFallbackLabel(_ fallback: String) -> NativeTabDataRecordGroup {
        guard groupLabel.isEmpty else { return self }
        return NativeTabDataRecordGroup(
            groupValue: groupValue,
            groupLabel: fallback,
            color: color,
            records: records,
            count: count,
            offset: offset,
            perGroupLimit: perGroupLimit,
            hasMore: hasMore
        )
    }

    private init(
        groupValue: AnyCodable,
        groupLabel: String,
        color: String?,
        records: [NativeTabDataRecord],
        count: Int,
        offset: Int,
        perGroupLimit: Int,
        hasMore: Bool
    ) {
        self.groupValue = groupValue
        self.groupLabel = groupLabel
        self.color = color
        self.records = records
        self.count = count
        self.offset = offset
        self.perGroupLimit = perGroupLimit
        self.hasMore = hasMore
    }

    var id: String { offsetKey }
    var offsetKey: String {
        if groupValue.value is NSNull { return "__ungrouped__" }
        let rendered = NativeTabDataDisplayText.make(groupValue)
        return rendered.isEmpty ? "__ungrouped__" : rendered
    }
}

enum NativeTabDataValue: Equatable, Sendable {
    case text(String)
    /// 保留 `-`、`.`、`1.` 等输入中间态；保存前再做十进制校验。
    case number(String)
    case boolean(Bool)
    case selections([String])
    case date(Date?)

    static func parse(_ raw: AnyCodable?, field: NativeTabDataField) -> NativeTabDataValue {
        switch field.fieldType {
        case .checkbox:
            return .boolean(raw?.boolValue ?? false)
        case .number, .currency, .percent, .rating:
            return .number(raw?.stringValue ?? raw?.doubleValue.map { String($0) } ?? "")
        case .select, .singleSelect:
            return .selections(raw.flatMap(Self.stringArray).map { Array($0.prefix(1)) } ?? [])
        case .multiSelect:
            return .selections(raw.flatMap(Self.stringArray) ?? [])
        case .date:
            return .date(raw?.stringValue.flatMap {
                NativeTabDataDateCodec.decodeDate($0, calendar: .current)
            })
        case .user:
            let ids = raw.flatMap(Self.stringArray) ?? []
            return .selections(field.allowsMultipleUsers ? ids : Array(ids.prefix(1)))
        default:
            return .text(NativeTabDataDisplayText.make(raw))
        }
    }

    func wireValue(for fieldKind: NativeTabDataFieldKind, allowsMultiple: Bool = false) -> Any {
        switch self {
        case .text(let value): return value
        case .number(let value):
            guard !value.isEmpty else { return NSNull() }
            guard let decimal = Decimal(string: value) else { return value }
            return NSDecimalNumber(decimal: decimal)
        case .boolean(let value): return value
        case .selections(let values):
            if fieldKind == .multiSelect { return values }
            if fieldKind == .user, allowsMultiple {
                return values.isEmpty ? NSNull() : values
            }
            return values.first ?? NSNull()
        case .date(let value):
            return value.map {
                NativeTabDataDateCodec.encodeDate($0, calendar: .current)
            } ?? NSNull()
        }
    }

    var isValidNumber: Bool {
        guard case .number(let value) = self else { return true }
        return value.isEmpty || Decimal(string: value) != nil
    }

    var displayText: String {
        switch self {
        case .text(let value): value
        case .number(let value): value
        case .boolean(let value): value ? "✓" : ""
        case .selections(let values): values.joined(separator: " · ")
        case .date(let value): value.map(NativeTabDataDateCodec.displayDate) ?? ""
        }
    }

    var personResolverInput: Any {
        switch self {
        case .text(let value): value
        case .selections(let values): values
        default: displayText
        }
    }

    private static func stringArray(_ raw: AnyCodable) -> [String]? {
        if let value = raw.stringValue { return value.isEmpty ? [] : [value] }
        // 单选人员可能存成裸对象 {"id": ..., "name": ...}，后端 UserField.validate 也接受这种形态。
        if let dictionary = raw.dictValue {
            return identifier(in: dictionary).map { [$0] } ?? []
        }
        return raw.arrayValue?.compactMap { item in
            if let value = item as? String { return value }
            guard let dictionary = item as? [String: Any] else { return nil }
            return identifier(in: dictionary)
        }
    }

    private static func identifier(in dictionary: [String: Any]) -> String? {
        dictionary["value"] as? String
            ?? dictionary["id"] as? String
            ?? dictionary["name"] as? String
            ?? dictionary["label"] as? String
    }
}

enum NativeTabDataDisplayText {
    static func make(_ raw: AnyCodable?) -> String {
        guard let raw else { return "" }
        return make(raw.value)
    }

    private static func make(_ value: Any) -> String {
        switch value {
        case is NSNull: return ""
        case let string as String: return string
        case let bool as Bool: return bool ? "✓" : ""
        case let number as NSNumber: return number.stringValue
        case let values as [Any]:
            return values.map(make).filter { !$0.isEmpty }.joined(separator: " · ")
        case let dictionary as [String: Any]:
            for key in ["label", "name", "display_name", "displayName", "title", "value", "url"] {
                if let value = dictionary[key] {
                    let rendered = make(value)
                    if !rendered.isEmpty, !looksLikeInternalId(rendered) { return rendered }
                }
            }
            return ""
        default: return ""
        }
    }

    static func looksLikeInternalId(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.range(
            of: #"^(usr|rec|tbl|viw)-[A-Za-z0-9_-]+$"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil
    }
}

enum NativeTabDataDateCodec {
    static func decodeDate(_ value: String, calendar: Calendar = .current) -> Date? {
        let components = String(value.prefix(10)).split(separator: "-").compactMap { Int($0) }
        guard components.count == 3 else { return nil }
        // 正午可避开绝大多数时区的午夜 DST 缺口，wire 仍只取年月日。
        return calendar.date(from: DateComponents(
            year: components[0],
            month: components[1],
            day: components[2],
            hour: 12
        ))
    }

    static func encodeDate(_ value: Date, calendar: Calendar = .current) -> String {
        let components = calendar.dateComponents([.year, .month, .day], from: value)
        guard let year = components.year, let month = components.month, let day = components.day else {
            return ""
        }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }

    static func displayDate(_ value: Date) -> String {
        value.formatted(date: .abbreviated, time: .omitted)
    }

}

struct NativeTabDataCardField: Equatable, Sendable, Identifiable {
    let fieldId: String
    let label: String
    let value: String
    let members: [NativeTabDataMemberRef]
    var id: String { fieldId }

    init(
        fieldId: String,
        label: String,
        value: String,
        members: [NativeTabDataMemberRef] = []
    ) {
        self.fieldId = fieldId
        self.label = label
        self.value = value
        self.members = members
    }
}

struct NativeTabDataCardProjection: Equatable, Sendable {
    let title: String
    let coverUrl: String?
    let fields: [NativeTabDataCardField]
    let group: String?

    static func make(
        record: NativeTabDataRecord,
        fields: [NativeTabDataField],
        view: NativeTabDataView?,
        untitledTitle: String = L10n.TabData.untitledRecord,
        directory: NativeTabDataMemberDirectory = .empty
    ) -> NativeTabDataCardProjection {
        let orderedFields = NativeTabDataViewProjection.visibleFields(fields: fields, view: view)
        let titleField = NativeTabDataViewProjection.resolveField(key: view?.titleFieldKey, fields: fields)
            ?? orderedFields.first(where: \.isPrimary)
            ?? orderedFields.first
        let title = NativeTabDataTitlePolicy.nonEmpty(
            titleField.map { value(record: record, field: $0, directory: directory) },
            fallback: untitledTitle
        )
        let groupField = NativeTabDataViewProjection.resolveField(key: view?.groupFieldKey, fields: fields)
        let group = groupField.map { value(record: record, field: $0, directory: directory) }.flatMap { $0.isEmpty ? nil : $0 }
        let coverField = resolveCoverField(orderedFields: orderedFields, allFields: fields, view: view)
        let coverUrl = coverField.flatMap { field in
            NativeTabDataCoverPolicy.extractURL(record.fields[field.id] ?? record.fields[field.name])
        }
        // 只排除标题与封面。分组字段照常进摘要，与 mobileTableProjection.ts:84 一致；
        // 多排一层会让同一条记录在 Web 与原生上摘要不是同一组字段，还会白丢一个位置。
        let excludedIds = Set([titleField?.id, coverField?.id].compactMap { $0 })
        let summaries = orderedFields
            .filter { !excludedIds.contains($0.id) }
            .compactMap { field -> NativeTabDataCardField? in
                let raw = record.fields[field.id] ?? record.fields[field.name]
                let parsed = NativeTabDataValue.parse(raw, field: field)
                let rendered = field.displayText(for: parsed, raw: raw, directory: directory)
                guard !rendered.isEmpty else { return nil }
                return NativeTabDataCardField(
                    fieldId: field.id,
                    label: field.name,
                    value: rendered,
                    members: field.resolvedMembers(from: raw, value: parsed, directory: directory)
                )
            }
            .prefix(4)
        return NativeTabDataCardProjection(
            title: title,
            coverUrl: coverUrl,
            fields: Array(summaries),
            group: group
        )
    }

    /// 配置的封面字段仍要过类型闸门。Web 会把任意配置字段的字符串值直接当图片地址取用，
    /// 于是一处 url 字段配置就能让卡片去拉任意外链；这里与 Android 一样只认附件与媒体。
    private static func resolveCoverField(
        orderedFields: [NativeTabDataField],
        allFields: [NativeTabDataField],
        view: NativeTabDataView?
    ) -> NativeTabDataField? {
        let configured = NativeTabDataViewProjection.resolveField(key: view?.coverFieldKey, fields: allFields)
        if let configured {
            return canBeCover(configured) ? configured : nil
        }
        return orderedFields.first(where: canBeCover)
    }

    private static func canBeCover(_ field: NativeTabDataField) -> Bool {
        field.fieldType == .attachment
    }

    private static func value(
        record: NativeTabDataRecord,
        field: NativeTabDataField,
        directory: NativeTabDataMemberDirectory
    ) -> String {
        let raw = record.fields[field.id] ?? record.fields[field.name]
        return field.displayText(
            for: NativeTabDataValue.parse(raw, field: field),
            raw: raw,
            directory: directory
        )
    }
}

/// 从附件值里取封面地址。逐条对齐 Web 正典 mobileTablePrimitives.ts 的
/// extractMobileCoverUrl：缩略图优先于原图，非图片 mime 且文件名也不像图片就整项跳过。
/// 不能走 NativeTabDataValue.parse——那条路会把附件渲染成文件名，拿不到地址。
enum NativeTabDataCoverPolicy {
    private static let imageExtension = try? NSRegularExpression(
        pattern: #"\.(png|jpe?g|gif|webp|bmp|svg|avif)(?:$|[?#])"#,
        options: .caseInsensitive
    )
    private static let thumbnailKeys = ["thumbnail_url", "thumbnailUrl", "lgThumbnailUrl", "smThumbnailUrl"]
    private static let urlKeys = ["preview_url", "previewUrl", "url", "access_url", "accessUrl"]
    private static let nameKeys = ["name", "file_name", "fileName", "filename"]

    static func extractURL(_ raw: AnyCodable?) -> String? {
        guard let raw else { return nil }
        return extractURL(from: raw.value)
    }

    private static func extractURL(from value: Any) -> String? {
        if let text = nonEmpty(value as? String) { return text }

        let items: [Any]
        if let array = value as? [Any] {
            items = array
        } else if value is NSNull {
            items = []
        } else {
            items = [value]
        }

        for item in items {
            if let text = nonEmpty(item as? String) { return text }
            guard let object = item as? [String: Any] else { continue }
            if let thumbnail = readString(object, thumbnailKeys) { return thumbnail }
            let mime = (readString(object, ["mime_type", "mimeType"]) ?? "").lowercased()
            let name = readString(object, nameKeys) ?? ""
            if !mime.isEmpty, !mime.hasPrefix("image/"), !looksLikeImageName(name) { continue }
            if let url = readString(object, urlKeys) { return url }
        }
        return nil
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    private static func readString(_ object: [String: Any], _ keys: [String]) -> String? {
        for key in keys {
            if let text = nonEmpty(object[key] as? String) { return text }
        }
        return nil
    }

    private static func looksLikeImageName(_ name: String) -> Bool {
        guard let imageExtension, !name.isEmpty else { return false }
        let range = NSRange(name.startIndex..<name.endIndex, in: name)
        return imageExtension.firstMatch(in: name, options: [], range: range) != nil
    }
}

enum NativeTabDataTitlePolicy {
    static func nonEmpty(_ preferred: String?, fallback: String) -> String {
        let preferred = preferred?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !preferred.isEmpty { return preferred }
        let fallback = fallback.trimmingCharacters(in: .whitespacesAndNewlines)
        return fallback.isEmpty ? "-" : fallback
    }
}

enum NativeTabDataViewSelection {
    static func preferredViewId(
        current: String?,
        defaultViewId: String?,
        views: [NativeTabDataView]
    ) -> String? {
        if let current, views.contains(where: { $0.id == current }) { return current }
        if let defaultViewId, views.contains(where: { $0.id == defaultViewId }) { return defaultViewId }
        return views.first?.id
    }
}

enum NativeTabDataGroupPagination {
    static func nextOffset(for group: NativeTabDataRecordGroup) -> Int {
        group.offset + max(1, group.records.count)
    }
}

enum NativeTabDataViewProjection {
    static func visibleFields(fields: [NativeTabDataField], view: NativeTabDataView?) -> [NativeTabDataField] {
        // order 相同时保留后端数组顺序。后端本就 order_by('order') 下发，重复 order 很常见；
        // 按字段名裁决平局会让同一张表在 iOS 上按中文名重排，与 Web 正典
        // （mobileTablePrimitives.ts:139 resolveFieldOrder 无 column_meta/field_order 时原样返回）
        // 和 Android 都对不上。Swift 的 sorted(by:) 不保证稳定，只能显式带下标。
        let sorted = fields.enumerated()
            .sorted { lhs, rhs in
                lhs.element.order == rhs.element.order
                    ? lhs.offset < rhs.offset
                    : lhs.element.order < rhs.element.order
            }
            .map(\.element)
        guard let view else { return sorted.filter { !$0.isHidden } }
        let byId = Dictionary(uniqueKeysWithValues: fields.map { ($0.id, $0) })
        let byName = Dictionary(uniqueKeysWithValues: fields.map { ($0.name, $0) })
        let configuredOrder = view.fieldOrder.isEmpty ? sorted.map(\.id) : view.fieldOrder
        var projected = configuredOrder.compactMap { byId[$0] ?? byName[$0] }
        for field in sorted where !projected.contains(where: { $0.id == field.id }) {
            projected.append(field)
        }
        let allowed = Set(view.visibleFields)
        return projected.filter { field in
            if !allowed.isEmpty { return allowed.contains(field.id) || allowed.contains(field.name) }
            if let meta = view.columnMeta[field.id]?.dictValue ?? view.columnMeta[field.name]?.dictValue {
                if meta["hidden"] as? Bool == true { return false }
                if let visible = meta["visible"] as? Bool { return visible }
            }
            return !field.isHidden
        }
    }

    static func resolveField(key: String?, fields: [NativeTabDataField]) -> NativeTabDataField? {
        guard let key else { return nil }
        return fields.first { $0.id == key || $0.name == key }
    }
}

struct NativeTabDataFilterRule: Equatable, Sendable {
    let fieldId: String
    let operatorName: String
    let value: String

    var jsonObject: [String: Any] {
        ["field_id": fieldId, "operator": operatorName, "value": value, "enabled": true]
    }
}

enum NativeTabDataFilterLogic: String, Equatable, Sendable {
    case and
    case or
}

struct NativeTabDataSortRule: Equatable, Sendable {
    let fieldId: String
    let descending: Bool

    var jsonObject: [String: Any] {
        ["field_id": fieldId, "direction": descending ? "desc" : "asc"]
    }
}

enum NativeTabDataQueryCodec {
    static func json(_ value: Any) -> String? {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value)
        else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

struct NativeTabDataRecordDraft: Codable, Equatable, Sendable {
    let recordId: String
    let tableId: String
    let organizationId: String
    private(set) var baseVersion: Int64
    private(set) var values: [String: NativeTabDataDraftValue]
    private(set) var fieldKinds: [String: String]
    private(set) var fieldAllowsMultiple: [String: Bool]
    /// 编辑当时的字段名。schema 刷新后被删字段已不在新 `fields` 里，
    /// 告知用户时只能靠这份快照（或刷新前的旧 fields）。
    /// 老草稿没有这个键，`decodeIfPresent` 回落空表，不能解码失败。
    private(set) var fieldNames: [String: String]
    private(set) var dirtyFieldIds: Set<String>
    /// 用户开始编辑时的远端值。编辑只改 `values`，冲突检测用这份基线。
    /// 老草稿解不出时为 nil，提交时不带 `base_snapshot`。
    private(set) var baseValues: [String: NativeTabDataDraftValue]?
    /// 创建期预填的原始 JSON（按字段 id）。附件 / 关联记录在移动端不能进
    /// `NativeTabDataValue`，但提交时仍要带上，否则新记录不满足当前视图筛选。
    private(set) var creationPrefill: [String: AnyCodable]

    enum CodingKeys: String, CodingKey {
        case recordId, tableId, organizationId, baseVersion, values, fieldKinds, dirtyFieldIds
        case fieldAllowsMultiple
        case fieldNames
        case baseValues
        case creationPrefill
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        recordId = try container.decode(String.self, forKey: .recordId)
        tableId = try container.decode(String.self, forKey: .tableId)
        organizationId = try container.decode(String.self, forKey: .organizationId)
        baseVersion = try container.decode(Int64.self, forKey: .baseVersion)
        values = try container.decode([String: NativeTabDataDraftValue].self, forKey: .values)
        fieldKinds = try container.decode([String: String].self, forKey: .fieldKinds)
        dirtyFieldIds = try container.decode(Set<String>.self, forKey: .dirtyFieldIds)
        fieldAllowsMultiple = try container.decodeIfPresent([String: Bool].self, forKey: .fieldAllowsMultiple) ?? [:]
        fieldNames = try container.decodeIfPresent([String: String].self, forKey: .fieldNames) ?? [:]
        baseValues = try container.decodeIfPresent([String: NativeTabDataDraftValue].self, forKey: .baseValues)
        creationPrefill = try container.decodeIfPresent([String: AnyCodable].self, forKey: .creationPrefill) ?? [:]
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(recordId, forKey: .recordId)
        try container.encode(tableId, forKey: .tableId)
        try container.encode(organizationId, forKey: .organizationId)
        try container.encode(baseVersion, forKey: .baseVersion)
        try container.encode(values, forKey: .values)
        try container.encode(fieldKinds, forKey: .fieldKinds)
        try container.encode(dirtyFieldIds, forKey: .dirtyFieldIds)
        try container.encode(fieldAllowsMultiple, forKey: .fieldAllowsMultiple)
        try container.encode(fieldNames, forKey: .fieldNames)
        try container.encodeIfPresent(baseValues, forKey: .baseValues)
        try container.encode(creationPrefill, forKey: .creationPrefill)
    }

    init(
        record: NativeTabDataRecord,
        tableId: String,
        organizationId: String,
        fields: [NativeTabDataField]
    ) {
        recordId = record.id
        self.tableId = tableId
        self.organizationId = organizationId
        baseVersion = record.version
        values = Dictionary(uniqueKeysWithValues: fields.filter { $0.fieldType.isEditable }.map { field in
            (field.id, NativeTabDataDraftValue(NativeTabDataValue.parse(record.fields[field.id] ?? record.fields[field.name], field: field)))
        })
        fieldKinds = Dictionary(uniqueKeysWithValues: fields.map { ($0.id, $0.fieldType.rawValue) })
        fieldAllowsMultiple = Dictionary(uniqueKeysWithValues: fields.map { ($0.id, $0.allowsMultipleUsers) })
        fieldNames = Dictionary(uniqueKeysWithValues: fields.map { ($0.id, $0.name) })
        dirtyFieldIds = []
        baseValues = values
        creationPrefill = [:]
    }

    mutating func set(_ value: NativeTabDataValue, for field: NativeTabDataField) {
        guard field.fieldType.isEditable else { return }
        let next = NativeTabDataDraftValue(value)
        values[field.id] = next
        fieldKinds[field.id] = field.fieldType.rawValue
        fieldAllowsMultiple[field.id] = field.allowsMultipleUsers
        fieldNames[field.id] = field.name
        // 有基线就按值比较：改回打开时的值等于没改过。老草稿没有
        // `baseValues`，退回「碰过就算脏」，避免解不出基线时误把未保存改动清掉。
        if let baseline = baseValues, baseline[field.id] == next {
            dirtyFieldIds.remove(field.id)
        } else {
            dirtyFieldIds.insert(field.id)
        }
    }

    /// 把视图预填写进草稿。已有未提交脏字段不覆盖。可编辑字段同时写入
    /// `values` 并标脏，这样 `covers` 会命中预填而不是回落空远端值。
    /// 附件 / 关联记录只进 `creationPrefill`，提交时原样带上。
    mutating func seedPrefill(_ rawValues: [String: Any], fields: [NativeTabDataField]) {
        for field in fields {
            guard let raw = rawValues[field.name], !(raw is NSNull) else { continue }
            if creationPrefill[field.id] == nil {
                creationPrefill[field.id] = AnyCodable(raw)
            }
            guard field.fieldType.isEditable else { continue }
            guard !dirtyFieldIds.contains(field.id) else { continue }
            values[field.id] = NativeTabDataDraftValue(NativeTabDataValue.parse(AnyCodable(raw), field: field))
            fieldKinds[field.id] = field.fieldType.rawValue
            fieldAllowsMultiple[field.id] = field.allowsMultipleUsers
            fieldNames[field.id] = field.name
            dirtyFieldIds.insert(field.id)
        }
    }

    var canSubmit: Bool {
        !dirtyFieldIds.isEmpty || (isCreation && !creationPrefill.isEmpty)
    }

    func creationRecordFields(fields: [NativeTabDataField]) -> [String: AnyCodable] {
        let byId = Dictionary(uniqueKeysWithValues: fields.map { ($0.id, $0) })
        var result: [String: AnyCodable] = [:]
        for (fieldId, value) in creationPrefill {
            result[fieldId] = value
            if let field = byId[fieldId] {
                result[field.name] = value
            }
        }
        return result
    }

    func value(for field: NativeTabDataField) -> NativeTabDataValue {
        values[field.id]?.value ?? NativeTabDataValue.parse(nil, field: field)
    }

    /// 草稿是否持有该字段。落盘的旧草稿只覆盖当时可编辑的字段类型，之后放开的类型
    /// （如日期）在旧草稿里没有键；调用方必须据此回落到远端值，否则会把「草稿没记」
    /// 显示成「值被清空」。
    func covers(_ field: NativeTabDataField) -> Bool {
        values[field.id] != nil
    }

    func updateBody() -> [String: Any] {
        ["fields": changedWireValues, "fieldKeyType": "id"]
    }

    func bulkUpdateItem() -> [String: Any] {
        var item: [String: Any] = [
            "record_id": recordId,
            "data": changedWireValues,
        ]
        if let snapshot = baselineSnapshot, !snapshot.isEmpty {
            item["base_snapshot"] = snapshot
        }
        return item
    }

    func bulkUpdateBody(operationGroupId: String = UUID().uuidString) -> [String: Any] {
        [
            "updates": [bulkUpdateItem()],
            "operation_group_id": operationGroupId,
        ]
    }

    func createBody() -> [String: Any] {
        var payload = creationPrefill.reduce(into: [String: Any]()) { result, item in
            if !(item.value.value is NSNull) {
                result[item.key] = item.value.value
            }
        }
        for (fieldId, value) in changedWireValues {
            payload[fieldId] = value
        }
        return ["table_id": tableId, "fields": payload, "fieldKeyType": "id"]
    }

    var hasInvalidValues: Bool {
        dirtyFieldIds.contains { fieldId in
            guard let value = values[fieldId]?.value else { return false }
            return !value.isValidNumber
        }
    }

    var isCreation: Bool { baseVersion == 0 }

    func readOnlySnapshot(
        fields: [NativeTabDataField],
        directory: NativeTabDataMemberDirectory = .empty
    ) -> NativeTabDataLocalDraftSnapshot {
        let currentFields = Dictionary(uniqueKeysWithValues: fields.map { ($0.id, $0) })
        let projectedFields = dirtyFieldIds
            .sorted { lhs, rhs in
                let lhsOrder = currentFields[lhs]?.order ?? Int.max
                let rhsOrder = currentFields[rhs]?.order ?? Int.max
                return lhsOrder == rhsOrder ? lhs < rhs : lhsOrder < rhsOrder
            }
            .map { fieldId in
                let field = currentFields[fieldId]
                let value = values[fieldId]?.value
                let rendered = field.flatMap { field in
                    value.map { field.displayText(for: $0, directory: directory) }
                } ?? value?.displayText ?? ""
                return NativeTabDataLocalDraftField(
                    id: fieldId,
                    label: field?.name ?? fieldId,
                    value: rendered
                )
            }
        return NativeTabDataLocalDraftSnapshot(
            recordId: recordId,
            isCreation: isCreation,
            fields: projectedFields
        )
    }

    /// 脏字段是否仍在且类型未变。只是判定，不再决定整份草稿进冲突：
    /// 不兼容的字段由 Session 按 id 剔除，其余改动继续可提交。
    func isCompatible(with fields: [NativeTabDataField]) -> Bool {
        let currentKinds = Dictionary(uniqueKeysWithValues: fields.map { ($0.id, $0.fieldType.rawValue) })
        return dirtyFieldIds.allSatisfy { fieldId in
            guard let originalKind = fieldKinds[fieldId] else { return false }
            return currentKinds[fieldId] == originalKind
        }
    }

    /// 被删或类型对不上的脏字段不再参与提交，也不能挡住其余字段。
    mutating func dropFields(_ fieldIds: Set<String>) {
        guard !fieldIds.isEmpty else { return }
        for fieldId in fieldIds {
            values.removeValue(forKey: fieldId)
            fieldKinds.removeValue(forKey: fieldId)
            fieldAllowsMultiple.removeValue(forKey: fieldId)
            fieldNames.removeValue(forKey: fieldId)
            dirtyFieldIds.remove(fieldId)
            creationPrefill.removeValue(forKey: fieldId)
            baseValues?.removeValue(forKey: fieldId)
        }
    }

    /// 保存期间若又出现编辑，只保留相对已提交快照真正新增的变化，并基于新版本继续保存。
    func rebased(
        after submitted: NativeTabDataRecordDraft,
        onto updated: NativeTabDataRecord,
        fields: [NativeTabDataField],
        recordId: String? = nil
    ) -> NativeTabDataRecordDraft? {
        let rebasedRecord = NativeTabDataRecord(
            id: recordId ?? updated.id,
            tableId: updated.tableId ?? tableId,
            fields: updated.fields,
            version: updated.version
        )
        var rebased = NativeTabDataRecordDraft(
            record: rebasedRecord,
            tableId: tableId,
            organizationId: organizationId,
            fields: fields
        )
        for field in fields where dirtyFieldIds.contains(field.id) {
            guard let current = values[field.id], current != submitted.values[field.id] else { continue }
            rebased.set(current.value, for: field)
        }
        return rebased.dirtyFieldIds.isEmpty ? nil : rebased
    }

    private var changedWireValues: [String: Any] {
        wireValues(from: values, fieldIds: dirtyFieldIds)
    }

    private var baselineSnapshot: [String: Any]? {
        guard let baseValues else { return nil }
        return wireValues(from: baseValues, fieldIds: dirtyFieldIds)
    }

    private func wireValues(
        from source: [String: NativeTabDataDraftValue],
        fieldIds: Set<String>
    ) -> [String: Any] {
        Dictionary(uniqueKeysWithValues: fieldIds.compactMap { fieldId in
            guard let value = source[fieldId]?.value else { return nil }
            let kind = fieldKinds[fieldId].flatMap(NativeTabDataFieldKind.init(rawValue:)) ?? .unknown
            return (
                fieldId,
                value.wireValue(
                    for: kind,
                    allowsMultiple: fieldAllowsMultiple[fieldId] ?? (kind == .multiSelect)
                )
            )
        })
    }
}

struct NativeTabDataLocalDraftField: Identifiable, Equatable, Sendable {
    let id: String
    let label: String
    let value: String
}

struct NativeTabDataLocalDraftSnapshot: Identifiable, Equatable, Sendable {
    let recordId: String
    let isCreation: Bool
    let fields: [NativeTabDataLocalDraftField]

    var id: String { recordId }

    var copyText: String {
        fields.map { "\($0.label): \($0.value)" }.joined(separator: "\n")
    }
}

struct NativeTabDataDeleteRequest: Equatable, Sendable {
    let recordId: String
    let expectedVersion: Int64

    var query: [String: String] {
        ["expected_version": String(expectedVersion)]
    }
}

struct NativeTabDataDraftValue: Codable, Equatable, Sendable {
    private let type: String
    private let text: String?
    private let numberText: String?
    private let boolean: Bool?
    private let selections: [String]?
    private let date: Date?

    init(_ value: NativeTabDataValue) {
        switch value {
        case .text(let value):
            type = "text"; text = value; numberText = nil; boolean = nil; selections = nil; date = nil
        case .number(let value):
            type = "number"; text = nil; numberText = value; boolean = nil; selections = nil; date = nil
        case .boolean(let value):
            type = "boolean"; text = nil; numberText = nil; boolean = value; selections = nil; date = nil
        case .selections(let value):
            type = "selections"; text = nil; numberText = nil; boolean = nil; selections = value; date = nil
        case .date(let value):
            type = "date"; text = nil; numberText = nil; boolean = nil; selections = nil; date = value
        }
    }

    var value: NativeTabDataValue {
        switch type {
        case "number": .number(numberText ?? "")
        case "boolean": .boolean(boolean ?? false)
        case "selections": .selections(selections ?? [])
        case "date": .date(date)
        default: .text(text ?? "")
        }
    }
}

struct NativeTabDataDraftStore {
    private let store: UserDefaults
    private static let prefix = "native_tabdata_draft_v1"

    init(store: UserDefaults = .standard) { self.store = store }

    func save(_ draft: NativeTabDataRecordDraft, userId: String) throws {
        store.set(
            try JSONEncoder().encode(draft),
            forKey: key(
                draft.recordId,
                tableId: draft.tableId,
                userId: userId,
                organizationId: draft.organizationId
            )
        )
    }

    func load(
        recordId: String,
        tableId: String,
        userId: String,
        organizationId: String
    ) -> NativeTabDataRecordDraft? {
        guard let data = store.data(forKey: key(
            recordId,
            tableId: tableId,
            userId: userId,
            organizationId: organizationId
        )) else { return nil }
        return try? JSONDecoder().decode(NativeTabDataRecordDraft.self, from: data)
    }

    func remove(
        recordId: String,
        tableId: String,
        userId: String,
        organizationId: String
    ) {
        store.removeObject(forKey: key(
            recordId,
            tableId: tableId,
            userId: userId,
            organizationId: organizationId
        ))
    }

    func removeAll(tableId: String? = nil, userId: String? = nil, organizationId: String? = nil) {
        let userPrefix = userId.map { "\(Self.prefix).\(Self.component($0))." }
        for (key, value) in store.dictionaryRepresentation() {
            guard key.hasPrefix("\(Self.prefix)."), let data = value as? Data,
                  let draft = try? JSONDecoder().decode(NativeTabDataRecordDraft.self, from: data),
                  tableId == nil || draft.tableId == tableId,
                  organizationId == nil || draft.organizationId == organizationId,
                  userPrefix.map({ key.hasPrefix($0) }) ?? true
            else { continue }
            store.removeObject(forKey: key)
        }
    }

    func loadAll(
        tableId: String,
        userId: String,
        organizationId: String
    ) -> [NativeTabDataRecordDraft] {
        let prefix = "\(Self.prefix).\(Self.component(userId)).\(Self.component(organizationId)).\(Self.component(tableId))."
        return store.dictionaryRepresentation().compactMap { key, value in
            guard key.hasPrefix(prefix), let data = value as? Data else { return nil }
            return try? JSONDecoder().decode(NativeTabDataRecordDraft.self, from: data)
        }
    }

    func hasDraft(tableId: String, userId: String, organizationId: String) -> Bool {
        !loadAll(tableId: tableId, userId: userId, organizationId: organizationId).isEmpty
    }

    private func key(
        _ recordId: String,
        tableId: String,
        userId: String,
        organizationId: String
    ) -> String {
        [Self.prefix, userId, organizationId, tableId, recordId]
            .enumerated()
            .map { index, value in index == 0 ? value : Self.component(value) }
            .joined(separator: ".")
    }

    private static func component(_ value: String) -> String {
        Data(value.utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "=", with: "")
    }
}

enum NativeTabDataSaveFailure: Equatable, Sendable {
    case conflict
    case permissionDenied
    case resourceGone
    case retryable
    case terminal
}

enum NativeTabDataSaveFailurePolicy {
    static func resolve(_ error: Error) -> NativeTabDataSaveFailure {
        if case APIError.serverError(let status, _) = error {
            if status == 409 { return .conflict }
            if status == 403 { return .permissionDenied }
            if status == 404 { return .resourceGone }
            if (400..<500).contains(status) { return .terminal }
        }
        return .retryable
    }

    static func requiresMetadataRevalidationAfterWriteFailure(_ error: Error) -> Bool {
        let failure = resolve(error)
        return failure == .permissionDenied || failure == .resourceGone
    }

    static func mustPurgeProtectedDataAfterReadFailure(_ error: Error) -> Bool {
        requiresMetadataRevalidationAfterWriteFailure(error)
    }
}

enum NativeTabDataWritePolicy {
    /// `is_locked` 只锁共享视图配置；记录写入仍由表级角色与资源权限决定。
    /// 会话级 `.conflict` 只留给响应不可信等整表锁；字段被删/改类型改为按字段剔除。
    static func canEditRecords(tableCanEdit: Bool, saveState: NativeTabDataSaveState) -> Bool {
        tableCanEdit && saveState != .conflict && saveState != .permissionDenied
    }

}

struct NativeTabDataBulkUpdateConflict: Decodable, Equatable, Sendable {
    let recordId: String
    let fieldId: String
    let yourValue: AnyCodable?
    let serverValue: AnyCodable?

    enum CodingKeys: String, CodingKey {
        case recordId = "record_id"
        case fieldId = "field_id"
        case yourValue = "your_value"
        case serverValue = "server_value"
    }

    init(
        recordId: String,
        fieldId: String,
        yourValue: AnyCodable? = nil,
        serverValue: AnyCodable? = nil
    ) {
        self.recordId = recordId
        self.fieldId = fieldId
        self.yourValue = yourValue
        self.serverValue = serverValue
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        recordId = try container.decodeIfPresent(String.self, forKey: .recordId) ?? ""
        fieldId = try container.decodeIfPresent(String.self, forKey: .fieldId) ?? ""
        yourValue = try container.decodeIfPresent(AnyCodable.self, forKey: .yourValue)
        serverValue = try container.decodeIfPresent(AnyCodable.self, forKey: .serverValue)
    }
}

struct NativeTabDataBulkUpdateResponse: Decodable, Sendable {
    let records: [NativeTabDataRecord]
    let conflicts: [NativeTabDataBulkUpdateConflict]
    let errors: [AnyCodable]

    enum CodingKeys: String, CodingKey {
        case records, conflicts, errors
    }

    var hasErrors: Bool { !errors.isEmpty }

    init(
        records: [NativeTabDataRecord],
        conflicts: [NativeTabDataBulkUpdateConflict] = [],
        errors: [AnyCodable] = []
    ) {
        self.records = records
        self.conflicts = conflicts
        self.errors = errors
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        records = try container.decodeIfPresent([NativeTabDataRecord].self, forKey: .records) ?? []
        conflicts = try container.decodeIfPresent([NativeTabDataBulkUpdateConflict].self, forKey: .conflicts) ?? []
        errors = try container.decodeIfPresent([AnyCodable].self, forKey: .errors) ?? []
    }
}

struct NativeTabDataRecordUpdateResult: Equatable, Sendable {
    let record: NativeTabDataRecord
    let conflicts: [NativeTabDataBulkUpdateConflict]

    init(record: NativeTabDataRecord, conflicts: [NativeTabDataBulkUpdateConflict] = []) {
        self.record = record
        self.conflicts = conflicts
    }
}

enum NativeTabDataDroppedFieldPolicy {
    struct Rebase: Equatable, Sendable {
        var draft: NativeTabDataRecordDraft
        var droppedFieldIds: Set<String>
        var droppedFieldNames: [String]
    }

    /// 被删或类型对不上的脏字段从草稿剔除；名字回落顺序：
    /// 刷新前的 fields → 草稿里记下的名字 → 新 fields（改类型时字段还在）→ 字段 id。
    /// 不区分「删除」和「改类型」，文案用中性说法。
    static func rebase(
        draft: NativeTabDataRecordDraft,
        previousFields: [NativeTabDataField],
        nextFields: [NativeTabDataField]
    ) -> Rebase {
        let plan = NativeTabDataRealtimePolicy.planSchemaDraft(draft: draft, fields: nextFields)
        guard !plan.orphanedDirtyFieldIds.isEmpty else {
            return Rebase(draft: draft, droppedFieldIds: [], droppedFieldNames: [])
        }
        let names = displayNames(
            fieldIds: plan.orphanedDirtyFieldIds,
            previousFields: previousFields,
            nextFields: nextFields,
            draftNames: draft.fieldNames
        )
        var next = draft
        next.dropFields(plan.orphanedDirtyFieldIds)
        return Rebase(
            draft: next,
            droppedFieldIds: plan.orphanedDirtyFieldIds,
            droppedFieldNames: names
        )
    }

    static func message(fieldNames: [String]) -> String {
        let names = uniquePreservingOrder(fieldNames.filter { !$0.isEmpty })
        guard !names.isEmpty else { return L10n.TabData.remoteSchemaUpdated }
        if names.count == 1 {
            return L10n.TabData.droppedField(names[0])
        }
        return L10n.TabData.droppedFields(names[0], names.count)
    }

    /// 结构刷新完成后一次性择一：有剔除就点名，没有且这次来自结构事件才说「表结构已更新」。
    /// 普通刷新把 `announceSchemaUpdate` 关掉，避免误报。
    static func schemaRefreshNotice(
        droppedFieldNames: [String],
        announceSchemaUpdate: Bool
    ) -> String? {
        let names = uniquePreservingOrder(droppedFieldNames.filter { !$0.isEmpty })
        if !names.isEmpty {
            return message(fieldNames: names)
        }
        return announceSchemaUpdate ? L10n.TabData.remoteSchemaUpdated : nil
    }

    static func displayNames(
        fieldIds: Set<String>,
        previousFields: [NativeTabDataField],
        nextFields: [NativeTabDataField],
        draftNames: [String: String]
    ) -> [String] {
        let previousOrder = Dictionary(uniqueKeysWithValues: previousFields.map { ($0.id, $0.order) })
        let previousIndex = Dictionary(uniqueKeysWithValues: previousFields.enumerated().map { ($0.element.id, $0.offset) })
        let orderedIds = fieldIds.sorted { lhs, rhs in
            let lhsOrder = previousOrder[lhs] ?? Int.max
            let rhsOrder = previousOrder[rhs] ?? Int.max
            if lhsOrder != rhsOrder { return lhsOrder < rhsOrder }
            let lhsIndex = previousIndex[lhs] ?? Int.max
            let rhsIndex = previousIndex[rhs] ?? Int.max
            if lhsIndex != rhsIndex { return lhsIndex < rhsIndex }
            return lhs < rhs
        }
        return uniquePreservingOrder(orderedIds.map { fieldId in
            displayName(
                fieldId: fieldId,
                previousFields: previousFields,
                nextFields: nextFields,
                draftNames: draftNames
            )
        })
    }

    static func displayName(
        fieldId: String,
        previousFields: [NativeTabDataField],
        nextFields: [NativeTabDataField],
        draftNames: [String: String]
    ) -> String {
        if let name = previousFields.first(where: { $0.id == fieldId })?.name, !name.isEmpty {
            return name
        }
        if let name = draftNames[fieldId], !name.isEmpty {
            return name
        }
        if let name = nextFields.first(where: { $0.id == fieldId })?.name, !name.isEmpty {
            return name
        }
        return fieldId
    }

    private static func uniquePreservingOrder(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { value in
            guard !value.isEmpty, !seen.contains(value) else { return false }
            seen.insert(value)
            return true
        }
    }
}

enum NativeTabDataAdvisoryConflictPolicy {
    static let namedFieldLimit = 2

    static func message(
        conflicts: [NativeTabDataBulkUpdateConflict],
        fields: [NativeTabDataField]
    ) -> String {
        message(fieldNames: fieldNames(from: conflicts, fields: fields))
    }

    static func message(fieldNames: [String]) -> String {
        let names = uniquePreservingOrder(fieldNames.filter { !$0.isEmpty })
        guard !names.isEmpty else { return L10n.TabData.advisoryConflictUnknown }
        if names.count == 1 {
            return L10n.TabData.advisoryConflict(names[0])
        }
        // 引号与分隔符都得走资源：中文连写「甲」「乙」，英文要 "A", "B"。
        let shown = names
            .prefix(namedFieldLimit)
            .map { L10n.TabData.fieldNameQuoted($0) }
            .joined(separator: L10n.TabData.fieldNameSeparator)
        if names.count <= namedFieldLimit {
            return L10n.TabData.advisoryConflictList(shown)
        }
        return L10n.TabData.advisoryConflictOverflow(shown, names.count)
    }

    static func fieldNames(
        from conflicts: [NativeTabDataBulkUpdateConflict],
        fields: [NativeTabDataField]
    ) -> [String] {
        let byId = Dictionary(uniqueKeysWithValues: fields.map { ($0.id, $0.name) })
        return uniquePreservingOrder(conflicts.map { conflict in
            let name = byId[conflict.fieldId] ?? ""
            return name.isEmpty ? conflict.fieldId : name
        })
    }

    private static func uniquePreservingOrder(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { value in
            guard !value.isEmpty, !seen.contains(value) else { return false }
            seen.insert(value)
            return true
        }
    }
}

enum NativeTabDataCreationEntry: Equatable, Sendable {
    case create
    case viewLocalDraft
    case hidden
}

enum NativeTabDataCreationEntryPolicy {
    static func resolve(canEdit: Bool, hasResumableCreationDraft: Bool) -> NativeTabDataCreationEntry {
        if canEdit { return .create }
        if hasResumableCreationDraft { return .viewLocalDraft }
        return .hidden
    }
}

/// 查询与写操作共享同一代际。开始写入会立即废弃此前所有 GET，写入完成后再次推进
/// 代际，保证迟到响应既不能复活删除记录，也不能用旧快照覆盖保存结果。
struct NativeTabDataOperationGate: Sendable {
    struct Token: Equatable, Sendable {
        fileprivate let generation: UInt64
        fileprivate let kind: Kind
    }

    fileprivate enum Kind: Equatable, Sendable {
        case query
        case mutation
    }

    private var generation: UInt64 = 0
    private(set) var isMutationInFlight = false

    mutating func beginReplacingQuery() -> Token? {
        guard !isMutationInFlight else { return nil }
        generation &+= 1
        return Token(generation: generation, kind: .query)
    }

    mutating func beginIndependentQuery() -> Token? {
        guard !isMutationInFlight else { return nil }
        return Token(generation: generation, kind: .query)
    }

    func currentQuery() -> Token? {
        guard !isMutationInFlight else { return nil }
        return Token(generation: generation, kind: .query)
    }

    mutating func beginMutation() -> Token? {
        guard !isMutationInFlight else { return nil }
        generation &+= 1
        isMutationInFlight = true
        return Token(generation: generation, kind: .mutation)
    }

    mutating func finishMutation(_ token: Token) {
        guard accepts(token), token.kind == .mutation else { return }
        generation &+= 1
        isMutationInFlight = false
    }

    mutating func invalidate() {
        generation &+= 1
        isMutationInFlight = false
    }

    func accepts(_ token: Token) -> Bool {
        token.generation == generation
            && (token.kind != .mutation || isMutationInFlight)
    }
}

enum NativeTabDataFullEditorPreparation: Equatable, Sendable {
    case open
    case confirmDiscard
    case waitForSave
}

enum NativeTabDataFullEditorPolicy {
    static func preparation(
        hasDirtyDrafts: Bool,
        saveState: NativeTabDataSaveState
    ) -> NativeTabDataFullEditorPreparation {
        if saveState == .saving { return .waitForSave }
        if hasDirtyDrafts || saveState == .conflict { return .confirmDiscard }
        return .open
    }

    static func canOpen(hasDirtyDrafts: Bool, saveState: NativeTabDataSaveState) -> Bool {
        preparation(hasDirtyDrafts: hasDirtyDrafts, saveState: saveState) == .open
    }

    static func canSaveCurrentDraft(
        hasDirtyFields: Bool,
        canEdit: Bool,
        saveState: NativeTabDataSaveState
    ) -> Bool {
        hasDirtyFields
            && canEdit
            && saveState != .saving
            && saveState != .conflict
            && saveState != .permissionDenied
    }
}
