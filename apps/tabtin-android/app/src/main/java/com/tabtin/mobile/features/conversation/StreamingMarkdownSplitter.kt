package com.tabtin.mobile.features.conversation

/**
 * 流式 Markdown 增量切分，对齐 Electron `splitStreamingMarkdown` /
 * iOS `StreamingMarkdownSplitter`。
 *
 * - 稳定区：最后一个 `\n\n` 之前的完整顶层块，可冻住 Markdown 渲染树
 * - 尾部区：仍在增长的最后一块，用轻量 Text 上屏
 * - 未闭合代码围栏整块退回尾部（禁止对稳定区硬补 ```）
 */
internal object StreamingMarkdownSplitter {
    data class SplitResult(val stable: String, val tail: String)

    private const val MIN_SPLITTABLE_LENGTH = 200
    private const val MIN_STABLE_LENGTH = 100

    fun split(content: String): SplitResult {
        if (content.length < MIN_SPLITTABLE_LENGTH) {
            return SplitResult(stable = "", tail = content)
        }
        val lastDoubleNewline = content.lastIndexOf("\n\n")
        if (lastDoubleNewline < MIN_STABLE_LENGTH) {
            return SplitResult(stable = "", tail = content)
        }

        var splitPos = lastDoubleNewline + 2
        var candidate = content.substring(0, splitPos)
        val fencePositions = fenceLineOffsets(candidate)

        if (fencePositions.size % 2 != 0) {
            val lastOpenFence = fencePositions.lastOrNull() ?: return SplitResult("", content)
            if (lastOpenFence <= 0) {
                return SplitResult(stable = "", tail = content)
            }
            splitPos = lastOpenFence
            candidate = content.substring(0, splitPos)
        }

        return SplitResult(
            stable = candidate,
            tail = content.substring(splitPos),
        )
    }

    private fun fenceLineOffsets(text: String): List<Int> {
        val offsets = ArrayList<Int>()
        var pos = 0
        // 与 JS split('\n') 一致：保留尾部空段
        val lines = text.split("\n")
        for (line in lines) {
            if (isFenceLine(line)) {
                offsets.add(pos)
            }
            pos += line.length + 1
        }
        return offsets
    }

    private fun isFenceLine(line: String): Boolean {
        val trimmed = line.trimStart()
        if (trimmed.isEmpty()) return false
        val marker = trimmed[0]
        if (marker != '`' && marker != '~') return false
        var count = 0
        for (ch in trimmed) {
            if (ch != marker) break
            count++
        }
        return count >= 3
    }
}
