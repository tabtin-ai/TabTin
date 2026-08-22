package com.tabtin.mobile.features.doc

import android.graphics.Color
import android.widget.TextView
import androidx.core.content.ContextCompat
import com.tabtin.mobile.R

/**
 * 格子检查面板里的输入框是代码创建的，不会吃到 [R.style.DocBlockTextContent]。
 * 弹层主题会把未聚焦 EditText 画成浅灰提示色，必须显式钉正文主色。
 */
internal object TableCellEditorPresentation {
    fun applyReadableBodyColor(view: TextView) {
        view.setTextColor(ContextCompat.getColor(view.context, R.color.doc_editor_text_primary))
        view.setHintTextColor(ContextCompat.getColor(view.context, R.color.doc_editor_text_tertiary))
        view.setBackgroundColor(Color.TRANSPARENT)
    }
}
