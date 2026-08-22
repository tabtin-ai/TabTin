package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ConversationFocusContext
import com.tabtin.mobile.features.workbench.WorkbenchFocusTarget
import com.tabtin.mobile.features.workbench.WorkbenchNavigationPane
import com.tabtin.mobile.features.workbench.WorkbenchResourceOpenRequest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class ComposerFocusFreezeTest {
    @Test
    fun `composer path freezes current workbench like capsule`() {
        val target = WorkbenchFocusTarget(
            appType = "tabdoc",
            resourceId = "doc-1",
            title = "周报",
            pane = WorkbenchNavigationPane.Detail(
                kind = null,
                request = WorkbenchResourceOpenRequest(
                    resourceType = "tabdoc",
                    resourceId = "doc-1",
                    title = "周报",
                ),
            ),
        )
        val frozen = ComposerFocusFreeze.resolveForEnqueue(
            requestFocus = null,
            spaceId = "space-1",
            target = target,
        )
        val capsule = TaskFocusSnapshot.from(spaceId = "space-1", target = target)

        assertEquals(capsule.appType, frozen.appType)
        assertEquals(capsule.spaceId, frozen.spaceId)
        assertEquals(capsule.workspaceMode, frozen.workspaceMode)
        assertEquals(
            (capsule.appMeta!!["current_doc_id"] as JsonPrimitive).contentOrNull,
            (frozen.appMeta!!["current_doc_id"] as JsonPrimitive).contentOrNull,
        )
        assertEquals(capsule.openTabs!!.single().id, frozen.openTabs!!.single().id)
    }

    @Test
    fun `explicit request focus wins over current workbench`() {
        val explicit = ConversationFocusContext(
            appType = "tabdoc",
            spaceId = "space-frozen",
            workspaceMode = "conversation",
        )
        val target = WorkbenchFocusTarget(
            appType = "tabdata",
            resourceId = "table-new",
            pane = WorkbenchNavigationPane.Overview,
        )
        val resolved = ComposerFocusFreeze.resolveForEnqueue(
            requestFocus = explicit,
            spaceId = "space-live",
            target = target,
        )
        assertSame(explicit, resolved)
        assertEquals("space-frozen", resolved.spaceId)
        assertNull(resolved.openTabs)
    }

    @Test
    fun `composer freeze keeps tabdata current_view_id`() {
        val target = WorkbenchFocusTarget(
            appType = "tabdata",
            resourceId = "table-1",
            title = "销售表",
            viewId = "view-xyz",
            pane = WorkbenchNavigationPane.Detail(
                kind = null,
                request = WorkbenchResourceOpenRequest(
                    resourceType = "tabdata",
                    resourceId = "table-1",
                    title = "销售表",
                ),
            ),
        )
        val frozen = ComposerFocusFreeze.resolveForEnqueue(
            requestFocus = null,
            spaceId = "space-1",
            target = target,
        )
        assertEquals(
            "view-xyz",
            (frozen.appMeta!!["current_view_id"] as JsonPrimitive).contentOrNull,
        )
        assertEquals(
            "table-1",
            (frozen.appMeta!!["current_table_id"] as JsonPrimitive).contentOrNull,
        )
    }
}
