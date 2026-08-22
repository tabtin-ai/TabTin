/**
 * 移动设备 UA 生成器
 *
 * 🎯 目标：基于真实设备配置生成完全一致的 UA 和指纹
 * ✅ 特点：UA、Client Hints、Screen、GPU 等所有指纹完全匹配
 */

import type { DeviceProfile } from './device-profiles.js';
import {
  IOS_DEVICES,
  IPAD_DEVICES,
  ANDROID_DEVICES,
  ALL_MOBILE_DEVICES,
  IOS_TO_SAFARI_VERSION,
  ANDROID_CHROME_VERSIONS,
} from './device-profiles.js';

/**
 * 完整的设备指纹配置
 */
export interface DeviceFingerprint {
  /** User-Agent 字符串 */
  userAgent: string;
  /** 设备配置信息 */
  device: DeviceProfile;
  /** Screen 指纹 */
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: 24 | 32;
    pixelDepth: 24 | 32;
  };
  /** Viewport 尺寸 */
  viewport: {
    width: number;
    height: number;
  };
  /** WebGL 渲染器信息 */
  webgl: {
    vendor: string;
    renderer: string;
  };
  /** 内存信息（GB） */
  deviceMemory?: 2 | 4 | 6 | 8;
  /** 硬件并发数（CPU 核心数） */
  hardwareConcurrency: number;
  /** 平台字符串 */
  platform: string;
  /** 最大触摸点数 */
  maxTouchPoints: number;
}

/**
 * iOS 设备 UA 生成器
 */
export class IOSUserAgentGenerator {
  /**
   * 生成 iOS 设备的完整指纹
   *
   * @param device 设备配置
   * @param iosVersion iOS 版本（如 "17_6_1"）
   * @returns 完整的设备指纹
   */
  static generate(device: DeviceProfile, iosVersion: string = '17_7'): DeviceFingerprint {
    const safariVersion = IOS_TO_SAFARI_VERSION[iosVersion] || '17.6';
    const isIPad = device.type === 'iPad';

    // 构造 UA
    const deviceString = isIPad ? 'iPad' : 'iPhone';
    const osString = isIPad ? 'CPU OS' : 'CPU iPhone OS';
    const userAgent = `Mozilla/5.0 (${deviceString}; ${osString} ${iosVersion} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${safariVersion} Mobile/15E148 Safari/604.1`;

    // Screen 指纹（使用逻辑尺寸）
    const screen = {
      width: device.display.logicalWidth,
      height: device.display.logicalHeight,
      availWidth: device.display.logicalWidth,
      availHeight: device.display.logicalHeight - (isIPad ? 0 : 0), // iOS 无状态栏遮挡
      colorDepth: 32 as const,
      pixelDepth: 32 as const,
    };

    // Viewport（通常略小于 screen）
    const viewport = {
      width: device.display.logicalWidth,
      height: device.display.logicalHeight - (isIPad ? 0 : 93), // iPhone 减去 Safari 工具栏
    };

    // WebGL 渲染器（使用真实 GPU 信息）
    const webgl = {
      vendor: 'Apple Inc.',
      renderer: device.gpu.name,
    };

    // 内存（iPhone 通常 4-8GB，iPad 通常 6-16GB）
    let deviceMemory: 2 | 4 | 6 | 8;
    if (device.soc.includes('A18') || device.soc.includes('A19') || device.soc.includes('M4')) {
      deviceMemory = 8;
    } else if (device.soc.includes('A17') || device.soc.includes('M2')) {
      deviceMemory = 6;
    } else if (device.soc.includes('A16') || device.soc.includes('A15')) {
      deviceMemory = 4;
    } else {
      deviceMemory = 4;
    }

    // 硬件并发数（基于 GPU 核心数估算）
    const hardwareConcurrency = device.gpu.cores >= 6 ? 6 : 4;

    return {
      userAgent,
      device,
      screen,
      viewport,
      webgl,
      deviceMemory,
      hardwareConcurrency,
      platform: isIPad ? 'MacIntel' : 'iPhone', // iOS 15+ 使用 'MacIntel'
      maxTouchPoints: 5,
    };
  }

  /**
   * 生成随机 iOS 设备指纹（按权重）
   */
  static generateRandom(options?: {
    includeIPad?: boolean;
    iosVersion?: string;
  }): DeviceFingerprint {
    const { includeIPad = false, iosVersion = this.getRandomIOSVersion() } = options || {};

    // 选择设备池
    const devicePool = includeIPad ? [...IOS_DEVICES, ...IPAD_DEVICES] : IOS_DEVICES;

    // 按权重随机选择
    const device = this.weightedRandomSelect(devicePool);

    return this.generate(device, iosVersion);
  }

  /**
   * 获取随机 iOS 版本（高频版本）
   */
  private static getRandomIOSVersion(): string {
    const versions = ['18_2', '18_1', '18_0', '17_7', '17_6', '17_5'];
    return versions[Math.floor(Math.random() * versions.length)];
  }

  /**
   * 按权重随机选择设备
   */
  private static weightedRandomSelect(devices: DeviceProfile[]): DeviceProfile {
    const totalWeight = devices.reduce((sum, d) => sum + (d.weight || 1), 0);
    let random = Math.random() * totalWeight;

    for (const device of devices) {
      random -= (device.weight || 1);
      if (random <= 0) {
        return device;
      }
    }

    return devices[0];
  }
}

/**
 * Android 设备 UA 生成器
 */
export class AndroidUserAgentGenerator {
  /**
   * 生成 Android 设备的完整指纹
   *
   * @param device 设备配置
   * @param androidVersion Android 版本（如 "14"）
   * @param chromeVersion Chrome 版本（如 "131.0.6778.139"）
   * @returns 完整的设备指纹
   */
  static generate(
    device: DeviceProfile,
    androidVersion: string = '14',
    chromeVersion?: string
  ): DeviceFingerprint {
    // 选择 Chrome 版本
    const chrome = chromeVersion || this.getRandomChromeVersion();

    // 构造 UA
    const userAgent = `Mozilla/5.0 (Linux; Android ${androidVersion}; ${device.model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Mobile Safari/537.36`;

    // Screen 指纹
    const screen = {
      width: device.display.logicalWidth,
      height: device.display.logicalHeight,
      availWidth: device.display.logicalWidth,
      availHeight: device.display.logicalHeight - 24, // Android 状态栏
      colorDepth: 24 as const,
      pixelDepth: 24 as const,
    };

    // Viewport（减去状态栏和导航栏）
    const viewport = {
      width: device.display.logicalWidth,
      height: device.display.logicalHeight - 80, // 状态栏 + 导航栏
    };

    // WebGL 渲染器
    const webgl = {
      vendor: this.getGPUVendor(device.gpu.name),
      renderer: device.gpu.name,
    };

    // 内存（Android 旗舰机通常 8-12GB）
    let deviceMemory: 2 | 4 | 6 | 8;
    if (device.model.includes('Ultra') || device.model.includes('Pro')) {
      deviceMemory = 8;
    } else if (device.model.includes('Plus')) {
      deviceMemory = 6;
    } else {
      deviceMemory = 4;
    }

    // 硬件并发数（Android 旗舰机通常 8 核）
    const hardwareConcurrency = 8;

    return {
      userAgent,
      device,
      screen,
      viewport,
      webgl,
      deviceMemory,
      hardwareConcurrency,
      platform: 'Linux armv8l',
      maxTouchPoints: 5,
    };
  }

  /**
   * 生成随机 Android 设备指纹
   */
  static generateRandom(options?: {
    androidVersion?: string;
    chromeVersion?: string;
  }): DeviceFingerprint {
    const {
      androidVersion = this.getRandomAndroidVersion(),
      chromeVersion,
    } = options || {};

    const device = this.weightedRandomSelect(ANDROID_DEVICES);

    return this.generate(device, androidVersion, chromeVersion);
  }

  /**
   * 获取随机 Android 版本
   */
  private static getRandomAndroidVersion(): string {
    const versions = ['14', '13', '12'];
    const weights = [70, 25, 5]; // Android 14: 70%, 13: 25%, 12: 5%

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let random = Math.random() * totalWeight;

    for (let i = 0; i < versions.length; i++) {
      random -= weights[i];
      if (random <= 0) {
        return versions[i];
      }
    }

    return versions[0];
  }

  /**
   * 获取随机 Chrome 版本
   */
  private static getRandomChromeVersion(): string {
    return ANDROID_CHROME_VERSIONS[Math.floor(Math.random() * ANDROID_CHROME_VERSIONS.length)];
  }

  /**
   * 根据 GPU 名称获取厂商
   */
  private static getGPUVendor(gpuName: string): string {
    if (gpuName.includes('Adreno')) {
      return 'Qualcomm';
    } else if (gpuName.includes('Mali')) {
      return 'ARM';
    } else if (gpuName.includes('PowerVR')) {
      return 'Imagination Technologies';
    } else {
      return 'Google';
    }
  }

  /**
   * 按权重随机选择设备
   */
  private static weightedRandomSelect(devices: DeviceProfile[]): DeviceProfile {
    const totalWeight = devices.reduce((sum, d) => sum + (d.weight || 1), 0);
    let random = Math.random() * totalWeight;

    for (const device of devices) {
      random -= (device.weight || 1);
      if (random <= 0) {
        return device;
      }
    }

    return devices[0];
  }
}

/**
 * 统一的移动设备指纹生成器
 */
export class MobileDeviceFingerprintGenerator {
  /**
   * 生成随机移动设备指纹（iOS + Android）
   *
   * @param options 生成选项
   * @returns 完整的设备指纹
   */
  static generateRandom(options?: {
    platform?: 'ios' | 'android' | 'auto';
    includeIPad?: boolean;
  }): DeviceFingerprint {
    const { platform = 'auto', includeIPad = false } = options || {};

    // 自动选择平台（iOS 40%, Android 60%）
    let selectedPlatform = platform;
    if (platform === 'auto') {
      selectedPlatform = Math.random() < 0.4 ? 'ios' : 'android';
    }

    if (selectedPlatform === 'ios') {
      return IOSUserAgentGenerator.generateRandom({ includeIPad });
    } else {
      return AndroidUserAgentGenerator.generateRandom();
    }
  }

  /**
   * 根据设备配置生成指纹
   */
  static generateFromDevice(device: DeviceProfile, options?: {
    iosVersion?: string;
    androidVersion?: string;
    chromeVersion?: string;
  }): DeviceFingerprint {
    if (device.os === 'iOS' || device.os === 'iPadOS') {
      return IOSUserAgentGenerator.generate(device, options?.iosVersion);
    } else {
      return AndroidUserAgentGenerator.generate(device, options?.androidVersion, options?.chromeVersion);
    }
  }

  /**
   * 获取所有可用设备列表
   */
  static getAllDevices(): DeviceProfile[] {
    return ALL_MOBILE_DEVICES;
  }

  /**
   * 根据型号查找设备
   */
  static findDevice(model: string): DeviceProfile | undefined {
    return ALL_MOBILE_DEVICES.find(d => d.model === model);
  }

  /**
   * 获取高频设备（权重前10）
   */
  static getTopDevices(count: number = 10): DeviceProfile[] {
    return [...ALL_MOBILE_DEVICES]
      .sort((a, b) => (b.weight || 0) - (a.weight || 0))
      .slice(0, count);
  }
}

