package com.tabtin.mobile.features.clouddocs

import com.tabtin.mobile.features.files.CloudDriveFileCategory

internal enum class CloudFileDetailAction {
    PREVIEW,
    OPEN_EXTERNALLY,
    DOWNLOAD,
    COPY_LINK,
    SHARE,
    COLLABORATORS,
    TRASH,
}

internal data class CloudFileDetailMetadata(
    val mimeType: String,
    val location: String,
    val sizeBytes: Long?,
)

internal object CloudFileDetailPresentation {
    fun showsLiveImage(category: CloudDriveFileCategory): Boolean =
        category == CloudDriveFileCategory.IMAGE

    fun actions(
        canPreview: Boolean,
        hasShareableLink: Boolean,
        canManageCollaborators: Boolean,
        canTrash: Boolean,
    ): List<CloudFileDetailAction> = buildList {
        if (canPreview) {
            add(CloudFileDetailAction.PREVIEW)
            add(CloudFileDetailAction.OPEN_EXTERNALLY)
        }
        add(CloudFileDetailAction.DOWNLOAD)
        if (hasShareableLink) {
            add(CloudFileDetailAction.COPY_LINK)
            add(CloudFileDetailAction.SHARE)
        }
        if (canManageCollaborators) add(CloudFileDetailAction.COLLABORATORS)
        if (canTrash) add(CloudFileDetailAction.TRASH)
    }

    fun metadata(
        mimeType: String?,
        typeLabel: String,
        sizeBytes: Long?,
        spaceName: String?,
        organizationCloudLabel: String,
    ): CloudFileDetailMetadata = CloudFileDetailMetadata(
        mimeType = mimeType?.trim()?.takeIf { it.isNotEmpty() } ?: typeLabel,
        location = spaceName?.trim()?.takeIf { it.isNotEmpty() } ?: organizationCloudLabel,
        sizeBytes = sizeBytes?.takeIf { it > 0L },
    )
}
