/**
 * selftest.mjs —— 离线自测入口（不经 DSH 安装，直接验证 CDP 链路）。
 *
 * 用法：
 *   node selftest.mjs search "<关键词>" [engine] [limit]
 *   node selftest.mjs read   "<url>" [maxChars]
 *   node selftest.mjs probe           # 只看调试端口通不通
 *   node selftest.mjs js     "<url>" "<表达式>"   # 在页面里跑 JS（探查用）
 *
 * 为什么要有它：装进 DSH 之前先证明「Edge 起得来 + CDP 连得上 + 文本提得出来」。
 * 装进 DSH 之后再验证「工具注册是否生效」——两者是不同层面的问题，分开查更省事。
 *
 * 2026-10-19：随 v0.3.0 移除 chat / chat2 两个子命令（对应工具已删）。
 */

import { CdpBrowser, ensureEdge } from './lib/cdp.js'
import { openTab } from './lib/interact.js'
import { runRead, runSearch } from './lib/ops.js'

const argv = process.argv.slice(2)
const cmd = argv[0]

function usage() {
  console.error('用法:')
  console.error('  node selftest.mjs probe')
  console.error('  node selftest.mjs search "<关键词>" [engine] [limit]')
  console.error('  node selftest.mjs read   "<url>" [maxChars]')
  console.error('  node selftest.mjs js     "<url>" "<表达式>"  # 在页面里跑任意 JS（探查用）')
  process.exit(2)
}

async function main() {
  if (!cmd) usage()

  if (cmd === 'probe') {
    const r = await ensureEdge({})
    console.log(`Edge ${r.launched ? '已拉起' : '已在运行'}，端口 ${r.port}`)
    console.log(`Browser: ${r.version?.Browser || '(未知)'}`)
    if (r.profileDir) console.log(`Profile: ${r.profileDir}`)
    return
  }

  if (cmd === 'search') {
    const query = argv[1]
    if (!query) usage()
    const engine = argv[2] || 'bing'
    const limit = Number(argv[3]) || 8
    const t0 = Date.now()
    const text = await runSearch({ query, engine, limit })
    console.log(text)
    console.log(`\n[selftest] engine=${engine} 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    return
  }

  if (cmd === 'read') {
    const url = argv[1]
    if (!url) usage()
    const maxChars = Number(argv[2]) || 8000
    const t0 = Date.now()
    const text = await runRead({ url, maxChars })
    console.log(text)
    console.log(`\n[selftest] 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    return
  }

  if (cmd === 'js') {
    const url = argv[1]
    const expression = argv[2]
    if (!url || !expression) usage()
    await ensureEdge({})
    const browser = await CdpBrowser.connect(9222)
    try {
      const handle = await openTab(browser, { url })
      await new Promise((r) => setTimeout(r, 2500))
      const out = await handle.evaluate(expression)
      console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2))
      await handle.close()
    } finally {
      browser.close()
    }
    return
  }

  usage()
}

main().catch((e) => {
  console.error(`[selftest] 失败: ${e?.message || e}`)
  process.exit(1)
})
