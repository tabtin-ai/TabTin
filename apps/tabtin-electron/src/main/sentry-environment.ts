import type { TabTinRuntimeProfile } from './app-identity'

export type SentryEnvironment = 'test-new' | 'production'

/**
 * 构建档位只隔离安装身份和调试行为，不代表服务环境。
 * `preprod` 是历史构建档位名，产品语义上仍是 test 包；本轮因 appId、安装目录、
 * 打包与更新链路影响面较大而保留名称，但观测环境必须映射为 test-new。
 */
export function resolveSentryEnvironment(profile: TabTinRuntimeProfile): SentryEnvironment {
  return profile === 'production' ? 'production' : 'test-new'
}
