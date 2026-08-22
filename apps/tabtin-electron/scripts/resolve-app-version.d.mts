/**
 * 类型声明配套 resolve-app-version.mjs（同目录同名规则，TS bundler resolution 自动配对）。
 * 实现与文档见同名 .mjs 文件。
 */

export declare function readSourceVersion(): string

/**
 * 按 build profile 派生 packaged app 的 version 字符串。
 *
 * @param profile  TABTIN_BUILD_PROFILE 取值：'production' | 'preprod' | 'local' | undefined / null / ''（dev）
 * @param sourceVersion  缺省时自动从 apps/tabtin-electron/package.json#version 读
 * @returns 派生版本字符串（与 packaged app.getVersion() 严格相等）
 * @throws  profile 非法（避免 typo 静默退化成 production）
 */
export declare function resolveAppVersion(
  profile: string | null | undefined,
  sourceVersion?: string,
): string
