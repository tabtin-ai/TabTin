package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AllConversationsOrganizationResetTest {

    /**
     * 回归：首次拿到组织事实曾被当成「切换」，作废了在途的首屏请求。
     * 那些请求恢复后仍会把 isLoading 置回 true，且响应又因 seq 失效被丢弃——
     * 任务列表就永远停在转圈上，且 safeLaunch 静默吞异常，界面上没有任何线索。
     */
    @Test
    fun `first organization emission is not a switch`() {
        assertFalse(shouldResetForOrganizationChange(previous = null, next = "org-1"))
    }

    @Test
    fun `switching organization resets list state`() {
        assertTrue(shouldResetForOrganizationChange(previous = "org-1", next = "org-2"))
    }

    @Test
    fun `re-emitting the same organization is not a switch`() {
        assertFalse(shouldResetForOrganizationChange(previous = "org-1", next = "org-1"))
    }
}
