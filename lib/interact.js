/**
 * 页面交互层：开一个受控标签页，在内求值 / 导航 / 取地址 / 关闭。
 *
 * 为什么单独一个模块：lib/cdp.js 的 withPage 是「打开 → 读一次 → 关掉」的一次性形状；
 * 这里给的是「先拿句柄、再按需操作」的形状，供 selftest 的 js 子命令等探查场景使用。
 *
 * 约定：新建的标签页用完必须 close()，否则会留在用户的调试窗口里。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 打开一个受控标签页。
 * @param {object} browser 已连接的浏览器级会话（CdpBrowser 实例）
 * @param {{ url?: string }} [opts]
 * @returns {Promise<object>} 页面句柄
 */
export async function openTab(browser, { url } = {}) {
  const created = await browser.send('Target.createTarget', { url: url || 'about:blank' })
  const targetId = created.targetId
  await sleep(500)

  const attached = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  const sessionId = attached.sessionId
  await browser.send('Page.enable', {}, sessionId)
  await browser.send('Runtime.enable', {}, sessionId)

  const send = (method, params = {}) => browser.send(method, params, sessionId)

  const handle = {
    targetId,
    sessionId,

    /** 同步求值（返回 JSON 值）。 */
    async evaluate(expression) {
      const res = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: false,
      })
      if (res?.exceptionDetails) {
        throw new Error(`页面内 JS 抛错：${res.exceptionDetails.text || 'unknown'}`)
      }
      return res?.result?.value ?? null
    },

    /** 导航并等 load。 */
    async navigate(target, timeoutMs = 30000) {
      const loaded = browser.waitFor('Page.loadEventFired', sessionId, timeoutMs)
      await send('Page.navigate', { url: target })
      await loaded
      return handle
    },

    /** 取当前地址。 */
    url() {
      return handle.evaluate('location.href')
    },

    /** 关掉本标签页。 */
    async close() {
      await browser.send('Target.detachFromTarget', { sessionId }).catch(() => {})
      await browser.send('Target.closeTarget', { targetId }).catch(() => {})
    },
  }

  return handle
}
