package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertEquals
import org.junit.Test

class CameraAccessPolicyTest {
    @Test
    fun `available camera with permission opens camera`() {
        assertEquals(
            CameraAccessAction.OPEN_CAMERA,
            cameraAccessAction(cameraAvailable = true, permissionGranted = true),
        )
    }

    @Test
    fun `available camera without permission requests permission`() {
        assertEquals(
            CameraAccessAction.REQUEST_PERMISSION,
            cameraAccessAction(cameraAvailable = true, permissionGranted = false),
        )
    }

    @Test
    fun `missing camera reports unavailable before requesting permission`() {
        assertEquals(
            CameraAccessAction.SHOW_UNAVAILABLE,
            cameraAccessAction(cameraAvailable = false, permissionGranted = false),
        )
    }
}
