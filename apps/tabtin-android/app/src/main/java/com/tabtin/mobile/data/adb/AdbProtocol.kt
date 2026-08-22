package com.tabtin.mobile.data.adb

public object AdbProtocol {
    public const val A_CNXN: Int = 0x4e584e43
    public const val A_AUTH: Int = 0x48545541
    public const val A_OPEN: Int = 0x4e45504f
    public const val A_OKAY: Int = 0x59414b4f
    public const val A_CLSE: Int = 0x45534c43
    public const val A_WRTE: Int = 0x45545257
    public const val A_STLS: Int = 0x534C5453

    public const val A_VERSION: Int = 0x01000000
    public const val A_MAXDATA: Int = 256 * 1024
    public const val A_STLS_VERSION: Int = 0x01000000

    public const val ADB_AUTH_TOKEN: Int = 1
    public const val ADB_AUTH_SIGNATURE: Int = 2
    public const val ADB_AUTH_RSAPUBLICKEY: Int = 3

    public const val HEADER_LENGTH: Int = 24
}
