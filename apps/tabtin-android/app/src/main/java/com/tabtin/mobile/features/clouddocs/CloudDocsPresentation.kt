package com.tabtin.mobile.features.clouddocs

import android.content.Context
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.SharedResourceOwner
import com.tabtin.mobile.ui.theme.IdentityAvatar
import com.tabtin.mobile.util.RelativeTimeFormatter

internal data class CloudDocsSharerAvatar(
    val name: String,
    val seed: String,
    val imageUrl: String?,
)

/** 云文档列表行上的修改时间文案和分享人头像，不进 Compose。 */
internal object CloudDocsPresentation {
    fun lastModified(context: Context, raw: String?): String? {
        val relative = raw?.let { RelativeTimeFormatter.format(context, it) } ?: return null
        return context.getString(R.string.cloud_docs_recently_modified_at, relative)
    }

    fun sharerAvatar(owner: SharedResourceOwner?): CloudDocsSharerAvatar? {
        if (owner == null) return null
        val name = owner.displayName.trim()
        val id = owner.id.trim()
        val imageUrl = owner.avatar?.trim()?.takeIf { it.isNotEmpty() }
        if (name.isEmpty() && id.isEmpty() && imageUrl == null) return null
        return CloudDocsSharerAvatar(
            name = name.ifEmpty { "?" },
            seed = IdentityAvatar.colorSeed(id, name),
            imageUrl = imageUrl,
        )
    }
}
