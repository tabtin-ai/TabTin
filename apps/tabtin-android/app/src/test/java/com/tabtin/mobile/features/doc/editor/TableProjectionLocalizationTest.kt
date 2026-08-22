package com.tabtin.mobile.features.doc.editor

import android.app.Application
import android.content.Context
import android.content.res.Configuration
import androidx.test.core.app.ApplicationProvider
import com.tabtin.mobile.features.doc.model.TableCell
import com.tabtin.mobile.features.doc.model.TableCellProjection
import com.tabtin.mobile.features.doc.model.TableContentSummaryKind
import com.tabtin.mobile.features.doc.model.TableData
import com.tabtin.mobile.features.doc.model.TableRow
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class TableProjectionLocalizationTest {
    @Test
    fun `ui and clipboard resolve semantic summaries in Chinese and English`() {
        val projection = TableCellProjection.join(
            listOf(
                TableCellProjection.summary(TableContentSummaryKind.WHITEBOARD, "Roadmap"),
                TableCellProjection.summary(TableContentSummaryKind.EMBEDDED_TABLE),
                TableCellProjection.summary(TableContentSummaryKind.EMBEDDED_HTML),
                TableCellProjection.summary(TableContentSummaryKind.VIDEO),
                TableCellProjection.summary(TableContentSummaryKind.COMPLEX_CONTENT),
            ),
            separator = "\n",
        )
        val cell = TableCell(isReadOnlyProjection = true, projection = projection)
        val table = TableData(listOf(TableRow(listOf(cell))))

        val english = localizedContext(Locale.ENGLISH)
        val englishText = """
            Whiteboard Roadmap
            Embedded table
            Embedded HTML
            Video
            Unsupported content
        """.trimIndent()
        assertEquals(englishText, TableProjectionLocalization.cellText(english, cell))
        assertEquals(englishText, TableProjectionLocalization.tableText(english, table))

        val chinese = localizedContext(Locale.SIMPLIFIED_CHINESE)
        val chineseText = """
            画板 Roadmap
            嵌入的多维表
            嵌入的 HTML
            视频
            暂不支持的内容
        """.trimIndent()
        assertEquals(chineseText, TableProjectionLocalization.cellText(chinese, cell))
        assertEquals(chineseText, TableProjectionLocalization.tableText(chinese, table))
    }

    private fun localizedContext(locale: Locale): Context {
        val app = ApplicationProvider.getApplicationContext<Context>()
        val configuration = Configuration(app.resources.configuration).apply { setLocale(locale) }
        return app.createConfigurationContext(configuration)
    }
}
