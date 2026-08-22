package com.tabtin.mobile.data.adb

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import androidx.annotation.RequiresApi
import dagger.hilt.android.qualifiers.ApplicationContext
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.asn1.x509.SubjectPublicKeyInfo
import org.bouncycastle.cert.X509v3CertificateBuilder
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder
import java.io.ByteArrayInputStream
import java.math.BigInteger
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.Key
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Principal
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.interfaces.RSAPrivateKey
import java.security.interfaces.RSAPublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.RSAKeyGenParameterSpec
import java.security.spec.RSAPublicKeySpec
import java.util.Date
import java.util.Locale
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec
import javax.inject.Inject
import javax.inject.Singleton
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedKeyManager
import javax.net.ssl.X509ExtendedTrustManager

private const val TAG = "AdbKeyManager"
private const val ANDROID_KEYSTORE = "AndroidKeyStore"
private const val ENCRYPTION_KEY_ALIAS = "_tabtin_adbkey_encryption_"
private const val TRANSFORMATION = "AES/GCM/NoPadding"
private const val IV_SIZE_IN_BYTES = 12
private const val TAG_SIZE_IN_BYTES = 16
private const val PREF_NAME = "tabtin_adb_key"
private const val PREF_KEY = "adbkey"
private const val ANDROID_PUBKEY_MODULUS_SIZE = 2048 / 8
private const val ANDROID_PUBKEY_MODULUS_SIZE_WORDS = ANDROID_PUBKEY_MODULUS_SIZE / 4

private val PADDING = byteArrayOf(
    0x00, 0x01, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0x00,
    0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00,
    0x04, 0x14,
)

@Singleton
public class AdbKeyManager @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private val encryptionKey: Key by lazy {
        getOrCreateEncryptionKey()
            ?: throw IllegalStateException("Failed to create or retrieve ADB encryption key from Android Keystore")
    }
    private val privateKey: RSAPrivateKey by lazy { getOrCreatePrivateKey() }
    private val publicKey: RSAPublicKey by lazy {
        KeyFactory.getInstance("RSA")
            .generatePublic(RSAPublicKeySpec(privateKey.modulus, RSAKeyGenParameterSpec.F4)) as RSAPublicKey
    }
    private val certificate: X509Certificate by lazy {
        val signer = JcaContentSignerBuilder("SHA256withRSA").build(privateKey)
        val x509Cert = X509v3CertificateBuilder(
            X500Name("CN=TabTin"),
            BigInteger.ONE,
            Date(0),
            Date(2461449600 * 1000),
            Locale.ROOT,
            X500Name("CN=TabTin"),
            SubjectPublicKeyInfo.getInstance(publicKey.encoded),
        ).build(signer)
        CertificateFactory.getInstance("X.509")
            .generateCertificate(ByteArrayInputStream(x509Cert.encoded)) as X509Certificate
    }

    public val adbPublicKey: ByteArray by lazy { publicKey.adbEncoded("TabTin@Android") }

    public val hasPreviouslyPaired: Boolean
        get() = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
            .getString(PREF_KEY, null) != null

    public fun sign(data: ByteArray?): ByteArray {
        requireNotNull(data) { "Cannot sign null data: A_AUTH/TOKEN message had empty payload" }
        val cipher = Cipher.getInstance("RSA/ECB/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, privateKey)
        cipher.update(PADDING)
        return cipher.doFinal(data)
    }

    @delegate:RequiresApi(Build.VERSION_CODES.R)
    public val sslContext: SSLContext by lazy {
        val ctx = SSLContext.getInstance("TLSv1.3")
        ctx.init(arrayOf(keyManager), arrayOf(trustManager), SecureRandom())
        ctx
    }

    private fun getOrCreateEncryptionKey(): Key? {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE)
        keyStore.load(null)
        return keyStore.getKey(ENCRYPTION_KEY_ALIAS, null) ?: run {
            val spec = KeyGenParameterSpec.Builder(
                ENCRYPTION_KEY_ALIAS,
                KeyProperties.PURPOSE_DECRYPT or KeyProperties.PURPOSE_ENCRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
            val keygen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
            keygen.init(spec)
            keygen.generateKey()
        }
    }

    private fun encrypt(plaintext: ByteArray, aad: ByteArray): ByteArray? {
        val ciphertext = ByteArray(IV_SIZE_IN_BYTES + plaintext.size + TAG_SIZE_IN_BYTES)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, encryptionKey)
        cipher.updateAAD(aad)
        cipher.doFinal(plaintext, 0, plaintext.size, ciphertext, IV_SIZE_IN_BYTES)
        System.arraycopy(cipher.iv, 0, ciphertext, 0, IV_SIZE_IN_BYTES)
        return ciphertext
    }

    private fun decrypt(ciphertext: ByteArray, aad: ByteArray): ByteArray? {
        if (ciphertext.size < IV_SIZE_IN_BYTES + TAG_SIZE_IN_BYTES) return null
        val params = GCMParameterSpec(8 * TAG_SIZE_IN_BYTES, ciphertext, 0, IV_SIZE_IN_BYTES)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, encryptionKey, params)
        cipher.updateAAD(aad)
        return cipher.doFinal(ciphertext, IV_SIZE_IN_BYTES, ciphertext.size - IV_SIZE_IN_BYTES)
    }

    private fun getOrCreatePrivateKey(): RSAPrivateKey {
        val aad = ByteArray(16)
        "adbkey".toByteArray().copyInto(aad)

        val prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        val stored = prefs.getString(PREF_KEY, null)
        if (stored != null) {
            try {
                val ciphertext = Base64.decode(stored, Base64.NO_WRAP)
                val plaintext = decrypt(ciphertext, aad)
                if (plaintext != null) {
                    return KeyFactory.getInstance("RSA")
                        .generatePrivate(PKCS8EncodedKeySpec(plaintext)) as RSAPrivateKey
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to load stored key, generating new one", e)
            }
        }

        val keyPairGenerator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA)
        keyPairGenerator.initialize(RSAKeyGenParameterSpec(2048, RSAKeyGenParameterSpec.F4))
        val keyPair = keyPairGenerator.generateKeyPair()
        val key = keyPair.private as RSAPrivateKey

        val encrypted = encrypt(key.encoded, aad)
        if (encrypted != null) {
            prefs.edit().putString(PREF_KEY, String(Base64.encode(encrypted, Base64.NO_WRAP))).apply()
        }
        return key
    }

    private val keyManager get() = object : X509ExtendedKeyManager() {
        override fun chooseClientAlias(keyTypes: Array<out String>, issuers: Array<out Principal>?, socket: Socket?): String? =
            keyTypes.firstOrNull { it == "RSA" }?.let { "key" }
        override fun getCertificateChain(alias: String?) =
            if (alias == "key") arrayOf(certificate) else null
        override fun getPrivateKey(alias: String?) =
            if (alias == "key") privateKey else null
        override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?) = null
        override fun getServerAliases(keyType: String, issuers: Array<out Principal>?) = null
        override fun chooseServerAlias(keyType: String, issuers: Array<out Principal>?, socket: Socket?) = null
    }

    // TECH DEBT (ADB-033): TrustManager 空实现 — 仅限 localhost (127.0.0.1) 连接安全。
    // 若未来扩展到远程/跨设备连接，必须实现 TOFU (Trust On First Use) 证书校验，
    // 否则将直接面临中间人攻击风险。参见 DECISIONS.md D3。
    @get:RequiresApi(Build.VERSION_CODES.R)
    private val trustManager get() = object : X509ExtendedTrustManager() {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) {}
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) {}
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) {}
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) {}
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun getAcceptedIssuers() = emptyArray<X509Certificate>()
    }
}

private fun BigInteger.toAdbEncoded(): IntArray {
    val encoded = IntArray(ANDROID_PUBKEY_MODULUS_SIZE_WORDS)
    val r32 = BigInteger.ZERO.setBit(32)
    var tmp = this.add(BigInteger.ZERO)
    for (i in 0 until ANDROID_PUBKEY_MODULUS_SIZE_WORDS) {
        val out = tmp.divideAndRemainder(r32)
        tmp = out[0]
        encoded[i] = out[1].toInt()
    }
    return encoded
}

private fun RSAPublicKey.adbEncoded(name: String): ByteArray {
    val r32 = BigInteger.ZERO.setBit(32)
    val n0inv = modulus.remainder(r32).modInverse(r32).negate()
    val r = BigInteger.ZERO.setBit(ANDROID_PUBKEY_MODULUS_SIZE * 8)
    val rr = r.modPow(BigInteger.valueOf(2), modulus)

    val buffer = ByteBuffer.allocate(524).order(ByteOrder.LITTLE_ENDIAN)
    buffer.putInt(ANDROID_PUBKEY_MODULUS_SIZE_WORDS)
    buffer.putInt(n0inv.toInt())
    modulus.toAdbEncoded().forEach { buffer.putInt(it) }
    rr.toAdbEncoded().forEach { buffer.putInt(it) }
    buffer.putInt(publicExponent.toInt())

    val base64Bytes = Base64.encode(buffer.array(), Base64.NO_WRAP)
    val nameBytes = " $name\u0000".toByteArray()
    val bytes = ByteArray(base64Bytes.size + nameBytes.size)
    base64Bytes.copyInto(bytes)
    nameBytes.copyInto(bytes, base64Bytes.size)
    return bytes
}
