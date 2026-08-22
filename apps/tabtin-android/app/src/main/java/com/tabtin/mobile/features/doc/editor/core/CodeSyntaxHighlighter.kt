package com.tabtin.mobile.features.doc.editor.core

import android.text.Editable
import android.text.Spannable
import android.text.style.ForegroundColorSpan

/**
 * 代码块轻量语法高亮。
 * 基于正则匹配关键字、字符串、注释、数字，应用 ForegroundColorSpan。
 * 不与 DocSpan 体系冲突（代码块不使用 InlineMark）。
 */
public object CodeSyntaxHighlighter {

    private const val COLOR_KEYWORD  = 0xFF_C678DD.toInt()  // purple
    private const val COLOR_STRING   = 0xFF_98C379.toInt()  // green
    private const val COLOR_COMMENT  = 0xFF_7F848E.toInt()  // gray
    private const val COLOR_NUMBER   = 0xFF_D19A66.toInt()  // orange
    private const val COLOR_TYPE     = 0xFF_E5C07B.toInt()  // yellow
    private const val COLOR_BUILTIN  = 0xFF_61AFEF.toInt()  // blue

    public class SyntaxSpan(color: Int) : ForegroundColorSpan(color)

    public fun highlight(editable: Editable, language: String) {
        editable.getSpans(0, editable.length, SyntaxSpan::class.java).forEach {
            editable.removeSpan(it)
        }

        val lang = language.lowercase()
        val rules = buildRules(lang)
        if (rules.isEmpty()) return

        val text = editable.toString()
        val occupied = BooleanArray(text.length)

        for (rule in rules) {
            val matcher = rule.pattern.toPattern().matcher(text)
            while (matcher.find()) {
                val start = if (rule.group > 0 && matcher.groupCount() >= rule.group) {
                    matcher.start(rule.group)
                } else matcher.start()
                val end = if (rule.group > 0 && matcher.groupCount() >= rule.group) {
                    matcher.end(rule.group)
                } else matcher.end()

                if (start < 0 || end <= start || end > text.length) continue
                if ((start until end).any { occupied[it] }) continue

                editable.setSpan(
                    SyntaxSpan(rule.color),
                    start, end,
                    Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
                )
                for (i in start until end) occupied[i] = true
            }
        }
    }

    private data class Rule(val pattern: Regex, val color: Int, val group: Int = 0)

    private val COMMENT_LINE = Rule(Regex("//[^\n]*"), COLOR_COMMENT)
    private val COMMENT_HASH = Rule(Regex("#[^\n]*"), COLOR_COMMENT)
    private val COMMENT_BLOCK = Rule(Regex("/\\*[\\s\\S]*?\\*/"), COLOR_COMMENT)
    private val COMMENT_HTML = Rule(Regex("<!--[\\s\\S]*?-->"), COLOR_COMMENT)
    private val COMMENT_DASH = Rule(Regex("--[^\n]*"), COLOR_COMMENT)

    private val STRING_DOUBLE = Rule(Regex("\"(?:[^\"\\\\]|\\\\.)*\""), COLOR_STRING)
    private val STRING_SINGLE = Rule(Regex("'(?:[^'\\\\]|\\\\.)*'"), COLOR_STRING)
    private val STRING_BACKTICK = Rule(Regex("`(?:[^`\\\\]|\\\\.)*`"), COLOR_STRING)
    private val STRING_TRIPLE_DQ = Rule(Regex("\"\"\"[\\s\\S]*?\"\"\""), COLOR_STRING)
    private val STRING_TRIPLE_SQ = Rule(Regex("'''[\\s\\S]*?'''"), COLOR_STRING)

    private val NUMBER = Rule(Regex("\\b(?:0[xXbBoO])?\\d[\\d_]*\\.?\\d*[fFdDlLuU]*\\b"), COLOR_NUMBER)

    private fun keywordRule(words: List<String>): Rule {
        val pattern = "\\b(?:${words.joinToString("|")})\\b"
        return Rule(Regex(pattern), COLOR_KEYWORD)
    }

    private fun typeRule(words: List<String>): Rule {
        val pattern = "\\b(?:${words.joinToString("|")})\\b"
        return Rule(Regex(pattern), COLOR_TYPE)
    }

    private fun builtinRule(words: List<String>): Rule {
        val pattern = "\\b(?:${words.joinToString("|")})\\b"
        return Rule(Regex(pattern), COLOR_BUILTIN)
    }

    private fun buildRules(lang: String): List<Rule> = when (lang) {
        "javascript", "js", "typescript", "ts" -> listOf(
            COMMENT_LINE, COMMENT_BLOCK,
            STRING_BACKTICK, STRING_DOUBLE, STRING_SINGLE,
            NUMBER,
            keywordRule(listOf(
                "const", "let", "var", "function", "return", "if", "else", "for", "while", "do",
                "switch", "case", "break", "continue", "new", "this", "class", "extends", "super",
                "import", "export", "from", "default", "try", "catch", "finally", "throw",
                "async", "await", "yield", "typeof", "instanceof", "in", "of", "delete", "void",
                "static", "get", "set", "enum", "implements", "interface", "type", "as",
                "abstract", "declare", "readonly", "keyof", "infer", "namespace",
            )),
            typeRule(listOf("string", "number", "boolean", "any", "void", "never", "unknown", "undefined", "null", "object", "symbol", "bigint")),
            builtinRule(listOf("console", "Math", "JSON", "Promise", "Array", "Object", "String", "Number", "Boolean", "Date", "Map", "Set", "RegExp", "Error")),
        )
        "python", "py" -> listOf(
            COMMENT_HASH,
            STRING_TRIPLE_DQ, STRING_TRIPLE_SQ, STRING_DOUBLE, STRING_SINGLE,
            NUMBER,
            keywordRule(listOf(
                "def", "class", "return", "if", "elif", "else", "for", "while", "break", "continue",
                "import", "from", "as", "try", "except", "finally", "raise", "with", "yield",
                "lambda", "pass", "del", "global", "nonlocal", "assert", "async", "await",
                "and", "or", "not", "in", "is", "True", "False", "None",
            )),
            builtinRule(listOf("print", "len", "range", "type", "int", "str", "float", "list", "dict", "set", "tuple", "bool", "super", "self", "isinstance", "enumerate", "zip", "map", "filter")),
        )
        "java" -> listOf(
            COMMENT_LINE, COMMENT_BLOCK,
            STRING_DOUBLE, STRING_SINGLE,
            NUMBER,
            keywordRule(listOf(
                "public", "private", "protected", "static", "final", "abstract", "class", "interface",
                "extends", "implements", "return", "if", "else", "for", "while", "do", "switch",
                "case", "break", "continue", "new", "this", "super", "try", "catch", "finally",
                "throw", "throws", "import", "package", "void", "synchronized", "volatile",
                "transient", "native", "enum", "instanceof", "default", "assert",
            )),
            typeRule(listOf("int", "long", "double", "float", "boolean", "byte", "char", "short", "String", "Integer", "Long", "Double", "Float", "Boolean", "Object", "List", "Map", "Set", "Optional")),
        )
        "kotlin", "kt" -> listOf(
            COMMENT_LINE, COMMENT_BLOCK,
            STRING_TRIPLE_DQ, STRING_DOUBLE, STRING_SINGLE,
            NUMBER,
            keywordRule(listOf(
                "fun", "val", "var", "class", "object", "interface", "return", "if", "else", "when",
                "for", "while", "do", "break", "continue", "is", "in", "as", "by", "constructor",
                "init", "companion", "data", "sealed", "enum", "abstract", "open", "override",
                "private", "protected", "internal", "public", "import", "package", "try", "catch",
                "finally", "throw", "suspend", "inline", "reified", "crossinline", "noinline",
                "tailrec", "operator", "infix", "typealias", "lateinit", "lazy",
                "true", "false", "null", "this", "super", "it",
            )),
            typeRule(listOf("Int", "Long", "Double", "Float", "Boolean", "String", "Char", "Unit", "Nothing", "Any", "List", "Map", "Set", "Array", "Pair", "Triple", "Sequence")),
        )
        "swift" -> listOf(
            COMMENT_LINE, COMMENT_BLOCK,
            STRING_TRIPLE_DQ, STRING_DOUBLE,
            NUMBER,
            keywordRule(listOf(
                "func", "let", "var", "class", "struct", "enum", "protocol", "extension", "return",
                "if", "else", "guard", "switch", "case", "for", "while", "repeat", "break",
                "continue", "import", "try", "catch", "throw", "throws", "async", "await",
                "self", "Self", "super", "init", "deinit", "subscript", "typealias",
                "private", "fileprivate", "internal", "public", "open", "static", "override",
                "mutating", "nonmutating", "final", "lazy", "weak", "unowned",
                "true", "false", "nil", "some", "none", "in", "is", "as", "where",
            )),
            typeRule(listOf("Int", "Double", "Float", "Bool", "String", "Character", "Array", "Dictionary", "Set", "Optional", "Result", "Void", "Any", "AnyObject")),
        )
        "go" -> listOf(
            COMMENT_LINE, COMMENT_BLOCK,
            STRING_BACKTICK, STRING_DOUBLE, STRING_SINGLE,
            NUMBER,
            keywordRule(listOf(
                "func", "return", "if", "else", "for", "range", "switch", "case", "break",
                "continue", "go", "select", "chan", "defer", "fallthrough", "goto",
                "import", "package", "type", "struct", "interface", "map", "var", "const",
                "true", "false", "nil", "iota",
            )),
            typeRule(listOf("int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "float32", "float64", "string", "bool", "byte", "rune", "error", "any")),
            builtinRule(listOf("make", "len", "cap", "new", "append", "copy", "delete", "close", "panic", "recover", "print", "println", "fmt")),
        )
        "rust", "rs" -> listOf(
            COMMENT_LINE, COMMENT_BLOCK,
            STRING_DOUBLE,
            NUMBER,
            keywordRule(listOf(
                "fn", "let", "mut", "const", "static", "struct", "enum", "impl", "trait",
                "pub", "use", "mod", "crate", "self", "super", "return", "if", "else", "match",
                "for", "while", "loop", "break", "continue", "move", "ref", "as", "in",
                "async", "await", "unsafe", "where", "type", "dyn", "extern",
                "true", "false",
            )),
            typeRule(listOf("i8", "i16", "i32", "i64", "i128", "u8", "u16", "u32", "u64", "u128", "f32", "f64", "bool", "char", "str", "String", "Vec", "Box", "Option", "Result", "Self", "usize", "isize")),
            builtinRule(listOf("println", "print", "format", "vec", "todo", "unimplemented", "panic", "assert", "Some", "None", "Ok", "Err")),
        )
        "c", "cpp", "c++" -> listOf(
            COMMENT_LINE, COMMENT_BLOCK,
            STRING_DOUBLE, STRING_SINGLE,
            NUMBER,
            keywordRule(listOf(
                "int", "long", "short", "char", "float", "double", "void", "unsigned", "signed",
                "const", "static", "extern", "register", "volatile", "auto", "inline",
                "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
                "return", "goto", "sizeof", "typedef", "struct", "union", "enum",
                "class", "public", "private", "protected", "virtual", "override", "final",
                "new", "delete", "this", "template", "typename", "namespace", "using",
                "try", "catch", "throw", "nullptr", "true", "false", "NULL",
                "include", "define", "ifdef", "ifndef", "endif", "pragma",
            )),
            typeRule(listOf("size_t", "bool", "string", "vector", "map", "set", "pair", "shared_ptr", "unique_ptr", "optional", "variant", "tuple", "array")),
            builtinRule(listOf("std", "cout", "cin", "endl", "printf", "scanf", "malloc", "free", "sizeof")),
        )
        "html", "xml" -> listOf(
            COMMENT_HTML,
            STRING_DOUBLE, STRING_SINGLE,
            Rule(Regex("</?\\w[\\w-]*"), COLOR_KEYWORD),
            Rule(Regex("\\b[\\w-]+(?==)"), COLOR_TYPE),
        )
        "css" -> listOf(
            COMMENT_BLOCK,
            STRING_DOUBLE, STRING_SINGLE,
            NUMBER,
            Rule(Regex("#[0-9a-fA-F]{3,8}\\b"), COLOR_NUMBER),
            Rule(Regex("[.#]?[\\w-]+(?=\\s*\\{)"), COLOR_KEYWORD),
            Rule(Regex("[\\w-]+(?=\\s*:)"), COLOR_TYPE),
            builtinRule(listOf("important", "inherit", "initial", "unset", "none", "auto", "flex", "grid", "block", "inline", "relative", "absolute", "fixed", "sticky")),
        )
        "sql" -> listOf(
            COMMENT_LINE, COMMENT_DASH, COMMENT_BLOCK,
            STRING_SINGLE, STRING_DOUBLE,
            NUMBER,
            keywordRule(listOf(
                "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE",
                "CREATE", "TABLE", "ALTER", "DROP", "INDEX", "VIEW", "JOIN", "LEFT", "RIGHT",
                "INNER", "OUTER", "ON", "AND", "OR", "NOT", "IN", "IS", "NULL", "LIKE",
                "ORDER", "BY", "GROUP", "HAVING", "LIMIT", "OFFSET", "UNION", "AS", "DISTINCT",
                "COUNT", "SUM", "AVG", "MIN", "MAX", "CASE", "WHEN", "THEN", "ELSE", "END",
                "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "CASCADE", "EXISTS", "BETWEEN",
                "select", "from", "where", "insert", "into", "values", "update", "set", "delete",
                "create", "table", "alter", "drop", "join", "left", "right", "inner", "outer",
                "on", "and", "or", "not", "in", "is", "null", "like", "order", "by", "group",
                "having", "limit", "offset", "union", "as", "distinct", "case", "when", "then", "else", "end",
            )),
            typeRule(listOf(
                "INT", "INTEGER", "BIGINT", "SMALLINT", "VARCHAR", "TEXT", "BOOLEAN", "BOOL",
                "DATE", "TIMESTAMP", "FLOAT", "DOUBLE", "DECIMAL", "CHAR", "BLOB", "JSON",
            )),
        )
        "shell", "bash", "sh", "zsh" -> listOf(
            COMMENT_HASH,
            STRING_DOUBLE, STRING_SINGLE,
            NUMBER,
            keywordRule(listOf(
                "if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case",
                "esac", "in", "function", "return", "exit", "local", "export", "source",
                "echo", "read", "set", "unset", "shift", "eval", "exec", "trap",
                "true", "false",
            )),
            builtinRule(listOf("cd", "ls", "cp", "mv", "rm", "mkdir", "cat", "grep", "sed", "awk", "find", "xargs", "sort", "uniq", "wc", "head", "tail", "curl", "wget", "git", "docker", "npm", "pip")),
        )
        "json" -> listOf(
            STRING_DOUBLE,
            NUMBER,
            keywordRule(listOf("true", "false", "null")),
            Rule(Regex("\"[^\"]*\"(?=\\s*:)"), COLOR_TYPE),
        )
        "yaml", "yml" -> listOf(
            COMMENT_HASH,
            STRING_DOUBLE, STRING_SINGLE,
            NUMBER,
            Rule(Regex("^[\\w.-]+(?=\\s*:)", RegexOption.MULTILINE), COLOR_TYPE),
            keywordRule(listOf("true", "false", "null", "yes", "no")),
        )
        "ruby", "rb" -> listOf(
            COMMENT_HASH,
            STRING_DOUBLE, STRING_SINGLE,
            NUMBER,
            keywordRule(listOf(
                "def", "end", "class", "module", "return", "if", "elsif", "else", "unless",
                "for", "while", "until", "do", "begin", "rescue", "ensure", "raise",
                "require", "include", "extend", "yield", "block_given",
                "true", "false", "nil", "self", "super",
                "attr_reader", "attr_writer", "attr_accessor",
                "public", "private", "protected",
            )),
            builtinRule(listOf("puts", "print", "p", "gets", "require_relative", "lambda", "proc")),
        )
        "php" -> listOf(
            COMMENT_LINE, COMMENT_HASH, COMMENT_BLOCK,
            STRING_DOUBLE, STRING_SINGLE,
            NUMBER,
            Rule(Regex("\\$\\w+"), COLOR_BUILTIN),
            keywordRule(listOf(
                "function", "class", "return", "if", "else", "elseif", "for", "foreach",
                "while", "do", "switch", "case", "break", "continue", "new", "this",
                "public", "private", "protected", "static", "abstract", "interface",
                "extends", "implements", "use", "namespace", "require", "include",
                "try", "catch", "finally", "throw", "echo", "print",
                "true", "false", "null", "self", "parent",
            )),
        )
        "dart" -> listOf(
            COMMENT_LINE, COMMENT_BLOCK,
            STRING_TRIPLE_DQ, STRING_TRIPLE_SQ, STRING_DOUBLE, STRING_SINGLE,
            NUMBER,
            keywordRule(listOf(
                "void", "var", "final", "const", "class", "extends", "implements", "with",
                "return", "if", "else", "for", "while", "do", "switch", "case", "break",
                "continue", "new", "this", "super", "try", "catch", "finally", "throw",
                "async", "await", "yield", "import", "export", "library", "part",
                "abstract", "static", "late", "required", "factory", "get", "set",
                "true", "false", "null",
            )),
            typeRule(listOf("int", "double", "bool", "String", "List", "Map", "Set", "Future", "Stream", "dynamic", "Object", "num", "Iterable", "Function", "Widget", "BuildContext", "State")),
        )
        "r" -> listOf(
            COMMENT_HASH,
            STRING_DOUBLE, STRING_SINGLE,
            NUMBER,
            keywordRule(listOf(
                "if", "else", "for", "while", "repeat", "function", "return", "break", "next",
                "in", "library", "require", "source", "TRUE", "FALSE", "NULL", "NA", "Inf", "NaN",
            )),
            builtinRule(listOf("print", "cat", "paste", "c", "list", "data.frame", "matrix", "length", "nrow", "ncol", "sum", "mean", "sd", "var", "plot", "ggplot")),
        )
        "scala" -> listOf(
            COMMENT_LINE, COMMENT_BLOCK,
            STRING_TRIPLE_DQ, STRING_DOUBLE, STRING_SINGLE,
            NUMBER,
            keywordRule(listOf(
                "def", "val", "var", "class", "object", "trait", "extends", "with", "return",
                "if", "else", "match", "case", "for", "while", "do", "yield",
                "import", "package", "abstract", "sealed", "final", "override", "lazy",
                "private", "protected", "implicit", "new", "this", "super", "type",
                "true", "false", "null",
            )),
            typeRule(listOf("Int", "Long", "Double", "Float", "Boolean", "String", "Char", "Unit", "Any", "Nothing", "Option", "List", "Map", "Set", "Seq", "Vector", "Future")),
        )
        "lua" -> listOf(
            Rule(Regex("--\\[\\[[\\s\\S]*?]]"), COLOR_COMMENT),
            Rule(Regex("--[^\n]*"), COLOR_COMMENT),
            STRING_DOUBLE, STRING_SINGLE,
            NUMBER,
            keywordRule(listOf(
                "function", "end", "return", "if", "then", "else", "elseif", "for", "while",
                "do", "repeat", "until", "break", "local", "in", "and", "or", "not",
                "true", "false", "nil", "goto",
            )),
            builtinRule(listOf("print", "type", "tostring", "tonumber", "pairs", "ipairs", "next", "select", "error", "pcall", "xpcall", "require", "table", "string", "math", "io", "os")),
        )
        "markdown", "md" -> listOf(
            Rule(Regex("^#{1,6}\\s.*", RegexOption.MULTILINE), COLOR_KEYWORD),
            Rule(Regex("\\*\\*[^*]+\\*\\*"), COLOR_KEYWORD),
            Rule(Regex("__[^_]+__"), COLOR_KEYWORD),
            Rule(Regex("\\*[^*]+\\*"), COLOR_TYPE),
            Rule(Regex("_[^_]+_"), COLOR_TYPE),
            Rule(Regex("`[^`]+`"), COLOR_STRING),
            Rule(Regex("```[\\s\\S]*?```"), COLOR_STRING),
            Rule(Regex("\\[([^]]+)]\\([^)]+\\)"), COLOR_BUILTIN),
        )
        else -> emptyList()
    }
}
