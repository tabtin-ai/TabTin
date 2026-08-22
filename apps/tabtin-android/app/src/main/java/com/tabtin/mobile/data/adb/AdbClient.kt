package com.tabtin.mobile.data.adb

import android.os.Build
import android.util.Log
import com.tabtin.mobile.data.adb.AdbProtocol.ADB_AUTH_RSAPUBLICKEY
import com.tabtin.mobile.data.adb.AdbProtocol.ADB_AUTH_SIGNATURE
import com.tabtin.mobile.data.adb.AdbProtocol.A_AUTH
import com.tabtin.mobile.data.adb.AdbProtocol.A_CLSE
import com.tabtin.mobile.data.adb.AdbProtocol.A_CNXN
import com.tabtin.mobile.data.adb.AdbProtocol.A_MAXDATA
import com.tabtin.mobile.data.adb.AdbProtocol.A_OKAY
import com.tabtin.mobile.data.adb.AdbProtocol.A_OPEN
import com.tabtin.mobile.data.adb.AdbProtocol.A_STLS
import com.tabtin.mobile.data.adb.AdbProtocol.A_STLS_VERSION
import com.tabtin.mobile.data.adb.AdbProtocol.A_VERSION
import com.tabtin.mobile.data.adb.AdbProtocol.A_WRTE
import java.io.Closeable
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.SSLSocket

private const val TAG = "AdbClient"
private const val CONNECT_TIMEOUT_MS = 5_000
private const val SO_TIMEOUT_MS = 30_000
private const val USER_APPROVAL_TIMEOUT_MS = 120_000
private const val MAX_PAYLOAD_GUARD = AdbProtocol.A_MAXDATA * 2

/**
 * Low-level ADB protocol client for a single TCP connection.
 *
 * **Threading contract**: instances are created and used exclusively by
 * [AdbConnectionManager] under its [connectMutex] / [shellMutex].
 * This class is *not* thread-safe on its own — callers must serialise access.
 *
 * Lifecycle: [connect] → N × [shellCommand] → [close].  After [close] the
 * instance can be reconnected (fields are reset), but in practice
 * [AdbConnectionManager] creates a fresh instance for every connection.
 */
public class AdbClient(
    private val host: String,
    private val port: Int,
    private val key: AdbKeyManager,
) : Closeable {

    private val nextLocalId = AtomicInteger(1)
    @Volatile public var peerMaxData: Int = AdbProtocol.A_MAXDATA
        private set
    private var socket: Socket? = null
    private var plainInputStream: DataInputStream? = null
    private var plainOutputStream: DataOutputStream? = null

    private var useTls = false
    private var tlsSocket: SSLSocket? = null
    private var tlsInputStream: DataInputStream? = null
    private var tlsOutputStream: DataOutputStream? = null

    private val inputStream: DataInputStream
        get() = (if (useTls) tlsInputStream else plainInputStream)
            ?: error("AdbClient not connected")
    private val outputStream: DataOutputStream
        get() = (if (useTls) tlsOutputStream else plainOutputStream)
            ?: error("AdbClient not connected")

    public fun connect(onAwaitingApproval: (() -> Unit)? = null) {
        check(socket == null) { "AdbClient already connected — call close() first" }
        try {
            val sock = Socket()
            sock.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS)
            sock.tcpNoDelay = true
            sock.soTimeout = SO_TIMEOUT_MS
            sock.keepAlive = true
            socket = sock
            plainInputStream = DataInputStream(sock.getInputStream())
            plainOutputStream = DataOutputStream(sock.getOutputStream())

            write(A_CNXN, A_VERSION, A_MAXDATA, "host::")

            var message = read()
            if (message.command == A_STLS) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                    error("TLS ADB not supported before Android 10")
                }
                write(A_STLS, A_STLS_VERSION, 0)

                val tls = key.sslContext.socketFactory.createSocket(sock, host, port, true) as SSLSocket
                tls.soTimeout = SO_TIMEOUT_MS
                tls.startHandshake()
                tlsSocket = tls
                Log.d(TAG, "TLS handshake succeeded")

                tlsInputStream = DataInputStream(tls.inputStream)
                tlsOutputStream = DataOutputStream(tls.outputStream)
                useTls = true
                message = read()
            } else if (message.command == A_AUTH) {
                write(A_AUTH, ADB_AUTH_SIGNATURE, 0, key.sign(message.data))
                message = read()
                if (message.command != A_CNXN) {
                    write(A_AUTH, ADB_AUTH_RSAPUBLICKEY, 0, key.adbPublicKey)
                    onAwaitingApproval?.invoke()
                    val activeSocket = (if (useTls) tlsSocket else sock) ?: sock
                    activeSocket.soTimeout = USER_APPROVAL_TIMEOUT_MS
                    try {
                        message = read()
                    } finally {
                        activeSocket.soTimeout = SO_TIMEOUT_MS
                    }
                }
            }

            if (message.command != A_CNXN) error("Expected A_CNXN, got ${message.command}")
            peerMaxData = maxOf(message.arg1, 256)
        } catch (e: Exception) {
            close()
            throw e
        }
    }

    public fun shellCommand(command: String, listener: ((ByteArray) -> Unit)? = null) {
        val localId = nextLocalId.getAndUpdate { id -> if (id >= Int.MAX_VALUE) 1 else id + 1 }
        write(A_OPEN, localId, 0, "shell:$command")

        var message = read()
        when (message.command) {
            A_OKAY -> {
                while (true) {
                    message = read()
                    val remoteId = message.arg0
                    when (message.command) {
                        A_WRTE -> {
                            if (message.dataLength > 0) {
                                val payload = message.data
                                    ?: error("A_WRTE with dataLength=${message.dataLength} but null data")
                                listener?.invoke(payload)
                            }
                            write(A_OKAY, localId, remoteId)
                        }
                        A_CLSE -> {
                            write(A_CLSE, localId, remoteId)
                            break
                        }
                        else -> error("Unexpected message: ${message.command}")
                    }
                }
            }
            A_CLSE -> write(A_CLSE, localId, message.arg0)
            else -> error("Expected A_OKAY or A_CLSE, got ${message.command}")
        }
    }

    private fun write(command: Int, arg0: Int, arg1: Int, data: ByteArray? = null) =
        write(AdbMessage(command, arg0, arg1, data))

    private fun write(command: Int, arg0: Int, arg1: Int, data: String) =
        write(AdbMessage(command, arg0, arg1, data))

    private fun write(message: AdbMessage) {
        outputStream.write(message.toByteArray())
        outputStream.flush()
    }

    private fun read(): AdbMessage {
        val buffer = ByteBuffer.allocate(AdbProtocol.HEADER_LENGTH).order(ByteOrder.LITTLE_ENDIAN)
        inputStream.readFully(buffer.array(), 0, AdbProtocol.HEADER_LENGTH)

        val command = buffer.int
        val arg0 = buffer.int
        val arg1 = buffer.int
        val dataLength = buffer.int
        val checksum = buffer.int
        val magic = buffer.int
        if (dataLength < 0 || dataLength > MAX_PAYLOAD_GUARD) {
            error("Invalid ADB data length: $dataLength (max: $MAX_PAYLOAD_GUARD)")
        }
        val data = if (dataLength > 0) {
            ByteArray(dataLength).also { inputStream.readFully(it) }
        } else null

        val msg = AdbMessage(command, arg0, arg1, dataLength, checksum, magic, data)
        if (!msg.validate()) error("Invalid ADB message")
        return msg
    }

    override fun close() {
        if (useTls) {
            runCatching { tlsOutputStream?.close() }
            runCatching { tlsInputStream?.close() }
            runCatching { tlsSocket?.close() }
        }
        runCatching { plainOutputStream?.close() }
        runCatching { plainInputStream?.close() }
        runCatching { socket?.close() }

        tlsOutputStream = null
        tlsInputStream = null
        tlsSocket = null
        plainOutputStream = null
        plainInputStream = null
        socket = null
        useTls = false
        peerMaxData = AdbProtocol.A_MAXDATA
    }
}
