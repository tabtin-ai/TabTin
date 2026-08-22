package com.tabtin.mobile.data.adb

import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import java.lang.reflect.Method
import java.io.Closeable
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import javax.net.ssl.SSLSocket

private const val TAG = "AdbPairingClient"
private const val CONNECT_TIMEOUT_MS = 10_000
private const val SO_TIMEOUT_MS = 30_000
private const val CURRENT_KEY_HEADER_VERSION: Byte = 1
private const val MAX_PEER_INFO_SIZE = 8192
private const val MAX_PAYLOAD_SIZE = MAX_PEER_INFO_SIZE * 2
private const val EXPORTED_KEY_LABEL = "adb-label\u0000"
private const val EXPORTED_KEY_SIZE = 64
private const val PAIRING_PACKET_HEADER_SIZE = 6

public class AdbInvalidPairingCodeException : Exception("Invalid pairing code")
public class AdbPairingUnsupportedException(message: String, cause: Throwable? = null) : Exception(message, cause)

@RequiresApi(Build.VERSION_CODES.R)
public class AdbPairingClient(
    private val host: String,
    private val port: Int,
    private val pairCode: String,
    private val key: AdbKeyManager,
) : Closeable {

    private var socket: Socket? = null
    private var sslSocket: SSLSocket? = null
    private var inputStream: DataInputStream? = null
    private var outputStream: DataOutputStream? = null
    private var pairingContext: PairingContext? = null
    private var initialized = false

    public fun start(): Boolean {
        setupTlsConnection()
        initialized = true

        if (!doExchangeMsgs()) return false
        if (!doExchangePeerInfo()) return false
        return true
    }

    private fun setupTlsConnection() {
        val sock = Socket()
        sock.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS)
        sock.tcpNoDelay = true
        sock.soTimeout = SO_TIMEOUT_MS
        socket = sock

        val ssl = key.sslContext.socketFactory.createSocket(sock, host, port, true) as SSLSocket
        ssl.soTimeout = SO_TIMEOUT_MS
        ssl.startHandshake()
        sslSocket = ssl
        Log.d(TAG, "TLS handshake succeeded")

        inputStream = DataInputStream(ssl.inputStream)
        outputStream = DataOutputStream(ssl.outputStream)

        val pairCodeBytes = pairCode.toByteArray()
        val keyMaterial = exportKeyingMaterial(ssl)
        val passwordBytes = ByteArray(pairCodeBytes.size + keyMaterial.size)
        pairCodeBytes.copyInto(passwordBytes)
        keyMaterial.copyInto(passwordBytes, pairCodeBytes.size)

        pairingContext = PairingContext.create(passwordBytes)
            ?: error("Unable to create PairingContext")
    }

    private fun doExchangeMsgs(): Boolean {
        val ctx = pairingContext ?: return false
        val msg = ctx.msg
        writeHeader(TYPE_SPAKE2_MSG, msg)

        val (type, payload) = readHeader() ?: return false
        if (type != TYPE_SPAKE2_MSG) return false

        return ctx.initCipher(payload)
    }

    private fun doExchangePeerInfo(): Boolean {
        val ctx = pairingContext ?: return false
        val buf = ByteBuffer.allocate(MAX_PEER_INFO_SIZE).order(ByteOrder.BIG_ENDIAN)
        buf.put(0) // type: ADB_RSA_PUB_KEY
        val pubKey = key.adbPublicKey
        require(pubKey.size < MAX_PEER_INFO_SIZE) {
            "ADB public key too large (${pubKey.size} bytes, max ${MAX_PEER_INFO_SIZE - 1})"
        }
        buf.put(pubKey, 0, pubKey.size)

        val encrypted = ctx.encrypt(buf.array()) ?: return false
        writeHeader(TYPE_PEER_INFO, encrypted)

        val (type, payload) = readHeader() ?: return false
        if (type != TYPE_PEER_INFO) return false

        ctx.decrypt(payload) ?: throw AdbInvalidPairingCodeException()
        return true
    }

    private fun writeHeader(type: Byte, payload: ByteArray) {
        val out = outputStream ?: error("outputStream not initialized")
        val header = ByteBuffer.allocate(PAIRING_PACKET_HEADER_SIZE).order(ByteOrder.BIG_ENDIAN)
        header.put(CURRENT_KEY_HEADER_VERSION)
        header.put(type)
        header.putInt(payload.size)
        out.write(header.array())
        out.write(payload)
        out.flush()
    }

    private fun readHeader(): Pair<Byte, ByteArray>? {
        val inp = inputStream ?: error("inputStream not initialized")
        val bytes = ByteArray(PAIRING_PACKET_HEADER_SIZE)
        inp.readFully(bytes)
        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
        val version = buf.get()
        val type = buf.get()
        val payloadSize = buf.int

        if (version !in 1..1) {
            Log.e(TAG, "Unsupported version: $version")
            return null
        }
        if (payloadSize <= 0 || payloadSize > MAX_PAYLOAD_SIZE) {
            Log.e(TAG, "Invalid payload size: $payloadSize")
            return null
        }

        val payload = ByteArray(payloadSize)
        inp.readFully(payload)
        return Pair(type, payload)
    }

    override fun close() {
        runCatching { outputStream?.close() }
        runCatching { inputStream?.close() }
        runCatching { sslSocket?.close() }
        runCatching { socket?.close() }
        if (initialized) pairingContext?.destroy()
        outputStream = null
        inputStream = null
        sslSocket = null
        socket = null
        pairingContext = null
    }

    public companion object {
        private const val TYPE_SPAKE2_MSG: Byte = 0
        private const val TYPE_PEER_INFO: Byte = 1

        private fun exportKeyingMaterial(sslSocket: SSLSocket): ByteArray {
            // Prefer standard SSLSocket.exportKeyingMaterial (Android 14+ / Java 21)
            try {
                val method = sslSocket.javaClass.getMethod(
                    "exportKeyingMaterial",
                    String::class.java,
                    ByteArray::class.java,
                    Int::class.javaPrimitiveType,
                )
                val result = method.invoke(sslSocket, EXPORTED_KEY_LABEL, null, EXPORTED_KEY_SIZE) as? ByteArray
                if (result != null) return result
            } catch (_: NoSuchMethodException) {
                // Standard API not available on this platform, fall through to Conscrypt
            } catch (_: Exception) {
                Log.w(TAG, "Standard exportKeyingMaterial failed, trying Conscrypt fallback")
            }

            // Fallback: platform Conscrypt via reflection (may be blocked on Android 12+ or custom ROMs)
            try {
                val conscryptClass = Class.forName("com.android.org.conscrypt.Conscrypt")
                val method: Method = conscryptClass.getMethod(
                    "exportKeyingMaterial",
                    javax.net.ssl.SSLSocket::class.java,
                    String::class.java,
                    ByteArray::class.java,
                    Int::class.javaPrimitiveType,
                )
                return method.invoke(null, sslSocket, EXPORTED_KEY_LABEL, null, EXPORTED_KEY_SIZE) as ByteArray
            } catch (e: Exception) {
                throw AdbPairingUnsupportedException(
                    "exportKeyingMaterial unavailable: neither standard API nor Conscrypt reflection succeeded", e
                )
            }
        }
    }
}
