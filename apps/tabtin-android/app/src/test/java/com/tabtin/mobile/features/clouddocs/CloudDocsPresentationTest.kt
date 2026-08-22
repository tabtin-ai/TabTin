package com.tabtin.mobile.features.clouddocs

import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.tabtin.mobile.data.model.SharedResourceOwner
import com.tabtin.mobile.ui.theme.IdentityAvatar
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, qualifiers = "zh-rCN")
class CloudDocsPresentationTest {
    @Test
    fun lastModified_prefixesParsedOffsetTimestamp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val label = CloudDocsPresentation.lastModified(context, "2026-07-20T00:00:00+00:00")
        assertNotNull(label)
        assertTrue(label!!.startsWith("最近修改："))
    }

    @Test
    fun lastModified_blankTimestampIsHidden() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        assertNull(CloudDocsPresentation.lastModified(context, null))
        assertNull(CloudDocsPresentation.lastModified(context, "not-a-date"))
    }

    @Test
    fun sharerAvatar_keepsColorWhenDisplayNameChanges() {
        val userId = "05a81772-b342-4590-a4a1-ed423f5e1a4d"
        val renamed = CloudDocsPresentation.sharerAvatar(
            SharedResourceOwner(id = userId, displayName = "林工（已离职）", avatar = "https://cdn.example/a.png"),
        )
        assertNotNull(renamed)
        assertEquals(userId, renamed!!.seed)
        assertEquals(IdentityAvatar.colorSeed(userId, "林工"), renamed.seed)
        assertEquals("https://cdn.example/a.png", renamed.imageUrl)
    }

    @Test
    fun sharerAvatar_ignoresEmptyOwner() {
        assertNull(CloudDocsPresentation.sharerAvatar(null))
        assertNull(CloudDocsPresentation.sharerAvatar(SharedResourceOwner()))
    }
}
