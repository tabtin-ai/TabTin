package com.tabtin.mobile.features.conversation

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.features.clouddocs.TabTinAppIcon
import com.tabtin.mobile.features.clouddocs.TabTinAppIconVariant
import com.tabtin.mobile.features.files.CloudDriveFilePresentation
import com.tabtin.mobile.features.files.CloudDriveResourceIcon

/** Composer 上下文资源图标，双端统一走 TabTin glyph 与云盘文件分类。 */
@Composable
internal fun ContextResourceIcon(
    itemType: String,
    title: String? = null,
    mimeType: String? = null,
    size: Dp = 22.dp,
    modifier: Modifier = Modifier,
) {
    val normalized = SpaceResource.normalizedType(itemType)
    if (normalized == "tabdoc" || normalized == "tabdata" || normalized == "tabfiles") {
        CloudDriveResourceIcon(
            category = CloudDriveFilePresentation.classify(normalized, title, mimeType),
            size = size,
            modifier = modifier,
        )
        return
    }

    val appId = if (normalized == "tabsite") "tabweb" else normalized
    val variant = if (appId == "tabweb") {
        TabTinAppIconVariant.GLYPH
    } else {
        TabTinAppIconVariant.APP
    }
    TabTinAppIcon(
        appId = appId,
        variant = variant,
        size = size,
        modifier = modifier,
    )
}

@Composable
internal fun ContextResourceIcon(
    resource: SpaceResource,
    size: Dp = 22.dp,
    modifier: Modifier = Modifier,
) {
    ContextResourceIcon(
        itemType = resource.normalizedType,
        title = resource.fileName,
        mimeType = resource.mimeType,
        size = size,
        modifier = modifier,
    )
}
