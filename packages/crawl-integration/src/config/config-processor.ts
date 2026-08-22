/**
 * 配置处理器
 * 负责处理和应用扩展配置选项
 */

import {
  ExtendedHTTPConfig,
  ExtendedCDPConfig,
  UserAgentGenerator,
  GeolocationConfig,
  PerformanceConfig
} from './extended-options.js';
import { getSystemUserAgent } from '../utils/system-ua.js';
import { t } from '../i18n.js';

export class ConfigProcessor {
  /**
   * 处理 HTTP 扩展配置
   */
  static processHTTPConfig(config: ExtendedHTTPConfig): {
    headers: Record<string, string>;
    userAgent: string;
    geolocation?: GeolocationConfig;
    performance?: PerformanceConfig;
  } {
    const result = {
      headers: {} as Record<string, string>,
      userAgent: '',
      geolocation: config.geolocation,
      performance: config.performance
    };

    // 处理 User-Agent
    if (config.userAgent) {
      if (config.userAgent.preset === 'system') {
        result.userAgent = getSystemUserAgent();
      } else {
        result.userAgent = UserAgentGenerator.generate(config.userAgent);
      }
    }

    // 处理地理位置相关的头部
    if (config.geolocation) {
      if (config.geolocation.country) {
        result.headers['CF-IPCountry'] = config.geolocation.country;
      }
      if (config.geolocation.timezone) {
        result.headers['X-Timezone'] = config.geolocation.timezone;
      }
    }

    // 处理移动端配置
    if (config.mobile?.deviceEmulation?.enabled) {
      const viewport = config.mobile.deviceEmulation.viewport;
      if (viewport) {
        result.headers['Viewport-Width'] = viewport.width.toString();
        if (viewport.isMobile) {
          result.headers['X-Requested-With'] = 'XMLHttpRequest';
        }
      }
    }

    // 处理隐私配置
    if (config.privacy) {
      if (config.privacy.doNotTrack) {
        result.headers['DNT'] = '1';
      }

      if (config.privacy.languageSpoof?.enabled && config.privacy.languageSpoof.languages) {
        result.headers['Accept-Language'] = config.privacy.languageSpoof.languages.join(',');
      }
    }

    // 处理压缩配置
    if (config.compression?.enabled && config.compression.algorithms) {
      result.headers['Accept-Encoding'] = config.compression.algorithms.join(', ');
    }

    return result;
  }

  /**
   * 处理 CDP 扩展配置
   */
  static processCDPConfig(config: ExtendedCDPConfig): {
    userAgent?: string;
    geolocation?: GeolocationConfig;
    viewport?: any;
    performance?: PerformanceConfig;
    browserArgs?: string[];
    pageOptions?: any;
  } {
    const result = {
      userAgent: undefined as string | undefined,
      geolocation: config.geolocation,
      viewport: undefined as any,
      performance: config.performance,
      browserArgs: [] as string[],
      pageOptions: {} as any
    };

    // 处理 User-Agent
    if (config.userAgent) {
      if (config.userAgent.preset === 'system') {
        // 对于系统模式，不在这里设置UA，让引擎自己处理
        result.userAgent = undefined;
      } else {
        result.userAgent = UserAgentGenerator.generate(config.userAgent);
      }
    }

    // 处理移动端配置
    if (config.mobile?.deviceEmulation?.enabled) {
      const deviceConfig = config.mobile.deviceEmulation;

      if (deviceConfig.viewport) {
        result.viewport = {
          width: deviceConfig.viewport.width,
          height: deviceConfig.viewport.height,
          deviceScaleFactor: deviceConfig.viewport.deviceScaleFactor || 1,
          mobile: deviceConfig.viewport.isMobile || false,
          hasTouch: deviceConfig.viewport.hasTouch || false,
          isLandscape: deviceConfig.viewport.isLandscape || false
        };
      }

      if (deviceConfig.userAgent) {
        result.userAgent = deviceConfig.userAgent;
      }
    }

    // 处理地理位置配置
    if (config.geolocation) {
      result.pageOptions.geolocation = {
        latitude: config.geolocation.latitude,
        longitude: config.geolocation.longitude,
        accuracy: config.geolocation.accuracy || 100
      };
    }

    // 处理隐私配置
    if (config.privacy) {
      if (config.privacy.doNotTrack) {
        result.browserArgs.push('--enable-do-not-track');
      }

      if (config.privacy.incognito) {
        result.browserArgs.push('--incognito');
      }

      if (config.privacy.disableWebRTC) {
        result.browserArgs.push('--disable-webrtc');
      }

      if (config.privacy.disableWebGL) {
        result.browserArgs.push('--disable-webgl');
      }
    }

    // 处理性能配置
    if (config.performance?.resourceOptimization) {
      const resourceOpt = config.performance.resourceOptimization;

      if (resourceOpt.blockImages) {
        result.browserArgs.push('--blink-settings=imagesEnabled=false');
      }

      if (resourceOpt.blockCSS) {
        result.browserArgs.push('--disable-extensions-file-access-check');
      }

      if (resourceOpt.blockAds) {
        result.browserArgs.push('--aggressive-cache-discard');
      }
    }

    return result;
  }

  /**
   * 合并配置选项
   */
  static mergeConfigs<T>(base: T, override: Partial<T>): T {
    return {
      ...base,
      ...override
    };
  }

  /**
   * 验证配置选项
   */
  static validateConfig(config: ExtendedHTTPConfig | ExtendedCDPConfig): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    // 验证地理位置配置
    if (config.geolocation) {
      const geo = config.geolocation;
      if (geo.latitude < -90 || geo.latitude > 90) {
        errors.push(t('config.validation.geo.latitudeRange'));
      }
      if (geo.longitude < -180 || geo.longitude > 180) {
        errors.push(t('config.validation.geo.longitudeRange'));
      }
      if (geo.accuracy && geo.accuracy < 0) {
        errors.push(t('config.validation.geo.accuracyPositive'));
      }
    }

    // 验证移动端配置
    if (config.mobile?.deviceEmulation?.enabled) {
      const viewport = config.mobile.deviceEmulation.viewport;
      if (viewport) {
        if (viewport.width <= 0 || viewport.height <= 0) {
          errors.push(t('config.validation.viewport.positive'));
        }
        if (viewport.deviceScaleFactor && viewport.deviceScaleFactor <= 0) {
          errors.push(t('config.validation.deviceScale.positive'));
        }
      }
    }

    // 验证性能配置
    if (config.performance) {
      const perf = config.performance;
      if (perf.cpuThrottling?.enabled && perf.cpuThrottling.rate) {
        if (perf.cpuThrottling.rate < 1 || perf.cpuThrottling.rate > 100) {
          errors.push(t('config.validation.cpuThrottling.range'));
        }
      }
      if (perf.memoryLimit?.enabled && perf.memoryLimit.maxMemoryMB) {
        if (perf.memoryLimit.maxMemoryMB <= 0) {
          errors.push(t('config.validation.memoryLimit.positive'));
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * 生成配置摘要
   */
  static generateConfigSummary(config: ExtendedHTTPConfig | ExtendedCDPConfig): string {
    const parts: string[] = [];

    if (config.userAgent?.preset) {
      parts.push(`UA: ${config.userAgent.preset}`);
    }

    if (config.geolocation) {
      parts.push(t('config.summary.location', {
        value: config.geolocation.city || config.geolocation.country || t('config.summary.location.custom')
      }));
    }

    if (config.mobile?.deviceEmulation?.enabled) {
      const device = config.mobile.deviceEmulation;
      parts.push(t('config.summary.device', {
        value: device.deviceName || t('config.summary.device.customMobile')
      }));
    }

    if (config.privacy?.incognito) {
      parts.push(t('config.summary.incognito'));
    }

    if (config.performance?.resourceOptimization) {
      const opt = config.performance.resourceOptimization;
      const blocked: string[] = [];
      if (opt.blockImages) blocked.push(t('config.summary.blocked.images'));
      if (opt.blockCSS) blocked.push(t('config.summary.blocked.css'));
      if (opt.blockFonts) blocked.push(t('config.summary.blocked.fonts'));
      if (blocked.length > 0) {
        parts.push(t('config.summary.blocked', { items: blocked.join(', ') }));
      }
    }

    return parts.join(' | ') || t('config.summary.default');
  }
}
