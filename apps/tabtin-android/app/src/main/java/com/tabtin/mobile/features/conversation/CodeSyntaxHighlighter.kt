package com.tabtin.mobile.features.conversation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontStyle

/**
 * 轻量级正则语法高亮器，用于 chat 代码块对齐 Electron / iOS。
 *
 * 设计取舍：
 * - iOS 用 Highlightr（highlight.js, ~180 语言）。Android 这边没有等价的成熟原生
 *   Compose 库，主流路线是 Prism4j（仍是 SpannableString 体系，要再桥到 Compose）
 *   或 dev.snipme:highlights（KMP，但语言覆盖有限且要新增依赖）。
 * - 选择自实现一个最小可用的 token 高亮器：
 *   1) 零新增依赖（Wave 2 不引入第三方维护风险）；
 *   2) 颜色直接对齐 atom-one-dark/light（与 iOS Highlightr 默认主题相同）；
 *   3) 覆盖 Wave 2 协议要求的 11 种核心语言 + 常见别名，未识别语言降级为
 *      纯等宽无色（与 iOS supportedLanguage 行为一致）。
 *
 * 不在范围：
 * - 字符串里的转义、模板字面量插值；
 * - JSX/TSX 标签着色（按 ts/js 兜底）；
 * - 复杂语法（如 Rust lifetime / Kotlin label）逐字段分类。
 *
 * 这些场景在移动端聊天里出现频率低，等真有需求时再升级到 Prism4j 或 dev.snipme。
 */
internal object CodeSyntaxHighlighter {

    /** 是否能高亮（语言已识别） */
    fun isSupported(language: String?): Boolean = resolveLanguage(language) != null

    /** 主入口。未识别语言返回 null，由调用方决定是否走纯文本 */
    fun highlight(code: String, language: String?, isDark: Boolean): AnnotatedString? {
        val lang = resolveLanguage(language) ?: return null
        val palette = if (isDark) DarkPalette else LightPalette
        val spans = buildSpans(code, lang, palette)
        val builder = AnnotatedString.Builder(code)
        for (span in spans) {
            builder.addStyle(span.style, span.start, span.end)
        }
        return builder.toAnnotatedString()
    }

    // region Public helpers (供测试 / 调用方查询)

    /** 已规范化的语言 key（用于显示在代码块头部） */
    fun displayName(language: String?): String? {
        if (language.isNullOrBlank()) return null
        return resolveLanguage(language) ?: language.lowercase()
    }

    // endregion

    // region Language resolution

    private fun resolveLanguage(input: String?): String? {
        if (input.isNullOrBlank()) return null
        val key = input.trim().lowercase()
        return when (key) {
            "kotlin", "kt", "kts" -> "kotlin"
            "java" -> "java"
            "swift" -> "swift"
            "python", "py", "py3" -> "python"
            "typescript", "ts", "tsx" -> "typescript"
            "javascript", "js", "jsx", "mjs", "cjs" -> "javascript"
            "json", "json5", "jsonc" -> "json"
            "bash", "sh", "zsh", "shell", "console" -> "bash"
            "sql", "postgres", "postgresql", "mysql", "sqlite" -> "sql"
            "go", "golang" -> "go"
            "rust", "rs" -> "rust"
            "c" -> "c"
            "cpp", "c++", "cxx", "hpp", "hh" -> "cpp"
            "csharp", "cs", "c#" -> "csharp"
            "objc", "objective-c", "objectivec" -> "objc"
            "ruby", "rb" -> "ruby"
            "php" -> "php"
            "yaml", "yml" -> "yaml"
            "toml" -> "toml"
            "xml", "html", "htm", "svg" -> "xml"
            "css", "scss", "sass", "less" -> "css"
            "diff", "patch" -> "diff"
            "dockerfile", "docker" -> "dockerfile"
            "makefile", "make" -> "makefile"
            "ini", "properties", "conf" -> "ini"
            "markdown", "md" -> "markdown"
            "graphql", "gql" -> "graphql"
            "lua" -> "lua"
            "scala" -> "scala"
            "dart" -> "dart"
            "r" -> "r"
            "perl", "pl" -> "perl"
            "powershell", "ps1" -> "powershell"
            else -> null
        }
    }

    // endregion

    // region Palette

    private data class Palette(
        val keyword: Color,
        val type: Color,
        val string: Color,
        val number: Color,
        val comment: Color,
        val function: Color,
        val literal: Color,
        val operator: Color,
    )

    /** atom-one-light 配色，与 iOS Highlightr light theme 一致 */
    private val LightPalette = Palette(
        keyword = Color(0xFFA626A4),
        type = Color(0xFFC18401),
        string = Color(0xFF50A14F),
        number = Color(0xFF986801),
        comment = Color(0xFFA0A1A7),
        function = Color(0xFF4078F2),
        literal = Color(0xFF0184BC),
        operator = Color(0xFF383A42),
    )

    /** atom-one-dark 配色，与 iOS Highlightr dark theme 一致 */
    private val DarkPalette = Palette(
        keyword = Color(0xFFC678DD),
        type = Color(0xFFE5C07B),
        string = Color(0xFF98C379),
        number = Color(0xFFD19A66),
        comment = Color(0xFF7F848E),
        function = Color(0xFF61AFEF),
        literal = Color(0xFF56B6C2),
        operator = Color(0xFFABB2BF),
    )

    // endregion

    // region Token model

    private enum class Kind { KEYWORD, TYPE, STRING, NUMBER, COMMENT, FUNCTION, LITERAL, OPERATOR }

    private data class Span(val start: Int, val end: Int, val style: SpanStyle)

    private fun Kind.toStyle(p: Palette): SpanStyle = when (this) {
        Kind.KEYWORD -> SpanStyle(color = p.keyword)
        Kind.TYPE -> SpanStyle(color = p.type)
        Kind.STRING -> SpanStyle(color = p.string)
        Kind.NUMBER -> SpanStyle(color = p.number)
        Kind.COMMENT -> SpanStyle(color = p.comment, fontStyle = FontStyle.Italic)
        Kind.FUNCTION -> SpanStyle(color = p.function)
        Kind.LITERAL -> SpanStyle(color = p.literal)
        Kind.OPERATOR -> SpanStyle(color = p.operator)
    }

    // endregion

    // region Tokenization

    private fun buildSpans(code: String, lang: String, palette: Palette): List<Span> {
        // 收集所有候选区间（非重叠）。优先级：注释 > 字符串 > 数字 > 关键字 > 类型 > 字面量 > 函数名
        // 通过"按起点排序 + 后入者落在已占区间则丢弃"实现。
        val intervals = ArrayList<Triple<Int, Int, Kind>>()

        addCommentMatches(code, lang, intervals)
        addStringMatches(code, lang, intervals)
        addNumberMatches(code, intervals)
        addKeywordMatches(code, lang, intervals)
        addTypeMatches(code, lang, intervals)
        addLiteralMatches(code, lang, intervals)
        addFunctionMatches(code, lang, intervals)

        // 按 (start, -priority) 排序，priority 隐式由插入顺序决定（先插入优先）
        // 这里用稳定排序 + 后续覆盖检测
        val sorted = intervals.withIndex()
            .sortedWith(compareBy({ it.value.first }, { it.index }))
            .map { it.value }

        val spans = ArrayList<Span>(sorted.size)
        var lastEnd = -1
        for ((s, e, kind) in sorted) {
            if (s >= lastEnd && e > s) {
                spans.add(Span(s, e, kind.toStyle(palette)))
                lastEnd = e
            }
        }
        return spans
    }

    // endregion

    // region Comments

    private fun addCommentMatches(
        code: String,
        lang: String,
        out: MutableList<Triple<Int, Int, Kind>>,
    ) {
        val patterns = COMMENT_PATTERNS[lang] ?: COMMENT_PATTERNS["__cstyle"]!!
        for (re in patterns) {
            re.findAll(code).forEach {
                out.add(Triple(it.range.first, it.range.last + 1, Kind.COMMENT))
            }
        }
    }

    private val LINE_DOUBLE_SLASH = Regex("""//[^\n]*""")
    private val BLOCK_C = Regex("""/\*[\s\S]*?\*/""")
    private val LINE_HASH = Regex("""#[^\n]*""")
    private val LINE_DOUBLE_DASH = Regex("""--[^\n]*""")
    private val PYTHON_DOC = Regex("""(?s)\"\"\".*?\"\"\"|'''.*?'''""")
    private val HTML_COMMENT = Regex("""<!--[\s\S]*?-->""")

    private val COMMENT_PATTERNS: Map<String, List<Regex>> = mapOf(
        "__cstyle" to listOf(LINE_DOUBLE_SLASH, BLOCK_C),
        "kotlin" to listOf(LINE_DOUBLE_SLASH, BLOCK_C),
        "java" to listOf(LINE_DOUBLE_SLASH, BLOCK_C),
        "swift" to listOf(LINE_DOUBLE_SLASH, BLOCK_C),
        "typescript" to listOf(LINE_DOUBLE_SLASH, BLOCK_C),
        "javascript" to listOf(LINE_DOUBLE_SLASH, BLOCK_C),
        "go" to listOf(LINE_DOUBLE_SLASH, BLOCK_C),
        "rust" to listOf(LINE_DOUBLE_SLASH, BLOCK_C),
        "c" to listOf(LINE_DOUBLE_SLASH, BLOCK_C),
        "cpp" to listOf(LINE_DOUBLE_SLASH, BLOCK_C),
        "csharp" to listOf(LINE_DOUBLE_SLASH, BLOCK_C),
        "objc" to listOf(LINE_DOUBLE_SLASH, BLOCK_C),
        "scala" to listOf(LINE_DOUBLE_SLASH, BLOCK_C),
        "dart" to listOf(LINE_DOUBLE_SLASH, BLOCK_C),
        "graphql" to listOf(LINE_HASH),
        "python" to listOf(PYTHON_DOC, LINE_HASH),
        "ruby" to listOf(LINE_HASH),
        "perl" to listOf(LINE_HASH),
        "php" to listOf(LINE_DOUBLE_SLASH, LINE_HASH, BLOCK_C),
        "bash" to listOf(LINE_HASH),
        "yaml" to listOf(LINE_HASH),
        "toml" to listOf(LINE_HASH),
        "ini" to listOf(LINE_HASH, Regex(""";[^\n]*""")),
        "dockerfile" to listOf(LINE_HASH),
        "makefile" to listOf(LINE_HASH),
        "r" to listOf(LINE_HASH),
        "sql" to listOf(LINE_DOUBLE_DASH, BLOCK_C),
        "lua" to listOf(Regex("""--[^\n]*"""), Regex("""--\[\[[\s\S]*?\]\]""")),
        "css" to listOf(BLOCK_C),
        "xml" to listOf(HTML_COMMENT),
        "json" to emptyList(),
        "diff" to emptyList(),
        "markdown" to listOf(HTML_COMMENT),
        "powershell" to listOf(LINE_HASH, Regex("""<#[\s\S]*?#>""")),
    )

    // endregion

    // region Strings

    private fun addStringMatches(
        code: String,
        lang: String,
        out: MutableList<Triple<Int, Int, Kind>>,
    ) {
        val patterns = STRING_PATTERNS[lang] ?: STRING_PATTERNS["__default"]!!
        for (re in patterns) {
            re.findAll(code).forEach {
                out.add(Triple(it.range.first, it.range.last + 1, Kind.STRING))
            }
        }
    }

    /** 双引号字符串，支持 \\ 转义。受限于正则不支持嵌套，模板插值不展开。 */
    private val STR_DOUBLE = Regex("""\"(?:\\.|[^"\\\n])*\"""")
    private val STR_SINGLE = Regex("""'(?:\\.|[^'\\\n])*'""")
    private val STR_BACKTICK = Regex("""`(?:\\.|[^`\\])*`""")
    /** Swift / Kotlin / Python 三重引号 */
    private val STR_TRIPLE_DOUBLE = Regex("""(?s)\"\"\".*?\"\"\"""")
    private val STR_TRIPLE_SINGLE = Regex("""(?s)'''.*?'''""")
    /** Bash heredoc 简化：$' ... ' / $"..." 不区分 */
    private val STR_BASH_DOUBLE = Regex("""\"(?:\\.|\$\{[^}]*\}|[^"\\])*\"""")

    private val STRING_PATTERNS: Map<String, List<Regex>> = mapOf(
        "__default" to listOf(STR_DOUBLE, STR_SINGLE),
        "kotlin" to listOf(STR_TRIPLE_DOUBLE, STR_DOUBLE, Regex("""'(?:\\.|[^'\\\n])'""")),
        "java" to listOf(STR_DOUBLE, Regex("""'(?:\\.|[^'\\\n])'""")),
        "swift" to listOf(STR_TRIPLE_DOUBLE, STR_DOUBLE),
        "typescript" to listOf(STR_BACKTICK, STR_DOUBLE, STR_SINGLE),
        "javascript" to listOf(STR_BACKTICK, STR_DOUBLE, STR_SINGLE),
        "python" to listOf(STR_TRIPLE_DOUBLE, STR_TRIPLE_SINGLE, STR_DOUBLE, STR_SINGLE),
        "go" to listOf(STR_BACKTICK, STR_DOUBLE, Regex("""'(?:\\.|[^'\\\n])'""")),
        "rust" to listOf(STR_DOUBLE, Regex("""'(?:\\.|[^'\\\n])'""")),
        "c" to listOf(STR_DOUBLE, Regex("""'(?:\\.|[^'\\\n])'""")),
        "cpp" to listOf(STR_DOUBLE, Regex("""'(?:\\.|[^'\\\n])'""")),
        "csharp" to listOf(STR_DOUBLE, Regex("""'(?:\\.|[^'\\\n])'""")),
        "objc" to listOf(Regex("""@?\"(?:\\.|[^"\\\n])*\""""), Regex("""'(?:\\.|[^'\\\n])'""")),
        "scala" to listOf(STR_TRIPLE_DOUBLE, STR_DOUBLE, Regex("""'(?:\\.|[^'\\\n])'""")),
        "dart" to listOf(STR_TRIPLE_DOUBLE, STR_TRIPLE_SINGLE, STR_DOUBLE, STR_SINGLE),
        "ruby" to listOf(STR_DOUBLE, STR_SINGLE),
        "perl" to listOf(STR_DOUBLE, STR_SINGLE),
        "php" to listOf(STR_DOUBLE, STR_SINGLE),
        "bash" to listOf(STR_BASH_DOUBLE, STR_SINGLE),
        "sql" to listOf(STR_SINGLE, STR_DOUBLE),
        "yaml" to listOf(STR_DOUBLE, STR_SINGLE),
        "toml" to listOf(STR_DOUBLE, STR_SINGLE),
        "ini" to listOf(STR_DOUBLE, STR_SINGLE),
        "json" to listOf(STR_DOUBLE),
        "css" to listOf(STR_DOUBLE, STR_SINGLE),
        "xml" to listOf(STR_DOUBLE, STR_SINGLE),
        "graphql" to listOf(STR_DOUBLE, STR_TRIPLE_DOUBLE),
        "lua" to listOf(STR_DOUBLE, STR_SINGLE),
        "r" to listOf(STR_DOUBLE, STR_SINGLE),
        "powershell" to listOf(STR_DOUBLE, STR_SINGLE),
        "dockerfile" to listOf(STR_DOUBLE, STR_SINGLE),
        "makefile" to listOf(STR_DOUBLE, STR_SINGLE),
        "diff" to emptyList(),
        "markdown" to emptyList(),
    )

    // endregion

    // region Numbers

    private val NUMBER_PATTERN = Regex("""\b(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)[fFdDLlu]*\b""")

    private fun addNumberMatches(code: String, out: MutableList<Triple<Int, Int, Kind>>) {
        NUMBER_PATTERN.findAll(code).forEach {
            out.add(Triple(it.range.first, it.range.last + 1, Kind.NUMBER))
        }
    }

    // endregion

    // region Keywords / Types / Literals / Functions

    private fun addKeywordMatches(
        code: String,
        lang: String,
        out: MutableList<Triple<Int, Int, Kind>>,
    ) {
        val keywords = KEYWORDS[lang] ?: return
        val re = wordSetRegex(keywords, caseInsensitive = lang in CASE_INSENSITIVE_LANGS) ?: return
        re.findAll(code).forEach {
            out.add(Triple(it.range.first, it.range.last + 1, Kind.KEYWORD))
        }
    }

    /** 关键字大小写不敏感的语言（SQL / Dockerfile 都常见混写） */
    private val CASE_INSENSITIVE_LANGS = setOf("sql", "dockerfile", "makefile")

    private fun addTypeMatches(
        code: String,
        lang: String,
        out: MutableList<Triple<Int, Int, Kind>>,
    ) {
        val types = TYPES[lang] ?: return
        val re = wordSetRegex(types) ?: return
        re.findAll(code).forEach {
            out.add(Triple(it.range.first, it.range.last + 1, Kind.TYPE))
        }
    }

    private fun addLiteralMatches(
        code: String,
        lang: String,
        out: MutableList<Triple<Int, Int, Kind>>,
    ) {
        val lits = LITERALS[lang] ?: return
        val re = wordSetRegex(lits) ?: return
        re.findAll(code).forEach {
            out.add(Triple(it.range.first, it.range.last + 1, Kind.LITERAL))
        }
    }

    /** 函数名启发式：标识符 + 紧跟 ( */
    private val FUNCTION_HEURISTIC = Regex("""\b([A-Za-z_][A-Za-z0-9_]*)\s*\(""")

    private fun addFunctionMatches(
        code: String,
        lang: String,
        out: MutableList<Triple<Int, Int, Kind>>,
    ) {
        // 仅对类 C 家族启用，避免在 SQL/YAML 等语言里把 SUM( COUNT( 之类标记成函数后再被关键字覆盖出错
        val enable = lang in FUNCTION_LANGS
        if (!enable) return
        FUNCTION_HEURISTIC.findAll(code).forEach { m ->
            val name = m.groupValues[1]
            // 关键字不当函数名着色（KEYWORD 优先级更高，但分组里只覆盖 name）
            if (KEYWORDS[lang]?.contains(name) == true) return@forEach
            val r = m.groups[1]?.range ?: return@forEach
            out.add(Triple(r.first, r.last + 1, Kind.FUNCTION))
        }
    }

    private val FUNCTION_LANGS = setOf(
        "kotlin", "java", "swift", "typescript", "javascript",
        "go", "rust", "c", "cpp", "csharp", "objc", "scala", "dart", "python", "php"
    )

    private fun wordSetRegex(words: Set<String>, caseInsensitive: Boolean = false): Regex? {
        if (words.isEmpty()) return null
        val alternation = words.joinToString("|") { Regex.escape(it) }
        val opts = if (caseInsensitive) setOf(RegexOption.IGNORE_CASE) else emptySet()
        return Regex("""\b(?:$alternation)\b""", opts)
    }

    // endregion

    // region Keyword tables

    private val KW_KOTLIN = setOf(
        "as", "break", "by", "catch", "class", "companion", "const", "constructor", "continue",
        "data", "do", "dynamic", "else", "enum", "external", "false", "field", "final", "finally",
        "for", "fun", "get", "if", "import", "in", "infix", "init", "inline", "inner", "interface",
        "internal", "is", "it", "lateinit", "noinline", "null", "object", "open", "operator", "out",
        "override", "package", "param", "private", "property", "protected", "public", "receiver",
        "reified", "return", "sealed", "set", "setparam", "super", "suspend", "tailrec", "this",
        "throw", "throws", "true", "try", "typealias", "typeof", "val", "var", "vararg", "when",
        "where", "while", "actual", "expect", "annotation", "abstract"
    )

    private val KW_JAVA = setOf(
        "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const",
        "continue", "default", "do", "double", "else", "enum", "extends", "final", "finally",
        "float", "for", "goto", "if", "implements", "import", "instanceof", "int", "interface",
        "long", "native", "new", "package", "private", "protected", "public", "record", "return",
        "sealed", "short", "static", "strictfp", "super", "switch", "synchronized", "this", "throw",
        "throws", "transient", "try", "void", "volatile", "while", "yield", "var"
    )

    private val KW_SWIFT = setOf(
        "associatedtype", "class", "deinit", "enum", "extension", "fileprivate", "func", "import",
        "init", "inout", "internal", "let", "open", "operator", "private", "protocol", "public",
        "rethrows", "static", "struct", "subscript", "typealias", "var", "actor", "any", "some",
        "break", "case", "continue", "default", "defer", "do", "else", "fallthrough", "for",
        "guard", "if", "in", "repeat", "return", "switch", "where", "while", "as", "Any", "catch",
        "false", "is", "nil", "rethrows", "super", "self", "Self", "throw", "throws", "true", "try",
        "convenience", "dynamic", "didSet", "final", "get", "infix", "indirect", "lazy", "left",
        "mutating", "none", "nonmutating", "optional", "override", "postfix", "precedence",
        "prefix", "Protocol", "required", "right", "set", "Type", "unowned", "weak", "willSet",
        "async", "await"
    )

    private val KW_PYTHON = setOf(
        "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
        "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
        "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return",
        "try", "while", "with", "yield", "match", "case", "self", "cls"
    )

    private val KW_TS = setOf(
        "abstract", "any", "as", "async", "await", "boolean", "break", "case", "catch", "class",
        "const", "constructor", "continue", "debugger", "declare", "default", "delete", "do", "else",
        "enum", "export", "extends", "false", "finally", "for", "from", "function", "get",
        "implements", "import", "in", "infer", "instanceof", "interface", "is", "keyof", "let",
        "module", "namespace", "never", "new", "null", "number", "object", "of", "package",
        "private", "protected", "public", "readonly", "require", "return", "set", "static",
        "string", "super", "switch", "symbol", "this", "throw", "true", "try", "type", "typeof",
        "undefined", "unique", "unknown", "var", "void", "while", "with", "yield", "satisfies",
        "global", "override"
    )

    private val KW_JS = setOf(
        "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger",
        "default", "delete", "do", "else", "export", "extends", "false", "finally", "for",
        "from", "function", "if", "import", "in", "instanceof", "let", "new", "null", "of",
        "return", "super", "switch", "this", "throw", "true", "try", "typeof", "undefined",
        "var", "void", "while", "with", "yield", "static", "get", "set"
    )

    private val KW_BASH = setOf(
        "if", "then", "else", "elif", "fi", "case", "esac", "for", "while", "until", "do", "done",
        "in", "function", "select", "time", "return", "break", "continue", "exit", "export",
        "local", "readonly", "declare", "typeset", "set", "unset", "shift", "source", "alias"
    )

    private val KW_SQL = setOf(
        "select", "from", "where", "join", "left", "right", "inner", "outer", "full", "cross",
        "on", "group", "by", "having", "order", "asc", "desc", "limit", "offset", "insert",
        "into", "values", "update", "set", "delete", "create", "drop", "alter", "table", "view",
        "index", "primary", "key", "foreign", "references", "constraint", "unique", "not", "null",
        "default", "as", "and", "or", "in", "between", "like", "exists", "case", "when", "then",
        "else", "end", "distinct", "union", "intersect", "except", "begin", "commit", "rollback",
        "transaction", "with", "returning", "using", "is", "true", "false"
    )

    private val KW_GO = setOf(
        "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough",
        "for", "func", "go", "goto", "if", "import", "interface", "map", "package", "range",
        "return", "select", "struct", "switch", "type", "var", "true", "false", "nil", "iota"
    )

    private val KW_RUST = setOf(
        "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum",
        "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod",
        "move", "mut", "pub", "ref", "return", "Self", "self", "static", "struct", "super",
        "trait", "true", "type", "unsafe", "use", "where", "while", "abstract", "become", "box",
        "do", "final", "macro", "override", "priv", "typeof", "unsized", "virtual", "yield",
        "try", "union"
    )

    private val KW_C = setOf(
        "auto", "break", "case", "char", "const", "continue", "default", "do", "double", "else",
        "enum", "extern", "float", "for", "goto", "if", "inline", "int", "long", "register",
        "restrict", "return", "short", "signed", "sizeof", "static", "struct", "switch", "typedef",
        "union", "unsigned", "void", "volatile", "while", "_Bool", "_Complex", "_Imaginary",
        "_Atomic", "_Thread_local"
    )

    private val KW_CPP = KW_C + setOf(
        "alignas", "alignof", "and", "and_eq", "asm", "bitand", "bitor", "bool", "catch", "class",
        "compl", "concept", "constexpr", "constinit", "consteval", "co_await", "co_return",
        "co_yield", "decltype", "delete", "explicit", "export", "false", "friend", "mutable",
        "namespace", "new", "noexcept", "not", "not_eq", "nullptr", "operator", "or", "or_eq",
        "private", "protected", "public", "reinterpret_cast", "requires", "static_cast",
        "static_assert", "template", "this", "thread_local", "throw", "true", "try", "typeid",
        "typename", "using", "virtual", "wchar_t", "xor", "xor_eq", "dynamic_cast", "const_cast",
        "char16_t", "char32_t"
    )

    private val KW_CSHARP = setOf(
        "abstract", "as", "base", "bool", "break", "byte", "case", "catch", "char", "checked",
        "class", "const", "continue", "decimal", "default", "delegate", "do", "double", "else",
        "enum", "event", "explicit", "extern", "false", "finally", "fixed", "float", "for",
        "foreach", "goto", "if", "implicit", "in", "int", "interface", "internal", "is", "lock",
        "long", "namespace", "new", "null", "object", "operator", "out", "override", "params",
        "private", "protected", "public", "readonly", "ref", "return", "sbyte", "sealed", "short",
        "sizeof", "stackalloc", "static", "string", "struct", "switch", "this", "throw", "true",
        "try", "typeof", "uint", "ulong", "unchecked", "unsafe", "ushort", "using", "virtual",
        "void", "volatile", "while", "var", "async", "await", "dynamic", "yield", "record"
    )

    private val KW_RUBY = setOf(
        "BEGIN", "END", "alias", "and", "begin", "break", "case", "class", "def", "defined?",
        "do", "else", "elsif", "end", "ensure", "false", "for", "if", "in", "module", "next",
        "nil", "not", "or", "redo", "rescue", "retry", "return", "self", "super", "then", "true",
        "undef", "unless", "until", "when", "while", "yield"
    )

    private val KW_PHP = setOf(
        "abstract", "and", "array", "as", "break", "callable", "case", "catch", "class", "clone",
        "const", "continue", "declare", "default", "do", "echo", "else", "elseif", "empty",
        "enddeclare", "endfor", "endforeach", "endif", "endswitch", "endwhile", "extends", "final",
        "finally", "fn", "for", "foreach", "function", "global", "goto", "if", "implements",
        "include", "include_once", "instanceof", "insteadof", "interface", "isset", "list",
        "match", "namespace", "new", "or", "print", "private", "protected", "public", "readonly",
        "require", "require_once", "return", "static", "switch", "throw", "trait", "try", "unset",
        "use", "var", "while", "xor", "yield"
    )

    private val KW_YAML = emptySet<String>()
    private val KW_JSON = emptySet<String>()
    private val KW_SCALA = setOf(
        "abstract", "case", "catch", "class", "def", "do", "else", "enum", "export", "extends",
        "false", "final", "finally", "for", "given", "if", "implicit", "import", "lazy", "match",
        "new", "null", "object", "override", "package", "private", "protected", "return", "sealed",
        "super", "this", "throw", "trait", "true", "try", "type", "val", "var", "while", "with",
        "yield", "then"
    )

    private val KW_DART = setOf(
        "abstract", "as", "assert", "async", "await", "break", "case", "catch", "class", "const",
        "continue", "covariant", "default", "deferred", "do", "dynamic", "else", "enum", "export",
        "extends", "extension", "external", "factory", "false", "final", "finally", "for", "Function",
        "get", "hide", "if", "implements", "import", "in", "interface", "is", "late", "library",
        "mixin", "new", "null", "on", "operator", "part", "required", "rethrow", "return", "set",
        "show", "static", "super", "switch", "sync", "this", "throw", "true", "try", "typedef",
        "var", "void", "while", "with", "yield", "Never"
    )

    private val KW_LUA = setOf(
        "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if",
        "in", "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while"
    )

    private val KW_PERL = setOf(
        "if", "unless", "while", "until", "for", "foreach", "do", "elsif", "else", "last", "next",
        "redo", "return", "sub", "my", "our", "local", "use", "no", "package", "require", "eq",
        "ne", "lt", "gt", "le", "ge", "and", "or", "not", "xor", "defined", "undef"
    )

    private val KW_POWERSHELL = setOf(
        "begin", "break", "catch", "class", "continue", "data", "define", "do", "dynamicparam",
        "else", "elseif", "end", "enum", "exit", "filter", "finally", "for", "foreach", "from",
        "function", "hidden", "if", "in", "param", "process", "return", "static", "switch",
        "throw", "trap", "try", "until", "using", "var", "while"
    )

    // Objective-C 的 @ 指令（@interface / @end 等）含非单词字符，简单 \b 边界处理不稳定，
    // 这里仅收纳普通标识符关键字，@ 指令暂不着色。
    private val KW_OBJC = setOf(
        "auto", "break", "case", "char", "const", "continue", "default", "do", "double", "else",
        "enum", "extern", "float", "for", "goto", "if", "int", "long", "register", "return",
        "short", "signed", "sizeof", "static", "struct", "switch", "typedef", "union", "unsigned",
        "void", "volatile", "while", "self", "super", "id", "BOOL", "YES", "NO", "nil", "Nil",
        "instancetype", "in", "out", "inout", "bycopy", "byref", "oneway"
    )

    private val KW_R = setOf(
        "if", "else", "for", "while", "repeat", "return", "function", "in", "break", "next",
        "TRUE", "FALSE", "NULL", "NA", "Inf", "NaN"
    )

    private val KW_GRAPHQL = setOf(
        "query", "mutation", "subscription", "fragment", "on", "type", "interface", "union",
        "enum", "input", "schema", "scalar", "extend", "directive", "implements", "true", "false",
        "null"
    )

    private val KW_DOCKERFILE = setOf(
        "FROM", "RUN", "CMD", "LABEL", "MAINTAINER", "EXPOSE", "ENV", "ADD", "COPY", "ENTRYPOINT",
        "VOLUME", "USER", "WORKDIR", "ARG", "ONBUILD", "STOPSIGNAL", "HEALTHCHECK", "SHELL", "AS"
    )

    private val KW_MAKEFILE = setOf(
        "include", "ifeq", "ifneq", "ifdef", "ifndef", "else", "endif", "define", "endef",
        "export", "unexport", "vpath", "override"
    )

    private val KW_DIFF = emptySet<String>()
    private val KW_MARKDOWN = emptySet<String>()
    private val KW_INI = emptySet<String>()
    private val KW_TOML = emptySet<String>()
    private val KW_XML = emptySet<String>()
    private val KW_CSS = setOf(
        "important", "from", "to", "and", "or", "not", "only", "all", "screen", "print"
    )

    private val KEYWORDS: Map<String, Set<String>> = mapOf(
        "kotlin" to KW_KOTLIN,
        "java" to KW_JAVA,
        "swift" to KW_SWIFT,
        "python" to KW_PYTHON,
        "typescript" to KW_TS,
        "javascript" to KW_JS,
        "json" to KW_JSON,
        "bash" to KW_BASH,
        "sql" to KW_SQL,
        "go" to KW_GO,
        "rust" to KW_RUST,
        "c" to KW_C,
        "cpp" to KW_CPP,
        "csharp" to KW_CSHARP,
        "objc" to KW_OBJC,
        "ruby" to KW_RUBY,
        "php" to KW_PHP,
        "yaml" to KW_YAML,
        "scala" to KW_SCALA,
        "dart" to KW_DART,
        "lua" to KW_LUA,
        "perl" to KW_PERL,
        "powershell" to KW_POWERSHELL,
        "r" to KW_R,
        "graphql" to KW_GRAPHQL,
        "dockerfile" to KW_DOCKERFILE,
        "makefile" to KW_MAKEFILE,
        "diff" to KW_DIFF,
        "markdown" to KW_MARKDOWN,
        "ini" to KW_INI,
        "toml" to KW_TOML,
        "xml" to KW_XML,
        "css" to KW_CSS,
    )

    // endregion

    // region Types & Literals

    private val TYPES: Map<String, Set<String>> = mapOf(
        "kotlin" to setOf(
            "Int", "Long", "Short", "Byte", "Float", "Double", "Boolean", "Char", "String",
            "Any", "Unit", "Nothing", "Array", "List", "MutableList", "Map", "MutableMap",
            "Set", "MutableSet", "Pair", "Triple", "Sequence", "Iterable"
        ),
        "java" to setOf(
            "String", "Object", "Integer", "Long", "Float", "Double", "Boolean", "Character",
            "Byte", "Short", "List", "ArrayList", "Map", "HashMap", "Set", "HashSet"
        ),
        "swift" to setOf(
            "Int", "Int8", "Int16", "Int32", "Int64", "UInt", "UInt8", "UInt16", "UInt32",
            "UInt64", "Float", "Double", "Bool", "String", "Character", "Array", "Dictionary",
            "Set", "Optional", "Any", "AnyObject", "Void"
        ),
        "typescript" to setOf(
            "string", "number", "boolean", "object", "symbol", "bigint", "void", "never",
            "unknown", "any", "Promise", "Array", "Record", "Partial", "Required", "Readonly",
            "Pick", "Omit", "Map", "Set", "WeakMap", "WeakSet"
        ),
        "go" to setOf(
            "bool", "string", "int", "int8", "int16", "int32", "int64", "uint", "uint8",
            "uint16", "uint32", "uint64", "uintptr", "byte", "rune", "float32", "float64",
            "complex64", "complex128", "error"
        ),
        "rust" to setOf(
            "bool", "char", "str", "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16",
            "u32", "u64", "u128", "usize", "f32", "f64", "String", "Vec", "Option", "Result",
            "Box", "Rc", "Arc", "RefCell", "Cell", "HashMap", "BTreeMap", "HashSet"
        ),
        "c" to setOf("size_t", "ptrdiff_t", "ssize_t", "uint8_t", "uint16_t", "uint32_t", "uint64_t",
            "int8_t", "int16_t", "int32_t", "int64_t", "FILE", "NULL"),
        "cpp" to setOf("std", "string", "vector", "map", "unordered_map", "set", "unordered_set",
            "pair", "shared_ptr", "unique_ptr", "weak_ptr", "size_t", "uint8_t", "uint16_t",
            "uint32_t", "uint64_t", "int8_t", "int16_t", "int32_t", "int64_t"),
        "csharp" to setOf("List", "Dictionary", "HashSet", "IEnumerable", "Task", "Action", "Func",
            "Nullable", "Tuple"),
    )

    private val LITERALS: Map<String, Set<String>> = mapOf(
        "kotlin" to setOf("true", "false", "null"),
        "java" to setOf("true", "false", "null"),
        "swift" to setOf("true", "false", "nil"),
        "python" to setOf("True", "False", "None"),
        "typescript" to setOf("true", "false", "null", "undefined"),
        "javascript" to setOf("true", "false", "null", "undefined", "NaN", "Infinity"),
        "json" to setOf("true", "false", "null"),
        "go" to setOf("true", "false", "nil"),
        "rust" to setOf("true", "false", "None", "Some", "Ok", "Err"),
        "c" to setOf("NULL", "true", "false"),
        "cpp" to setOf("nullptr", "true", "false"),
        "csharp" to setOf("true", "false", "null"),
        "yaml" to setOf("true", "false", "null", "True", "False", "Null", "yes", "no", "Yes", "No",
            "on", "off", "On", "Off"),
        "toml" to setOf("true", "false"),
        "ini" to setOf("true", "false", "yes", "no", "on", "off"),
        "ruby" to setOf("true", "false", "nil"),
        "php" to setOf("true", "false", "null", "TRUE", "FALSE", "NULL"),
        "lua" to setOf("true", "false", "nil"),
        "r" to setOf("TRUE", "FALSE", "NULL", "NA", "Inf", "NaN"),
    )

    // endregion
}

/**
 * Compose 端记忆化高亮，避免流式拼接时每次重渲染都跑正则。
 * key = (code 内容 + 语言 + 主题)
 */
@Composable
internal fun rememberHighlightedCode(
    code: String,
    language: String?,
    isDark: Boolean,
): AnnotatedString {
    return remember(code, language, isDark) {
        CodeSyntaxHighlighter.highlight(code, language, isDark)
            ?: AnnotatedString(code)
    }
}
