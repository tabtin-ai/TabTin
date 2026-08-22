/**
 * Client Hints 服务测试用例
 *
 * 覆盖场景：
 * - Windows Chrome (各版本)
 * - macOS Chrome / Safari
 * - Android Chrome
 * - iPhone Safari
 * - Edge, Firefox 等其他浏览器
 * - 一致性验证
 * - 错误处理
 */

import { strict as assert } from 'assert';
import {
  getClientHintsService,
  parseUserAgent,
  validateClientHints,
  quickValidate,
  generateClientHintsHeaders
} from './index.js';
import type { ClientHints } from './types.js';

// ===== 测试用例集合 =====

interface ClientHintsTestCase {
  name: string;
  ua: string;
  expected: Partial<ClientHints>;
}

const testCases: ClientHintsTestCase[] = [
  {
    name: 'Windows Chrome 122',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    expected: {
      'Sec-CH-UA': '"Not A(Brand";v="8", "Chromium";v="122", "Google Chrome";v="122"',
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Windows"',
      'Sec-CH-UA-Platform-Version': '"10.0.0"',
      'Sec-CH-UA-Arch': '"x86"',
      'Sec-CH-UA-Bitness': '"64"'
    }
  },
  {
    name: 'Windows Chrome 115',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
    expected: {
      'Sec-CH-UA': '"Not/A)Brand";v="8", "Chromium";v="115", "Google Chrome";v="115"',  // 不同的 GREASE 格式
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Windows"'
    }
  },
  {
    name: 'macOS Chrome (Intel)',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    expected: {
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"macOS"',
      'Sec-CH-UA-Platform-Version': '"10.15.7"',
      'Sec-CH-UA-Arch': '"x86"'  // Intel Mac
    }
  },
  {
    name: 'macOS Chrome (Apple Silicon)',
    ua: 'Mozilla/5.0 (Macintosh; ARM64 Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    expected: {
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"macOS"',
      'Sec-CH-UA-Arch': '"arm"'  // Apple Silicon
    }
  },
  {
    name: 'iPhone Safari',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    expected: {
      'Sec-CH-UA-Mobile': '?1',
      'Sec-CH-UA-Platform': '"iOS"',
      'Sec-CH-UA-Platform-Version': '"17.0.0"'
      // iPhone 不应该有 Arch（移动端通常不发送）
    }
  },
  {
    name: 'Android Chrome (Pixel 8)',
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
    expected: {
      'Sec-CH-UA-Mobile': '?1',
      'Sec-CH-UA-Platform': '"Android"',
      'Sec-CH-UA-Platform-Version': '"14.0.0"',
      'Sec-CH-UA-Model': '"Pixel 8"'
    }
  },
  {
    name: 'Edge (Chromium-based)',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
    expected: {
      'Sec-CH-UA': '"Not A(Brand";v="8", "Chromium";v="122", "Microsoft Edge";v="122"',  // 品牌是 "Microsoft Edge"
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Windows"'
    }
  },
  {
    name: 'Linux Chrome',
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    expected: {
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Linux"',
      'Sec-CH-UA-Arch': '"x86"'
    }
  }
];

// ===== 运行测试 =====

function runTests() {
  const service = getClientHintsService();
  let passed = 0;
  let failed = 0;

  console.log('🧪 开始测试 Client Hints 服务...\n');

  for (const testCase of testCases) {
    try {
      console.log(`📝 测试: ${testCase.name}`);
      console.log(`   UA: ${testCase.ua.substring(0, 80)}...`);

      // 1. 生成 Client Hints
      const hints = service.generate(testCase.ua);

      // 2. 验证期望值
      for (const [key, expectedValue] of Object.entries(testCase.expected) as Array<[keyof ClientHints, string]>) {
        const actualValue = hints[key];

        if (key === 'Sec-CH-UA') {
          // Sec-CH-UA 检查版本号匹配即可（GREASE 格式可能不完全一样）
          const versionMatch = expectedValue.match(/"Chromium";v="(\d+)"/);
          if (versionMatch) {
            const expectedVersion = versionMatch[1];
            assert(actualValue?.includes(`"Chromium";v="${expectedVersion}"`),
              `版本号不匹配：期望 ${expectedVersion}，实际 ${actualValue}`);
          }
        } else {
          assert.equal(actualValue, expectedValue,
            `${key} 不匹配：期望 ${expectedValue}，实际 ${actualValue}`);
        }
      }

      // 3. 验证一致性
      const validation = validateClientHints(parseUserAgent(testCase.ua), hints);
      assert(validation.valid, `一致性验证失败: ${validation.errors.join(', ')}`);

      // 4. 快速验证
      assert(quickValidate(parseUserAgent(testCase.ua), hints), '快速验证失败');

      console.log(`   ✅ 通过`);
      console.log('');
      passed++;

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`   ❌ 失败: ${message}`);
      console.log('');
      failed++;
    }
  }

  // ===== 额外测试：边缘情况 =====

  console.log('🔬 测试边缘情况...\n');

  // 测试 1: 无效的 UA
  try {
    const hints = service.generate('InvalidUserAgent');
    assert(hints['Sec-CH-UA'], '应该有降级值');
    console.log('   ✅ 无效 UA 降级处理正确');
    passed++;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`   ❌ 无效 UA 测试失败: ${message}`);
    failed++;
  }

  // 测试 2: 缓存功能
  try {
    const ua = testCases[0].ua;
    const stats1 = service.getStats();

    service.generate(ua);  // 第一次
    service.generate(ua);  // 第二次（应该命中缓存）

    const stats2 = service.getStats();
    assert(stats2.cacheHits > stats1.cacheHits, '缓存应该命中');
    console.log('   ✅ 缓存功能正常');
    passed++;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`   ❌ 缓存测试失败: ${message}`);
    failed++;
  }

  // 测试 3: 批量生成
  try {
    const uas = testCases.map(tc => tc.ua);
    const results = service.batchGenerate(uas);
    assert.equal(results.length, uas.length, '批量生成数量不匹配');
    console.log('   ✅ 批量生成正常');
    passed++;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`   ❌ 批量生成测试失败: ${message}`);
    failed++;
  }

  // 测试 4: 自动修复
  try {
    const ua = testCases[0].ua;
    const badHints: ClientHints = {
      'Sec-CH-UA': '"Chromium";v="999"',  // 错误的版本号
      'Sec-CH-UA-Mobile': '?1',           // 错误的移动端标识
      'Sec-CH-UA-Platform': '"Linux"'     // 错误的平台
    };

    const fixed = service.autoFix(ua, badHints);
    assert(fixed['Sec-CH-UA'].includes('v="122"'), '版本号应该被修复');
    assert(fixed['Sec-CH-UA-Mobile'] === '?0', '移动端标识应该被修复');
    assert(fixed['Sec-CH-UA-Platform'] === '"Windows"', '平台应该被修复');
    console.log('   ✅ 自动修复正常');
    passed++;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`   ❌ 自动修复测试失败: ${message}`);
    failed++;
  }

  // ===== 输出结果 =====

  console.log('\n' + '='.repeat(50));
  console.log(`📊 测试结果: ${passed} 通过, ${failed} 失败`);
  console.log('='.repeat(50));

  if (failed === 0) {
    console.log('✨ 所有测试通过！');
  } else {
    console.error(`⚠️  有 ${failed} 个测试失败`);
    process.exit(1);
  }

  // 输出统计信息
  console.log('\n📈 服务统计信息:');
  console.log(service.getStats());
}

// 运行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests();
}

export { runTests };
