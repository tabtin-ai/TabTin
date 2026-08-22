package com.tabtin.mobile.data.automation

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.tabtin.mobile.R
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

public data class PermissionDiff(
    val granted: Set<String>,
    val revoked: Set<String>,
) {
    val hasChanges: Boolean get() = granted.isNotEmpty() || revoked.isNotEmpty()
}

@Singleton
public class PermissionChecker @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    @Suppress("InlinedApi")
    private val permissionResMap: Map<String, Int> = mapOf(
        Manifest.permission.READ_SMS to R.string.perm_read_sms,
        Manifest.permission.SEND_SMS to R.string.perm_send_sms,
        Manifest.permission.READ_CONTACTS to R.string.perm_read_contacts,
        Manifest.permission.WRITE_CONTACTS to R.string.perm_write_contacts,
        Manifest.permission.READ_CALL_LOG to R.string.perm_read_call_log,
        Manifest.permission.CALL_PHONE to R.string.perm_call_phone,
        Manifest.permission.READ_CALENDAR to R.string.perm_read_calendar,
        Manifest.permission.WRITE_CALENDAR to R.string.perm_write_calendar,
        Manifest.permission.ACCESS_FINE_LOCATION to R.string.perm_fine_location,
        Manifest.permission.ACCESS_COARSE_LOCATION to R.string.perm_coarse_location,
        Manifest.permission.CAMERA to R.string.perm_camera,
        Manifest.permission.RECORD_AUDIO to R.string.perm_record_audio,
        Manifest.permission.POST_NOTIFICATIONS to R.string.perm_post_notifications,
        Manifest.permission.READ_MEDIA_IMAGES to R.string.perm_read_media_images,
        Manifest.permission.READ_MEDIA_VIDEO to R.string.perm_read_media_video,
        Manifest.permission.READ_MEDIA_AUDIO to R.string.perm_read_media_audio,
        Manifest.permission.READ_EXTERNAL_STORAGE to R.string.perm_read_storage,
        Manifest.permission.WRITE_EXTERNAL_STORAGE to R.string.perm_write_storage,
        Manifest.permission.ACCESS_BACKGROUND_LOCATION to R.string.perm_background_location,
        Manifest.permission.BLUETOOTH_CONNECT to R.string.perm_bluetooth_connect,
        Manifest.permission.BLUETOOTH_SCAN to R.string.perm_bluetooth_scan,
        Manifest.permission.NEARBY_WIFI_DEVICES to R.string.perm_nearby_wifi,
    )

    public fun friendlyName(permission: String): String {
        val resId = permissionResMap[permission]
        return if (resId != null) context.getString(resId)
        else permission.substringAfterLast('.').lowercase().replace('_', ' ')
    }

    public fun has(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    public fun checkOrError(permission: String): DeviceActionResult? {
        if (!has(permission)) {
            val name = friendlyName(permission)
            return DeviceActionResult(
                success = false,
                error = context.getString(R.string.perm_required_template, name),
                errorCode = "PERMISSION_NOT_GRANTED",
            )
        }
        return null
    }

    @Suppress("InlinedApi")
    private val capabilityPermissions: Set<String> = buildSet {
        addAll(listOf(
            Manifest.permission.READ_CONTACTS,
            Manifest.permission.READ_SMS,
            Manifest.permission.SEND_SMS,
            Manifest.permission.READ_CALL_LOG,
            Manifest.permission.CALL_PHONE,
            Manifest.permission.READ_CALENDAR,
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        ))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Manifest.permission.READ_MEDIA_IMAGES)
            add(Manifest.permission.READ_MEDIA_VIDEO)
        } else {
            add(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
    }

    /**
     * Returns the set of currently granted permissions that affect
     * capability reporting. Cache the result and later pass it to
     * [detectChanges] to discover revocations or grants.
     */
    public fun grantedCapabilityPermissions(): Set<String> =
        capabilityPermissions.filterTo(mutableSetOf()) { has(it) }

    /**
     * Compares the current permission state against [previousSnapshot]
     * (from a prior [grantedCapabilityPermissions] call) and returns
     * which permissions were gained or revoked.
     */
    public fun detectChanges(previousSnapshot: Set<String>): PermissionDiff {
        val current = grantedCapabilityPermissions()
        return PermissionDiff(
            granted = current - previousSnapshot,
            revoked = previousSnapshot - current,
        )
    }
}
