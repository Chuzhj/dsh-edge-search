/**
 * 极简 CDP（Chrome DevTools Protocol）客户端。
 *
 * 设计约束（来自方案）：
 * - 只用 Node 内置模块：fetch / WebSocket / child_process / fs / path / os
 * - Node 22+ 才有全局 WebSocket；DSH 运行时是 Node 24，安全
 * - Chromium 136+ 起，--remote-debugging-port 在「默认数据目录」下会被静默忽略，
 *   必须同时指定非默认的 --user-data-dir。所以这里始终用独立 profile 目录。
 *
 * 连接层次：
 *   HTTP   GET /json/version   → 拿浏览器级 webSocketDebuggerUrl
 *   WS     浏览器级连接          → Target.createTarget / Target.attachToTarget(flatten)
 *   会话级（带 sessionId）        → Page.enable / Page.navigate / Runtime.evaluate
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 常见 Edge 安装路径（Windows）。 */
function locateEdge() {
  const env = process.env
  const pf = env['ProgramFiles'] || 'C:\\Program Files'
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = env['LOCALAPPDATA'] || ''
  const candidates = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    local && path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/** 默认的调试专用 profile 目录（与日常 Edge 隔离）。 */
export function defaultProfileDir() {
  const local = process.env['LOCALAPPDATA'] || process.env['TEMP'] || '.'
  return path.join(local, 'dsh-edge-search', 'edge-profile')
}

/** 探测调试端口是否已经开着。 */
async function probe(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * 确保有一个带调试端口的 Edge 在跑。
 * 已经开着就直接复用；没开则用独立 profile 拉起来。
 *
 * `edgePath` 优先于自动探测：Edge 装在非标准位置时由调用方显式指定。
 * 两者都失败时报错要能区分「配置指错了」和「压根没装」——否则用户无从下手。
 */
export async function ensureEdge({
  port = 9222,
  profileDir,
  edgePath,
  launchTimeoutMs = 25000,
} = {}) {
  const already = await probe(port)
  if (already) return { launched: false, port, version: already }

  if (edgePath && !existsSync(edgePath)) {
    throw new Error(
      `配置项 edgePath 指向的可执行文件不存在：${edgePath}。` +
        `请检查路径是否正确，或删掉该项让插件自动探测。`,
    )
  }
  const exe = edgePath || locateEdge()
  if (!exe) {
    throw new Error(
      '找不到 msedge.exe。请确认已安装 Microsoft Edge，或在插件 config 里设置 edgePath。',
    )
  }
  const dir = profileDir || defaultProfileDir()
  mkdirSync(dir, { recursive: true })

  const child = spawn(
    exe,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
    ],
    { detached: true, stdio: 'ignore', windowsHide: false },
  )
  child.unref()

  const deadline = Date.now() + launchTimeoutMs
  while (Date.now() < deadline) {
    await sleep(400)
    const v = await probe(port)
    if (v) return { launched: true, port, version: v, profileDir: dir }
  }
  throw new Error(
    `Edge 已在 ${launchTimeoutMs}ms 内启动，但调试端口 ${port} 仍不可达。` +
      `可能原因：端口被占用，或已有 Edge 实例使用了同一 profile 目录。`,
  )
}

/** 一个浏览器级 CDP 会话。 */
export class CdpBrowser {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map() // id -> {resolve, reject}
    this.listeners = [] // {method, sessionId, handler}
    this.closed = false
  }

  static async connect(port) {
    const info = await probe(port, 3000)
    if (!info?.webSocketDebuggerUrl) {
      throw new Error(`无法从 127.0.0.1:${port} 取得 webSocketDebuggerUrl`)
    }
    const ws = new WebSocket(info.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 CDP WebSocket 超时')), 8000)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.addEventListener('error', (e) => {
        clearTimeout(timer)
        reject(new Error(`CDP WebSocket 错误：${e?.message || 'unknown'}`))
      })
    })
    const browser = new CdpBrowser(ws)
    ws.addEventListener('message', (ev) => browser._onMessage(ev))
    ws.addEventListener('close', () => {
      browser.closed = true
      for (const { reject } of browser.pending.values()) {
        reject(new Error('CDP 连接已关闭'))
      }
      browser.pending.clear()
    })
    return browser
  }

  _onMessage(ev) {
    let msg
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
    } catch {
      return
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`))
      else resolve(msg.result)
      return
    }
    if (msg.method) {
      for (const l of this.listeners) {
        if (l.method === msg.method && (l.sessionId ?? null) === (msg.sessionId ?? null)) {
          try {
            l.handler(msg.params)
          } catch {
            /* 监听器抛错不影响主流程 */
          }
        }
      }
    }
  }

  /** 发一条 CDP 命令；sessionId 存在时即为会话级命令。 */
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'))
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.ws.send(JSON.stringify(payload))
      } catch (e) {
        this.pending.delete(id)
        reject(e)
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 命令超时：${method}`))
        }
      }, 30000)
    })
  }

  /** 等一个 CDP 事件。 */
  waitFor(method, sessionId, timeoutMs) {
    return new Promise((resolve) => {
      const entry = {
        method,
        sessionId: sessionId ?? null,
        handler: (params) => {
          clearTimeout(timer)
          this.listeners = this.listeners.filter((x) => x !== entry)
          resolve(params)
        },
      }
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((x) => x !== entry)
        resolve(null) // 超时不算失败，交给上层兜底
      }, timeoutMs)
      this.listeners.push(entry)
    })
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * 开一个新标签页 → 导航 → 等待 → 执行 JS → 关标签页。
 * 全程不碰用户已有的标签页。
 */
export async function withPage(browser, { url, evaluate, waitMs = 1200, timeoutMs = 25000 }) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  let sessionId
  try {
    const attached = await browser.send('Target.attachToTarget', { targetId, flatten: true })
    sessionId = attached.sessionId

    await browser.send('Page.enable', {}, sessionId)
    await browser.send('Runtime.enable', {}, sessionId)

    const loaded = browser.waitFor('Page.loadEventFired', sessionId, timeoutMs)
    await browser.send('Page.navigate', { url }, sessionId)
    await loaded
    // SPA / 懒加载：再多等一会儿，并等 readyState 到 complete
    await sleep(waitMs)
    await browser
      .send(
        'Runtime.evaluate',
        { expression: 'document.readyState', returnByValue: true },
        sessionId,
      )
      .catch(() => null)

    if (!evaluate) return null
    const res = await browser.send(
      'Runtime.evaluate',
      { expression: evaluate, returnByValue: true, awaitPromise: false },
      sessionId,
    )
    if (res?.exceptionDetails) {
      throw new Error(`页面内 JS 抛错：${res.exceptionDetails.text || 'unknown'}`)
    }
    return res?.result?.value ?? null
  } finally {
    if (sessionId) {
      await browser.send('Target.detachFromTarget', { sessionId }).catch(() => {})
    }
    await browser.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}
