package com.tabtin.mobile.ui.theme

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import androidx.appcompat.app.AppLocalesMetadataHolderService
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class AppLocalePersistenceManifestTest {
    @Test
    fun `manifest enables AppCompat locale storage for cold starts below Android 13`() {
        val context: Context = RuntimeEnvironment.getApplication()
        val serviceInfo = context.packageManager.getServiceInfo(
            ComponentName(context, AppLocalesMetadataHolderService::class.java),
            PackageManager.GET_META_DATA or PackageManager.MATCH_DISABLED_COMPONENTS,
        )

        assertFalse(
            "metadata holder service must not run as an Android service",
            serviceInfo.enabled,
        )
        assertFalse(
            "metadata holder service must not be externally callable",
            serviceInfo.exported,
        )
        assertTrue(
            "AppCompat must persist the selected application locale before Android 13",
            serviceInfo.metaData?.getBoolean("autoStoreLocales") == true,
        )
    }
}
