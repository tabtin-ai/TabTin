package com.tabtin.mobile.data.repository

import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
public class NativeCloudDraftCleanerTest {
    private lateinit var context: Context

    @Before
    public fun setup() {
        context = ApplicationProvider.getApplicationContext()
        context.deleteSharedPreferences(TABDOC_DRAFT_PREFERENCES)
        context.deleteSharedPreferences(TABDATA_DRAFT_PREFERENCES)
    }

    @Test
    public fun `logout cleaner removes document and table drafts`() {
        context.getSharedPreferences(TABDOC_DRAFT_PREFERENCES, Context.MODE_PRIVATE)
            .edit().putString("doc", "draft").commit()
        context.getSharedPreferences(TABDATA_DRAFT_PREFERENCES, Context.MODE_PRIVATE)
            .edit().putString("table", "draft").commit()

        NativeCloudDraftCleaner(context).clearAll()

        assertFalse(context.getSharedPreferences(TABDOC_DRAFT_PREFERENCES, Context.MODE_PRIVATE).contains("doc"))
        assertFalse(context.getSharedPreferences(TABDATA_DRAFT_PREFERENCES, Context.MODE_PRIVATE).contains("table"))
    }
}
