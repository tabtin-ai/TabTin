package com.tabtin.mobile.daemon

import org.junit.Assert.*
import org.junit.Test

/**
 * DD-010 回归测试：验证 DaemonReceiver.isTrustedCaller() 正确区分
 * 受信来源（ADB shell / root / 同应用）和不受信来源（第三方应用）。
 */
class DaemonReceiverCallerCheckTest {

    companion object {
        private const val SHELL_UID = 2000
        private const val ROOT_UID = 0
        private const val MY_UID = 10150
        private const val THIRD_PARTY_UID = 10200
    }

    @Test
    fun `ADB shell uid is trusted`() {
        assertTrue(DaemonReceiver.isTrustedCaller(SHELL_UID, MY_UID))
    }

    @Test
    fun `root uid is trusted`() {
        assertTrue(DaemonReceiver.isTrustedCaller(ROOT_UID, MY_UID))
    }

    @Test
    fun `same app uid is trusted`() {
        assertTrue(DaemonReceiver.isTrustedCaller(MY_UID, MY_UID))
    }

    @Test
    fun `third party app uid is not trusted`() {
        assertFalse(DaemonReceiver.isTrustedCaller(THIRD_PARTY_UID, MY_UID))
    }

    @Test
    fun `various third party uids are all blocked`() {
        val untrustedUids = listOf(10001, 10099, 10300, 99999)
        for (uid in untrustedUids) {
            assertFalse(
                "uid=$uid should not be trusted",
                DaemonReceiver.isTrustedCaller(uid, MY_UID),
            )
        }
    }

    @Test
    fun `system uid 1000 is not trusted`() {
        assertFalse(DaemonReceiver.isTrustedCaller(1000, MY_UID))
    }

    @Test
    fun `ACTION_ACTIVATE constant matches expected value`() {
        assertEquals("com.tabtin.daemon.ACTIVATE", DaemonReceiver.ACTION_ACTIVATE)
    }
}
