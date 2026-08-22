/**
 * 为 api-adapter.ts 单独构建 ESM 版本
 * 用于 renderer 进程（浏览器环境）
 */
const fs = require('fs')

// 读取编译后的 CommonJS 版本
const apiAdapterCjs = fs.readFileSync('./dist/api-adapter.js', 'utf-8')
const i18nCjs = fs.readFileSync('./dist/i18n.js', 'utf-8')

const convertRequireToImport = (content) => content.replace(
  /\b(const|let|var)\s+(\w+)\s*=\s*require\((['"])([^'"]+)\3\);\n/g,
  (_, _decl, varName, _quote, modulePath) => {
    let resolved = modulePath
    if ((modulePath.startsWith('./') || modulePath.startsWith('../')) &&
      !modulePath.endsWith('.mjs') &&
      !modulePath.endsWith('.js') &&
      !modulePath.endsWith('.json')) {
      resolved = `${modulePath}.mjs`
    }
    return `import * as ${varName} from "${resolved}";\n`
  }
)

const stripCjsHeader = (content) => content
  .replace(/"use strict";\n/g, '')
  .replace(/Object\.defineProperty\(exports, "__esModule", \{ value: true \}\);\n/g, '')
  // 处理 exports.a = exports.b = ... = void 0;
  .replace(/exports\.[^=]+(?:\s*=\s*exports\.[^=]+)*\s*=\s*void 0;\n/g, '')
  .replace(/exports\.(\w+) = void 0;\n/g, '')

// 构建 api-adapter.mjs
let apiAdapterEsm = convertRequireToImport(apiAdapterCjs)
apiAdapterEsm = stripCjsHeader(apiAdapterEsm)
apiAdapterEsm = apiAdapterEsm.replace(/function (\w+)\(/g, 'export function $1(')
apiAdapterEsm = apiAdapterEsm.replace(/class (\w+) \{/g, 'export class $1 {')
apiAdapterEsm = apiAdapterEsm.replace(/exports\.\w+ = \w+;\n/g, '')
fs.writeFileSync('./dist/api-adapter.mjs', apiAdapterEsm, 'utf-8')

// 构建 i18n.mjs（保留 const/let，最后补 export）
let i18nEsm = stripCjsHeader(i18nCjs)
const exportNames = []
i18nEsm = i18nEsm.replace(/exports\.(\w+)\s*=\s*\1;\n/g, (_, name) => {
  exportNames.push(name)
  return ''
})
if (exportNames.length > 0) {
  i18nEsm += `\nexport { ${Array.from(new Set(exportNames)).join(', ')} };\n`
}
fs.writeFileSync('./dist/i18n.mjs', i18nEsm, 'utf-8')

console.log('✅ ESM 版本构建完成: dist/api-adapter.mjs, dist/i18n.mjs')
