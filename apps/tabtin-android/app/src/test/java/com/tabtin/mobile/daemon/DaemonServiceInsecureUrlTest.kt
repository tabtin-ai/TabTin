package com.tabtin.mobile.daemon

import org.junit.Assert.*
import org.junit.Test

/**
 * DD-002 回归测试：验证 DaemonService.isInsecureUrl() 正确识别
 * 不安全的 HTTP URL（非本地开发地址），同时放行本地开发场景。
 */
class DaemonServiceInsecureUrlTest {

    @Test
    fun `https URL is never insecure`() {
        assertFalse(DaemonService.isInsecureUrl("https://api.example.com/api"))
        assertFalse(DaemonService.isInsecureUrl("https://staging.example.com/api"))
    }

    @Test
    fun `http to remote host is insecure`() {
        assertTrue(DaemonService.isInsecureUrl("http://api.example.com/api"))
        assertTrue(DaemonService.isInsecureUrl("http://192.168.1.100:6060/api"))
        assertTrue(DaemonService.isInsecureUrl("http://example.com:8080/api"))
    }

    @Test
    fun `http to localhost is safe exception`() {
        assertFalse(DaemonService.isInsecureUrl("http://localhost:6060/api"))
        assertFalse(DaemonService.isInsecureUrl("http://localhost/api"))
    }

    @Test
    fun `http to 127_0_0_1 is safe exception`() {
        assertFalse(DaemonService.isInsecureUrl("http://127.0.0.1:6060/api"))
        assertFalse(DaemonService.isInsecureUrl("http://127.0.0.1/api"))
    }

    @Test
    fun `http to 10_0_2_2 emulator host is safe exception`() {
        assertFalse(DaemonService.isInsecureUrl("http://10.0.2.2:6060/api"))
        assertFalse(DaemonService.isInsecureUrl("http://10.0.2.2/api"))
    }

    @Test
    fun `malformed URL is treated as insecure`() {
        assertTrue(DaemonService.isInsecureUrl("http://"))
        assertTrue(DaemonService.isInsecureUrl("http:///no-host"))
    }

    @Test
    fun `non-http schemes are not insecure`() {
        assertFalse(DaemonService.isInsecureUrl("ws://api.example.com/ws"))
        assertFalse(DaemonService.isInsecureUrl("ftp://files.example.com/data"))
        assertFalse(DaemonService.isInsecureUrl(""))
    }

    @Test
    fun `host comparison is case-insensitive`() {
        assertFalse(DaemonService.isInsecureUrl("http://LOCALHOST:6060/api"))
        assertFalse(DaemonService.isInsecureUrl("http://Localhost:6060/api"))
    }
}
