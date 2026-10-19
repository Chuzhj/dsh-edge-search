/**
 * 业务层：把「搜索」「读页面」两个操作拼起来。
 *
 * 每一步都不碰用户已有的标签页 —— 每次操作都是
 * Target.createTarget → 用 → Target.closeTarget。
 */

import { CdpBrowser, ensureEdge, withPage } from './cdp.js'
import { extractArticle, extractResults, renderResults } from './extract.js'

/** 支持的搜索引擎。exclude 用于把搜索引擎自家的导航链接从结果里滤掉。 */
export const ENGINES = {
  bing: {
    label: 'Bing',
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
    exclude: String.raw`(^|\.)(bing\.com|microsoft\.com|msn\.com|microsofttranslator\.com)$`,
  },
  baidu: {
    label: 'Baidu',
    url: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`,
    exclude: String.raw`(^|\.)(baidu\.com|baidustatic\.com|bdstatic\.com)$`,
  },
  google: {
    label: 'Google',
    url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    exclude: String.raw`(^|\.)(google\.[a-z.]+|gstatic\.com)$`,
  },
  duckduckgo: {
    label: 'DuckDuckGo',
    url: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
    exclude: String.raw`(^|\.)(duckduckgo\.com)$`,
  },
}

export const ENGINE_NAMES = Object.keys(ENGINES)

function resolveEngine(name) {
  const key = String(name || 'bing').toLowerCase()
  const eng = ENGINES[key]
  if (!eng) {
    throw new Error(
      `未知的搜索引擎 "${name}"。可用：${ENGINE_NAMES.join(' / ')}`,
    )
  }
  return { key, ...eng }
}

/**
 * 搜索：打开结果页 → 提取结果列表 → 返回文本。
 */
export async function runSearch({
  query,
  engine = 'bing',
  limit = 8,
  port = 9222,
  edgePath,
  profileDir,
  settleMs = 1500,
} = {}) {
  const q = String(query || '').trim()
  if (!q) throw new Error('query 不能为空')
  const eng = resolveEngine(engine)

  await ensureEdge({ port, profileDir, edgePath })
  const browser = await CdpBrowser.connect(port)
  try {
    const results = await withPage(browser, {
      url: eng.url(q),
      waitMs: settleMs,
      evaluate: extractResults({ limit, excludeHostRegex: eng.exclude }),
    })
    return renderResults(q, eng.label, results)
  } finally {
    browser.close()
  }
}

/**
 * 读页面：打开指定 URL → 用文本密度策略提取正文 → 返回文本。
 */
export async function runRead({
  url,
  maxChars = 8000,
  port = 9222,
  edgePath,
  profileDir,
  settleMs = 1800,
} = {}) {
  const target = String(url || '').trim()
  if (!/^https?:\/\//i.test(target)) {
    throw new Error(`url 必须是 http/https 绝对地址，收到：${target || '(空)'}`)
  }

  await ensureEdge({ port, profileDir, edgePath })
  const browser = await CdpBrowser.connect(port)
  try {
    const text = await withPage(browser, {
      url: target,
      waitMs: settleMs,
      evaluate: extractArticle({ maxChars }),
    })
    const body = (text || '').trim()
    if (!body) {
      return `Fetched ${target} but extracted no readable text. The page may be a JS-only app, a login wall, or an empty document.`
    }
    return `Fetched ${target}\n\n${body}`
  } finally {
    browser.close()
  }
}
