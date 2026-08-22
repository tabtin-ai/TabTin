package com.tabtin.mobile.features.doc.editor

import android.app.Application
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.view.ContextThemeWrapper
import android.view.LayoutInflater
import android.widget.FrameLayout
import androidx.test.core.app.ApplicationProvider
import com.tabtin.mobile.R
import com.tabtin.mobile.databinding.DocBlockTableBinding
import com.tabtin.mobile.databinding.DocBlockUnsupportedBinding
import com.tabtin.mobile.features.doc.editor.core.BlockViewConverter
import com.tabtin.mobile.features.doc.editor.core.DocSpan
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import com.tabtin.mobile.features.doc.editor.core.TabDocMarkup
import com.tabtin.mobile.features.doc.editor.core.toSpannable
import com.tabtin.mobile.features.doc.editor.holders.TableHolder
import com.tabtin.mobile.features.doc.editor.holders.UnsupportedHolder
import com.tabtin.mobile.features.doc.model.ProseMirrorParser
import java.util.Locale
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class UnsupportedContentLocalizationTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `fixture presentation current and target match embedded block holders in both product languages`() {
        val sourceNodes = documentNodes()
        val expectations = blockExpectations()
        val summaryEntries = expectations.mapIndexedNotNull { index, expectation ->
            if (expectation.string("disposition") != "summary") return@mapIndexedNotNull null
            val presentation = expectation["presentation"]?.jsonObject
            val target = presentation?.string("target") ?: "product_label_only"
            val current = presentation
                ?.get("current")?.jsonObject
                ?.string("android")
                ?: "product_label_only"
            SummaryEntry(
                source = sourceNodes[index].jsonObject,
                rawType = sourceNodes[index].jsonObject.string("type"),
                currentPresentation = current,
                targetPresentation = target,
            )
        }
        assertEquals(
            listOf("tabdataBlock", "tabwhiteboard", "htmlBlock", "youtube"),
            summaryEntries.map(SummaryEntry::rawType),
        )
        assertEquals(
            listOf(
                "product_label_with_title",
                "product_label_with_title",
                "product_label_with_title",
                "product_label_only",
            ),
            summaryEntries.map(SummaryEntry::targetPresentation),
        )

        assertEmbeddedHolderPresentation(
            localizedContext(Locale.ENGLISH),
            summaryEntries,
            listOf(
                ExpectedSummary("Embedded table", "项目任务表"),
                ExpectedSummary("Whiteboard", "架构草图"),
                ExpectedSummary("Embedded HTML", "交互报表"),
                ExpectedSummary("Video"),
            ),
        )
        assertEmbeddedHolderPresentation(
            localizedContext(Locale.SIMPLIFIED_CHINESE),
            summaryEntries,
            listOf(
                ExpectedSummary("嵌入的多维表", "项目任务表"),
                ExpectedSummary("画板", "架构草图"),
                ExpectedSummary("嵌入的 HTML", "交互报表"),
                ExpectedSummary("视频"),
            ),
        )
    }

    @Test
    fun `known embedded holders accept only nonblank string title candidates`() {
        val cases = listOf(
            Triple(
                buildJsonObject {
                    put("type", "tabdataBlock")
                    put("attrs", buildJsonObject {
                        put("title", "   ")
                        put("name", "名称候选")
                        put("tableId", "tbl-private")
                    })
                },
                "Embedded table",
                "名称候选",
            ),
            Triple(
                buildJsonObject {
                    put("type", "tabwhiteboard")
                    put("attrs", buildJsonObject {
                        put("name", 42)
                        put("alt", "替代标题")
                        put("canvasId", "cvs-private")
                    })
                },
                "Whiteboard",
                "替代标题",
            ),
            Triple(
                buildJsonObject {
                    put("type", "htmlBlock")
                    put("attrs", buildJsonObject {
                        put("label", "标签标题")
                        put("src", "https://secret.example/private.html")
                        put("fileId", "file-private")
                    })
                },
                "Embedded HTML",
                "标签标题",
            ),
        )

        cases.forEach { (source, expectedLabel, expectedTitle) ->
            val rendered = renderedUnsupportedText(source, Locale.ENGLISH)
            assertEquals(expectedLabel, rendered.label)
            assertEquals(expectedTitle, rendered.title)
            assertTrue("有安全标题时标题层必须可见", rendered.titleVisible)
            assertFalse(rendered.visibleText.contains("tbl-private"))
            assertFalse(rendered.visibleText.contains("cvs-private"))
            assertFalse(rendered.visibleText.contains("file-private"))
            assertFalse(rendered.visibleText.contains("https://secret.example/private.html"))
        }
    }

    @Test
    fun `known embedded holders skip sensitive aliases before choosing a title`() {
        val safeTitle = "普通中文标题"
        val sensitiveKeys = listOf(
            "tableId",
            "viewId",
            "canvasId",
            "fileId",
            "src",
            "href",
            "url",
        )
        val sources = buildList {
            add(
                buildJsonObject {
                    put("type", "tabdataBlock")
                    put("attrs", buildJsonObject {
                        put("title", " tabdataBlock ")
                        put("name", "tbl-private")
                        put("alt", "https://secret.example/private")
                        put("label", safeTitle)
                        put("tableId", "tbl-private")
                        put("src", "https://secret.example/private")
                    })
                },
            )
            sensitiveKeys.forEach { sensitiveKey ->
                val sensitiveValue = "$sensitiveKey-private"
                add(
                    buildJsonObject {
                        put("type", "tabdataBlock")
                        put("attrs", buildJsonObject {
                            put("title", " $sensitiveValue ")
                            put("name", safeTitle)
                            put(sensitiveKey, sensitiveValue)
                        })
                    },
                )
            }
        }

        sources.forEach { source ->
            val rendered = renderedUnsupportedText(source, Locale.SIMPLIFIED_CHINESE)
            assertEquals(safeTitle, rendered.title)
            assertTrue("跳过不安全候选后必须继续呈现普通标题", rendered.titleVisible)
        }

        val explicitUrlTitle = "https://user.example/项目主页"
        val userNamedUrl = buildJsonObject {
            put("type", "htmlBlock")
            put("attrs", buildJsonObject {
                put("title", explicitUrlTitle)
                put("src", "https://content.example/embed.html")
            })
        }
        assertEquals(
            explicitUrlTitle,
            renderedUnsupportedText(userNamedUrl, Locale.SIMPLIFIED_CHINESE).title,
        )
    }

    @Test
    fun `unknown block never promotes attrs to a user visible title`() {
        val unknown = buildJsonObject {
            put("type", "futureWidget")
            put("attrs", buildJsonObject {
                put("title", "机密实现标题")
                put("name", "机密名称")
                put("src", "https://secret.example/widget")
                put("tableId", "tbl-secret")
            })
        }

        listOf(
            Locale.ENGLISH to "Unsupported content",
            Locale.SIMPLIFIED_CHINESE to "暂不支持的内容",
        ).forEach { (locale, expectedLabel) ->
            val rendered = renderedUnsupportedText(unknown, locale)
            assertEquals(expectedLabel, rendered.label)
            assertEquals(null, rendered.title)
            assertFalse("未知块的标题层必须隐藏", rendered.titleVisible)
            listOf(
                "futureWidget",
                "机密实现标题",
                "机密名称",
                "https://secret.example/widget",
                "tbl-secret",
            ).forEach { secret ->
                assertFalse(rendered.visibleText.contains(secret, ignoreCase = true))
            }
        }
    }

    @Test
    fun `fixture formula presentation current is produced by the real renderer and holder`() {
        val sourceNodes = documentNodes()
        val expectations = blockExpectations()
        val inlineFormulaExpectation = expectations[7]
        val blockFormulaExpectation = expectations[8]
        assertEquals(
            "formula_rendered",
            inlineFormulaExpectation.presentationCurrent("android"),
        )
        assertEquals(
            "formula_rendered",
            blockFormulaExpectation.presentationCurrent("android"),
        )

        val inlineFormulaView = viewFor(sourceNodes[7].jsonObject)
            as TabDocBlockView.TextSupport
        val rendered = object : TabDocMarkup {
            override val body: String = inlineFormulaView.body
            override val marks: List<TabDocMarkup.Mark> = inlineFormulaView.marks
        }.toSpannable(
            textColor = Color.BLACK,
            formulaProvider = {
                android.graphics.drawable.ColorDrawable(Color.BLUE).apply {
                    setBounds(0, 0, 24, 16)
                }
            },
        )
        assertEquals(
            "公式真渲染必须由 MathematicsDrawable 覆盖原子",
            1,
            rendered.getSpans(0, rendered.length, DocSpan.MathematicsDrawable::class.java).size,
        )
        assertEquals(
            "真渲染后不再用源码斜体 span",
            0,
            rendered.getSpans(0, rendered.length, DocSpan.MathematicsStyle::class.java).size,
        )
        assertFalse(rendered.toString().contains("blk-p-0008"))

        val blockView = viewFor(sourceNodes[8].jsonObject)
        assertTrue(
            "块级公式必须离开通用不支持占位，进入专用 Formula 视图",
            blockView is TabDocBlockView.Formula,
        )
        val formula = blockView as TabDocBlockView.Formula
        assertTrue(formula.latex.contains("\\int_0^1"))
        assertFalse(formula.latex.contains("mathematicsBlock", ignoreCase = true))
    }

    @Test
    fun `fixture complex table holder shows a localized read only summary without ids`() {
        val complexTable = documentNodes()[17].jsonObject
        val view = viewFor(complexTable) as TabDocBlockView.Table
        assertTrue("合并单元格表格必须进入整块只读展示", view.isReadonly)

        listOf(
            Locale.ENGLISH to "2 rows × 3 columns · Read-only preview",
            Locale.SIMPLIFIED_CHINESE to "2 行 × 3 列 · 只读预览",
        ).forEach { (locale, expectedSummary) ->
            val context = themedContext(locale)
            val binding = DocBlockTableBinding.inflate(LayoutInflater.from(context))
            val holder = TableHolder(binding)
            holder.bind(view)
            holder.setReadOnly(view.isReadonly)

            assertEquals(expectedSummary, binding.tableMeta.text.toString())
            val visibleText = buildString {
                append(binding.tableMeta.text)
                for (rowIndex in 0 until binding.tableLayout.childCount) {
                    val row = binding.tableLayout.getChildAt(rowIndex) as? android.view.ViewGroup
                        ?: continue
                    for (cellIndex in 0 until row.childCount) {
                        append(
                            (row.getChildAt(cellIndex) as? android.widget.TextView)
                                ?.text?.toString().orEmpty(),
                        )
                    }
                }
            }
            assertTrue(visibleText.contains("跨两列的合并表头"))
            assertFalse(visibleText.contains("blk-t-0040"))
            assertFalse(visibleText.contains("blk-p-0041"))
        }
    }

    @Test
    fun `unknown schema type uses a generic label without leaking implementation name`() {
        listOf(Locale.ENGLISH, Locale.SIMPLIFIED_CHINESE).forEach { locale ->
            val label = UnsupportedContentLocalization.label(localizedContext(locale), "futureWidget")
            assertFalse(label.contains("futureWidget", ignoreCase = true))
        }
    }

    private data class SummaryEntry(
        val source: JsonObject,
        val rawType: String,
        val currentPresentation: String,
        val targetPresentation: String,
    )

    private data class ExpectedSummary(
        val label: String,
        val title: String? = null,
    )

    private data class RenderedSummary(
        val label: String,
        val title: String?,
        val titleVisible: Boolean,
    ) {
        val visibleText: String
            get() = listOfNotNull(label, title.takeIf { titleVisible }).joinToString("\n")
    }

    private fun assertEmbeddedHolderPresentation(
        context: Context,
        entries: List<SummaryEntry>,
        expectedSummaries: List<ExpectedSummary>,
    ) {
        val actual = entries.map { entry ->
            renderedUnsupportedText(entry.source, context)
        }
        actual.forEachIndexed { index, rendered ->
            val entry = entries[index]
            val expected = expectedSummaries[index]
            assertEquals(expected.label, rendered.label)
            assertEquals(expected.title, rendered.title)
            assertEquals(expected.title != null, rendered.titleVisible)
            val actualPresentation = if (rendered.titleVisible) {
                "product_label_with_title"
            } else {
                "product_label_only"
            }
            assertEquals(entry.currentPresentation, actualPresentation)
            assertEquals(entry.targetPresentation, entry.currentPresentation)
            assertFalse(rendered.visibleText.contains(entry.rawType, ignoreCase = true))
            val attrs = entry.source["attrs"]?.jsonObject
            listOf("tableId", "viewId", "canvasId", "fileId", "src").forEach { key ->
                attrs?.get(key)?.jsonPrimitive?.contentOrNull?.let { identity ->
                    assertFalse("产品摘要不得显示 $key", rendered.visibleText.contains(identity))
                }
            }
            attrs?.get("title")?.jsonPrimitive?.contentOrNull
                ?.takeIf(String::isNotBlank)
                ?.let { title ->
                    assertEquals(expected.title != null, rendered.title == title)
                }
        }
    }

    private fun renderedUnsupportedText(source: JsonObject, locale: Locale): RenderedSummary =
        renderedUnsupportedText(source, localizedContext(locale))

    private fun renderedUnsupportedText(source: JsonObject, context: Context): RenderedSummary {
        val binding = unsupportedBinding(context)
        val view = viewFor(source) as TabDocBlockView.Unsupported
        UnsupportedHolder(binding).bind(view)
        return RenderedSummary(
            label = binding.label.text.toString(),
            title = binding.title.text.toString().takeIf(String::isNotEmpty),
            titleVisible = binding.title.visibility == android.view.View.VISIBLE,
        )
    }

    private fun localizedContext(locale: Locale): Context {
        val app = ApplicationProvider.getApplicationContext<Context>()
        val configuration = Configuration(app.resources.configuration).apply { setLocale(locale) }
        return app.createConfigurationContext(configuration)
    }

    private fun themedContext(locale: Locale): Context = ContextThemeWrapper(
        localizedContext(locale),
        R.style.Theme_TabTin,
    )

    private fun unsupportedBinding(context: Context): DocBlockUnsupportedBinding =
        DocBlockUnsupportedBinding.inflate(
            LayoutInflater.from(themedContext(context.resources.configuration.locales[0])),
            FrameLayout(context),
            false,
        )

    private fun viewFor(source: JsonObject): TabDocBlockView {
        val blocks = ProseMirrorParser.parseBlocks(
            buildJsonObject {
                put("type", "doc")
                put("content", JsonArray(listOf(source)))
            },
        )
        assertEquals("presentation fixture 必须映射为单个原生块", 1, blocks.size)
        return BlockViewConverter.toBlockViews(blocks).single()
    }

    private fun documentNodes(): JsonArray = fixture("rich-mixed.pm.json")
        .jsonObject.getValue("doc").jsonObject.getValue("content").jsonArray

    private fun blockExpectations(): List<JsonObject> = fixture("rich-mixed.expectations.json")
        .jsonObject.getValue("blocks").jsonArray.filterIsInstance<JsonObject>()

    private fun fixture(name: String) = json.parseToJsonElement(
            requireNotNull(
            javaClass.classLoader?.getResourceAsStream("mobile-contract/doc/$name"),
            ).bufferedReader().use { it.readText() },
        )

    private fun JsonObject.string(key: String): String =
        get(key)?.jsonPrimitive?.contentOrNull.orEmpty()

    private fun JsonObject.presentationCurrent(platform: String): String? =
        get("presentation")?.jsonObject
            ?.get("current")?.jsonObject
            ?.string(platform)
}
