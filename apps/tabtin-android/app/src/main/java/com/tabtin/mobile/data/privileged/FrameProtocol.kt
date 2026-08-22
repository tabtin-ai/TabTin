package com.tabtin.mobile.data.privileged

import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

/**
 * Length-prefixed frame protocol for IPC between main app and privileged process.
 *
 * Frame format: [4 bytes: type] [4 bytes: length] [length bytes: payload]
 *
 * Types:
 *   0x01 = JSON control message (request/response/heartbeat)
 *   0x02 = Binary data (screenshot etc., follows its JSON response)
 */
internal object FrameProtocol {
    public const val TYPE_JSON: Int = 0x01
    public const val TYPE_BINARY: Int = 0x02
    public const val MAX_FRAME_SIZE: Int = 24 * 1024 * 1024

    private val VALID_TYPES = setOf(TYPE_JSON, TYPE_BINARY)

    /**
     * Protocol-level error indicating the stream is corrupted and must be closed.
     * Extends [IOException] so callers treating IO errors as reconnect triggers
     * will automatically handle protocol violations.
     */
    public class FrameProtocolException(message: String) : IOException(message)

    /**
     * Write a single frame. Synchronizes on [out] to prevent interleaved writes
     * when multiple coroutines share the same output stream.
     *
     * @throws FrameProtocolException if type is unknown or payload exceeds [MAX_FRAME_SIZE]
     */
    public fun writeFrame(out: OutputStream, type: Int, payload: ByteArray) {
        if (type !in VALID_TYPES) {
            throw FrameProtocolException("Unknown frame type: 0x${type.toString(16)}")
        }
        if (payload.size > MAX_FRAME_SIZE) {
            throw FrameProtocolException(
                "Payload size ${payload.size} exceeds maximum $MAX_FRAME_SIZE bytes"
            )
        }
        synchronized(out) {
            val dos = DataOutputStream(out)
            dos.writeInt(type)
            dos.writeInt(payload.size)
            dos.write(payload)
            dos.flush()
        }
    }

    /**
     * Read a single frame. Uses [DataInputStream.readFully] to guarantee
     * complete payload delivery (half-packet safe).
     *
     * @throws FrameProtocolException on unknown type, invalid length, or zero-length JSON
     * @throws java.io.EOFException if the stream ends mid-frame
     */
    public fun readFrame(input: InputStream): Frame {
        val dis = DataInputStream(input)
        val type = dis.readInt()
        if (type !in VALID_TYPES) {
            throw FrameProtocolException(
                "Unknown frame type: 0x${type.toString(16)}, stream likely corrupted — must reconnect"
            )
        }
        val length = dis.readInt()
        if (length < 0 || length > MAX_FRAME_SIZE) {
            throw FrameProtocolException(
                "Invalid frame length: $length (max: $MAX_FRAME_SIZE) — must reconnect"
            )
        }
        if (type == TYPE_JSON && length == 0) {
            throw FrameProtocolException("Zero-length JSON frame is invalid")
        }
        val payload = ByteArray(length)
        dis.readFully(payload)
        return Frame(type, payload)
    }

    public data class Frame(val type: Int, val payload: ByteArray) {
        val isJson: Boolean get() = type == TYPE_JSON
        val isBinary: Boolean get() = type == TYPE_BINARY

        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Frame) return false
            return type == other.type && payload.contentEquals(other.payload)
        }

        override fun hashCode(): Int = 31 * type + payload.contentHashCode()
    }
}
