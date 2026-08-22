package com.tabtin.mobile.data.adb

import java.nio.ByteBuffer
import java.nio.ByteOrder

public class AdbMessage(
    public val command: Int,
    public val arg0: Int,
    public val arg1: Int,
    public val dataLength: Int,
    public val dataCrc32: Int,
    public val magic: Int,
    public val data: ByteArray?,
) {
    public constructor(command: Int, arg0: Int, arg1: Int, data: String) : this(
        command, arg0, arg1, "$data\u0000".toByteArray(),
    )

    public constructor(command: Int, arg0: Int, arg1: Int, data: ByteArray?) : this(
        command, arg0, arg1,
        data?.size ?: 0,
        crc32(data),
        (command.toLong() xor 0xFFFFFFFF).toInt(),
        data,
    )

    public fun validate(): Boolean {
        if (command != magic xor -0x1) return false
        if (dataLength != 0 && crc32(data) != dataCrc32) return false
        return true
    }

    public fun toByteArray(): ByteArray {
        val length = AdbProtocol.HEADER_LENGTH + (data?.size ?: 0)
        return ByteBuffer.allocate(length).apply {
            order(ByteOrder.LITTLE_ENDIAN)
            putInt(command)
            putInt(arg0)
            putInt(arg1)
            putInt(dataLength)
            putInt(dataCrc32)
            putInt(magic)
            data?.let { put(it) }
        }.array()
    }

    public companion object {
        private fun crc32(data: ByteArray?): Int {
            if (data == null) return 0
            var res = 0
            for (b in data) {
                res += if (b >= 0) b.toInt() else b.toInt() + 256
            }
            return res
        }
    }
}
