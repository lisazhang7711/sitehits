// 读数接口：/stats            → 全部站点 + 粘性聚合（一次拿全）
//           /stats?site=zhouyi → 只看单个站点
//
// 返回结构和 Cloudflare 版完全一致，本地 stats.py 不用改。
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

const SITES = [
  'zhouyi', 'duneijing', 'rentsafe', 'learnpath', 'prepper-map', 'saved',
  'csc1001-mid', 'mat1001-mid', 'beijing-transit',
];

export async function onRequest({ request }) {
  if (request.method === 'OPTIONS') return new Response('', { headers: CORS });

  if (typeof HITS === 'undefined') {
    return json({ error: 'KV 未绑定：变量名必须是 HITS' }, CORS, 500);
  }

  const url = new URL(request.url);
  const only = (url.searchParams.get('site') || '').replace(/[^a-zA-Z0-9_-]/g, '');

  let keys = SITES;
  try {
    const saved = await HITS.get('sites');
    if (saved) {
      const merged = new Set(SITES);
      saved.split(',').filter(Boolean).forEach(s => merged.add(s));
      keys = [...merged];
    }
  } catch (e) { /* 读不到就用内置清单 */ }

  const list = only ? [only] : keys;
  const out = {};
  for (const s of list) {
    const total = Number(await HITS.get('total_' + s) || 0);
    const dw = Number(await HITS.get('dwell_' + s) || 0);
    const days = {};
    for (let i = 29; i >= 0; i--) {
      const d = dayStr(-i);
      const v = await HITS.get('day_' + s + '_' + d);
      if (v) days[fmt(d)] = Number(v);
    }
    out[s] = { total, days, avgDwellSec: total ? Math.round(dw / total) : 0 };
  }

  const visitors = await visitorStats(only || null);
  return json({ updated: new Date().toISOString(), sites: out, visitors }, CORS);
}

// ---------- 粘性聚合 ----------

async function visitorStats(onlySite) {
  const acc = {
    devices: 0, visits: 0, newToday: 0, activeToday: 0,
    revisit: 0, multiSite: 0, dwellSum: 0, dwellN: 0,
    byDays: { '1': 0, '2': 0, '3-5': 0, '6+': 0 },
    gapSum: 0, gapN: 0,
    perSite: {}, top: [],
  };
  const day = fmt(dayStr(0));
  let cursor = null;

  do {
    const opt = { prefix: 'dev_', limit: 200 };
    if (cursor) opt.cursor = cursor;
    const page = await HITS.list(opt);
    for (const k of (page.keys || [])) {
      let v = null;
      try { v = await HITS.get(k.name, 'json'); } catch (e) { v = null; }
      if (!v) continue;

      const sites = v.s || {};
      if (onlySite && !sites[onlySite]) continue;

      const n = v.n || 0;
      const d = (v.d || []).slice().sort();
      const days = d.length;

      acc.devices += 1;
      acc.visits += n;
      const firstDay = v.fd || String(d[0] || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
      if (firstDay === day) acc.newToday += 1;
      if (fmt(d[days - 1]) === day) acc.activeToday += 1;
      if (days >= 2) acc.revisit += 1;
      if (Object.keys(sites).length >= 2) acc.multiSite += 1;
      if (v.w) { acc.dwellSum += v.w; acc.dwellN += n; }

      acc.byDays[days <= 1 ? '1' : days === 2 ? '2' : days <= 5 ? '3-5' : '6+'] += 1;

      for (let i = 1; i < days; i++) {
        acc.gapSum += (dateNum(d[i]) - dateNum(d[i - 1])) / 86400000;
        acc.gapN += 1;
      }

      for (const s of Object.keys(sites)) {
        const p = acc.perSite[s] || (acc.perSite[s] = { devices: 0, visits: 0, sole: 0 });
        p.devices += 1;
        p.visits += sites[s];
        if (Object.keys(sites).length === 1) p.sole += 1;
      }

      acc.top.push({
        id: k.name.slice(4, 12),           // 只显示前 8 位，不做身份识别
        n, days, first: firstDay, last: fmt(d[days - 1] || ''),
        sites: Object.keys(sites).length,
        dwell: v.w || 0,
      });
    }
    // Cloudflare 用 list_complete，EdgeOne 用 complete，两个都认
    const done = page.list_complete === undefined ? page.complete : page.list_complete;
    cursor = done ? null : page.cursor;
  } while (cursor);

  acc.top.sort((a, b) => b.days - a.days || b.n - a.n);
  acc.top = acc.top.slice(0, 15);

  for (const s of Object.keys(acc.perSite)) {
    const p = acc.perSite[s];
    p.avgVisits = p.devices ? +(p.visits / p.devices).toFixed(2) : 0;
  }

  const pct = (a, b) => b ? +(a / b * 100).toFixed(1) : 0;
  return {
    devices: acc.devices,
    visits: acc.visits,
    avgVisits: acc.devices ? +(acc.visits / acc.devices).toFixed(2) : 0,
    newToday: acc.newToday,
    activeToday: acc.activeToday,
    revisit: acc.revisit,
    revisitRate: pct(acc.revisit, acc.devices),
    multiSite: acc.multiSite,
    multiSiteRate: pct(acc.multiSite, acc.devices),
    avgGapDays: acc.gapN ? +(acc.gapSum / acc.gapN).toFixed(1) : 0,
    avgDwellSec: acc.dwellN ? Math.round(acc.dwellSum / acc.dwellN) : 0,
    byDays: acc.byDays,
    perSite: acc.perSite,
    top: acc.top,
  };
}

// ---------- 工具 ----------

function dayStr(offsetDays) {
  return new Date(Date.now() + offsetDays * 86400000 + 8 * 3600000)
    .toISOString().slice(0, 10).replace(/-/g, '');
}

function fmt(d) { return String(d || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'); }

function dateNum(s) {
  const t = fmt(s);
  return Date.parse(t + 'T00:00:00Z');
}

function json(obj, headers, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers });
}
