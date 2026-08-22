/**
 * Electron API 适配器
 * 封装所有与 Electron IPC 相关的 API 调用
 * 使应用层不直接依赖 window.tabtin
 */
import { t } from './i18n'

export interface ApiRequestOptions {
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  headers?: Record<string, string>
  body?: string
}

export interface ApiResponse<T = any> {
  data: T
  status: number
  statusText: string
}

/**
 * API 适配器接口
 * 定义了应用层可以使用的所有 API 方法
 */
export interface IApiAdapter {
  /**
   * 发送 HTTP 请求
   */
  request<T = any>(options: ApiRequestOptions): Promise<ApiResponse<T>>

  /**
   * 获取访问令牌
   */
  getAccessToken(): Promise<string | null>

  /**
   * 获取刷新令牌
   */
  getRefreshToken(): Promise<string | null>

  /**
   * 保存访问令牌
   */
  saveAccessToken(token: string): Promise<void>

  /**
   * 保存刷新令牌
   */
  saveRefreshToken(token: string): Promise<void>

  /**
   * 清除所有令牌
   */
  clearTokens(): Promise<void>

  /**
   * 获取用户信息
   */
  getUserInfo(): Promise<any>

  /**
   * 保存用户信息
   */
  saveUserInfo(userInfo: any): Promise<void>

  /**
   * 清除用户信息
   */
  clearUserInfo(): Promise<void>
}

/**
 * Electron API 适配器实现
 * 封装 window.tabtin 的调用
 */
export class ElectronApiAdapter implements IApiAdapter {
  private tabtin: any

  constructor() {
    // 检查是否在 Electron 环境中
    if (typeof globalThis === 'undefined' ||
        typeof (globalThis as any).window === 'undefined' ||
        !(globalThis as any).window.tabtin) {
      throw new Error(t('errors.rendererOnly'))
    }
    this.tabtin = (globalThis as any).window.tabtin
  }

  /**
   * 发送 HTTP 请求
   */
  async request<T = any>(options: ApiRequestOptions): Promise<ApiResponse<T>> {
    try {
      const response = await this.tabtin.apiRequest(options)
      return response as ApiResponse<T>
    } catch (error) {
      console.error('API request failed:', error)
      throw error
    }
  }

  /**
   * 获取访问令牌
   */
  async getAccessToken(): Promise<string | null> {
    try {
      const result = await this.tabtin.auth.getAccessToken()
      return result.success ? result.token : null
    } catch (error) {
      console.error('Failed to get access token:', error)
      return null
    }
  }

  /**
   * 获取刷新令牌
   */
  async getRefreshToken(): Promise<string | null> {
    try {
      const result = await this.tabtin.auth.getRefreshToken()
      return result.success ? result.token : null
    } catch (error) {
      console.error('Failed to get refresh token:', error)
      return null
    }
  }

  /**
   * 保存访问令牌
   */
  async saveAccessToken(token: string): Promise<void> {
    try {
      await this.tabtin.auth.saveAccessToken(token)
    } catch (error) {
      console.error('Failed to save access token:', error)
      throw error
    }
  }

  /**
   * 保存刷新令牌
   */
  async saveRefreshToken(token: string): Promise<void> {
    try {
      await this.tabtin.auth.saveRefreshToken(token)
    } catch (error) {
      console.error('Failed to save refresh token:', error)
      throw error
    }
  }

  /**
   * 清除所有令牌
   */
  async clearTokens(): Promise<void> {
    try {
      await this.tabtin.auth.clearTokens()
    } catch (error) {
      console.error('Failed to clear tokens:', error)
      throw error
    }
  }

  /**
   * 获取用户信息
   */
  async getUserInfo(): Promise<any> {
    try {
      const result = await this.tabtin.auth.getUserInfo()
      return result.success ? result.userInfo : null
    } catch (error) {
      console.error('Failed to get user info:', error)
      return null
    }
  }

  /**
   * 保存用户信息
   */
  async saveUserInfo(userInfo: any): Promise<void> {
    try {
      await this.tabtin.auth.saveUserInfo(userInfo)
    } catch (error) {
      console.error('Failed to save user info:', error)
      throw error
    }
  }

  /**
   * 清除用户信息
   */
  async clearUserInfo(): Promise<void> {
    try {
      await this.tabtin.auth.clearUserInfo()
    } catch (error) {
      console.error('Failed to clear user info:', error)
      throw error
    }
  }
}

/**
 * 创建 API 适配器实例的工厂函数
 */
export function createApiAdapter(): IApiAdapter {
  return new ElectronApiAdapter()
}

/**
 * 全局单例实例
 */
let apiAdapterInstance: IApiAdapter | null = null

/**
 * 获取 API 适配器单例
 */
export function getApiAdapter(): IApiAdapter {
  if (!apiAdapterInstance) {
    apiAdapterInstance = createApiAdapter()
  }
  return apiAdapterInstance
}

/**
 * 重置 API 适配器单例（主要用于测试）
 */
export function resetApiAdapter(): void {
  apiAdapterInstance = null
}
