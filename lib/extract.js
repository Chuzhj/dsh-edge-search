/**
 * 页面文本提取策略。
 *
 * 方案结论：**不要依赖固定 CSS 选择器 / XPath / 正则** —— 搜索引擎与站点改版会让它们立刻失效。
 * 这里用两条通用策略：
 *
 *   1. extractResults —— 搜索结果页（SERP）
 *      找到「含外链 + 有标题 + 整块文本长度适中」的元素，去掉包含其他候选的外层块，
 *      按 URL 去重，产出 title / url / snippet。
 *
 *   2. extractArticle —— 普通内容页
 *      基于**文本密度**：找出文本够长、且链接文本占比低的块级元素，
 *      只保留最深的那些（避免父子重复），拼接 innerText。
 *
 * 两者都在页面内（Runtime.evaluate）执行，不在 Node 侧解析 HTML。
 */

/** 把参数安全地注入到页面 JS 里。 */
const lit = (v) => JSON.stringify(v)

/**
 * @param {object} o
 * @param {number} o.limit 最多返回多少条结果
 * @param {string} o.excludeHostRegex 需要排除的主机名正则（源串）
 */
export function extractResults({ limit = 8, excludeHostRegex = '' } = {}) {
  return `(() => {
  const LIMIT = ${lit(limit)};
  const EXCLUDE = ${lit(excludeHostRegex)};
  const badHost = EXCLUDE ? new RegExp(EXCLUDE, 'i') : null;
  const abs = (h) => { try { return new URL(h, location.href).href } catch { return null } };

  const cands = [];
  for (const el of document.querySelectorAll('li,div,article,section')) {
    const a = el.querySelector('a[href]');
    if (!a) continue;
    const href = abs(a.getAttribute('href'));
    if (!href || !/^https?:/i.test(href)) continue;
    let host = '';
    try { host = new URL(href).hostname } catch { continue }
    if (badHost && badHost.test(host)) continue;

    const text = (el.innerText || '').trim();
    if (text.length < 40 || text.length > 900) continue;

    const titleEl = el.querySelector('h1,h2,h3,h4') || a;
    const title = (titleEl.innerText || '').trim().replace(/\\s+/g, ' ');
    if (title.length < 4 || title.length > 160) continue;

    cands.push({ el, href, title, text });
  }

  // 只保留最深的候选，避免"整个结果列表"和"单条结果"同时被选中
  const set = new Set(cands.map(c => c.el));
  const deep = cands.filter(c => {
    let p = c.el.parentElement;
    while (p) { if (set.has(p)) return false; p = p.parentElement }
    return true;
  });

  const out = [];
  const seen = new Set();
  for (const c of deep) {
    if (out.length >= LIMIT) break;
    if (seen.has(c.href)) continue;
    seen.add(c.href);
    let snippet = c.text.replace(c.title, '').replace(/\\s+/g, ' ').trim();
    if (snippet.length > 260) snippet = snippet.slice(0, 260) + '…';
    out.push({ title: c.title, url: c.href, snippet });
  }
  return out;
})()`
}

/**
 * @param {object} o
 * @param {number} o.maxChars 正文最大字符数
 * @param {number} o.minBlock 单块最小文本长度（低于此值不算正文块）
 * @param {number} o.maxLinkRatio 链接文本占比上限（超过说明是导航而非正文）
 */
export function extractArticle({ maxChars = 8000, minBlock = 200, maxLinkRatio = 0.3 } = {}) {
  return `(() => {
  const MAX = ${lit(maxChars)};
  const MIN_BLOCK = ${lit(minBlock)};
  const MAX_LINK_RATIO = ${lit(maxLinkRatio)};

  const blocks = Array.from(
    document.querySelectorAll('p,div,article,section,li,td,blockquote,pre')
  );
  const good = [];
  for (const el of blocks) {
    const t = (el.innerText || '').trim();
    if (t.length < MIN_BLOCK) continue;
    let linkLen = 0;
    for (const a of el.querySelectorAll('a')) linkLen += (a.innerText || '').length;
    if (linkLen / t.length >= MAX_LINK_RATIO) continue;
    good.push(el);
  }

  const set = new Set(good);
  const deep = good.filter(el => {
    let p = el.parentElement;
    while (p) { if (set.has(p)) return false; p = p.parentElement }
    return true;
  });

  const parts = [];
  const seen = new Set();
  let total = 0;
  for (const el of deep) {
    const t = (el.innerText || '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    parts.push(t);
    total += t.length;
    if (total >= MAX) break;
  }
  return parts.join('\\n\\n').slice(0, MAX);
})()`
}

/** 把结果数组渲染成给模型看的文本。 */
export function renderResults(query, engine, results) {
  if (!results || results.length === 0) {
    return `No results extracted for "${query}" (engine: ${engine}). The page structure may have changed, or the query returned nothing.`
  }
  const lines = results.map((r, i) => {
    const snip = r.snippet ? `\n   ${r.snippet}` : ''
    return `${i + 1}. [${r.title}](${r.url})${snip}`
  })
  return `Search results for "${query}" (engine: ${engine}), ${results.length} item(s):\n\n${lines.join('\n\n')}`
}
