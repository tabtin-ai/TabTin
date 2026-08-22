package com.tabtin.mobile.features.conversation

/**
 * 流式才切稳定区 / 尾巴。收束不重新切分全文：
 * 若仍是流式期冻住的前缀，只把尾巴转成 Markdown；对不上再整段 parse。
 * 禁止对收束全文再跑 splitter，避免把表格 / 计划拆成两段。
 */
internal object StreamingMarkdownContinuityPolicy {
    internal enum class TailRenderer {
        PlainText,
        Markdown,
    }

    internal data class Layout(
        val stable: String,
        val tail: String,
        val tailRenderer: TailRenderer,
    ) {
        val hasStable: Boolean get() = stable.isNotEmpty()
        val stableIdentity: String get() = stable
    }

    fun layout(
        content: String,
        isStreaming: Boolean,
        lastStreamingStable: String = "",
    ): Layout {
        if (isStreaming) {
            val split = StreamingMarkdownSplitter.split(content)
            return Layout(
                stable = split.stable,
                tail = split.tail,
                tailRenderer = TailRenderer.PlainText,
            )
        }
        if (lastStreamingStable.isNotEmpty() && content.startsWith(lastStreamingStable)) {
            return Layout(
                stable = lastStreamingStable,
                tail = content.substring(lastStreamingStable.length),
                tailRenderer = TailRenderer.Markdown,
            )
        }
        return Layout(
            stable = "",
            tail = content,
            tailRenderer = TailRenderer.Markdown,
        )
    }
}
