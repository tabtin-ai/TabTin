package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertEquals
import org.junit.Test

class CapsulePlacementGeometryTest {
    @Test
    fun defaultPlacementIsBottomRight() {
        val (x, y) = CapsulePlacementGeometry.position(
            CapsulePlacement.DEFAULT,
            viewportWidth = 390f,
            viewportHeight = 844f,
            capsuleWidth = 160f,
            capsuleHeight = 48f,
        )
        val bounds = CapsulePlacementGeometry.resolveBounds(390f, 844f, 160f, 48f)
        assertEquals(bounds.maxX, x, 0.01f)
        assertEquals(bounds.maxY, y, 0.01f)
    }

    @Test
    fun dockSnapsToNearestSide() {
        val placement = CapsulePlacementGeometry.placement(
            x = 40f,
            y = 400f,
            viewportWidth = 390f,
            viewportHeight = 844f,
            capsuleWidth = 160f,
            capsuleHeight = 48f,
        )
        assertEquals(CapsuleDockSide.LEFT, placement.side)
        val (x, _) = CapsulePlacementGeometry.dockedPosition(
            x = 40f,
            y = 400f,
            viewportWidth = 390f,
            viewportHeight = 844f,
            capsuleWidth = 160f,
            capsuleHeight = 48f,
        )
        val bounds = CapsulePlacementGeometry.resolveBounds(390f, 844f, 160f, 48f)
        assertEquals(bounds.minX, x, 0.01f)
    }

    @Test
    fun yRatioClamped() {
        val bounds = CapsulePlacementGeometry.resolveBounds(390f, 844f, 48f, 48f)
        val (_, topY) = CapsulePlacementGeometry.position(
            CapsulePlacement(CapsuleDockSide.RIGHT, -1f),
            390f,
            844f,
            48f,
            48f,
        )
        val (_, bottomY) = CapsulePlacementGeometry.position(
            CapsulePlacement(CapsuleDockSide.RIGHT, 2f),
            390f,
            844f,
            48f,
            48f,
        )
        assertEquals(bounds.minY, topY, 0.01f)
        assertEquals(bounds.maxY, bottomY, 0.01f)
    }
}
