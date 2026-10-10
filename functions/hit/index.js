// 站点计数 + 访客粘性后端（腾讯云 EdgeOne Pages 版）
//
// 国内直连、免费额度够用、不用买域名也不用备案。
//
// 部署前提（在控制台做一次）：
//   1. 开通 EdgeOne Pages，从 GitHub 导入本仓库
//   2. Pages 控制台 → KV 存储 → 申请开通 → 创建命名空间
//   3. 项目详情 → KV 存储 → 绑定命名空间，变量名必须填 HITS（大写）
//
// 关键点：KV 在 EdgeOne 里是【全局变量】，不是 context.env.HITS，
//         直接用 HITS.get / HITS.put / HITS.list。
//
// 接口：
//   GET /hit?site=zhouyi&vid=设备ID            → 计一次访问，写该设备的来访档案
//   GET /hit?site=zhouyi&vid=设备ID&dwell=87   → 只补记停留秒数，不重复计访问
//
// 前端埋点：见 eo/snippet.html
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

// 站点清单写死，省掉每次 Splunk 式的 KV 枚举
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
  const site = (url.searchParams.get('site') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const vid = (url.searchParams.get('vid') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const dwell = Math.min(Math.max(parseInt(url.searchParams.get('dwell') || '0', 10) || 0, 0), 86400);

  if (!site) return json({ error: 'missing site' }, CORS, 400);

  const day = ymd(0);

  // dwell 上报只补记时长，不重复计一次访问（否则访问数翻倍）
  if (dwell) {
    await bump('dwell_' + site, dwell);
  } else {
    if (!~SITES.indexOf(site)) {
      SITES.push(site);
      await HITS.put('sites', SITES.join(','));
    }
    await bump('total_' + site);
    await bump('day_' + site + '_' + day);
  }

  if (vid) await touchDevice(vid, site, dwell, day);

  return json({ ok: true, site, day }, CORS);
}

// ---------- 设备档案 ----------

async function touchDevice(vid, site, dwell, day) {
  const key = 'dev_' + vid.replace(/-/g, '');
  let r = null;
  try { r = await HITS.get(key, 'json'); } catch (e) { r = null; }
  r = r || {};

  if (!dwell) {
    r.n = (r.n || 0) + 1;                       // 总访问次数
    const set = new Set(r.d || []);             // 活跃日期（去重，用来判断隔天又来）
    set.add(day);
    r.d = [...set].sort().slice(-60);
    r.s = r.s || {};
    r.s[site] = (r.s[site] || 0) + 1;
  }
  if (dwell) r.w = (r.w || 0) + dwell;          // 累计停留秒数

  r.fd = r.fd || day.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');   // 首访日期（东八区，带横线，和读数端对齐）
  r.l = day;                                    // 最近来访日期
  await HITS.put(key, JSON.stringify(r));
}

// ---------- 工具 ----------

async function bump(key, by = 1) {
  const cur = Number(await HITS.get(key) || 0);
  try { await HITS.put(key, String(cur + by)); } catch (e) { /* 边缘一致性冲突，忽略 */ }
  return cur + by;
}

// 按东八区切日期，和 stats.py 的本地日期对齐
function ymd(offsetDays) {
  return new Date(Date.now() + offsetDays * 86400000 + 8 * 3600000)
    .toISOString().slice(0, 10).replace(/-/g, '');
}

function json(obj, headers, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers });
}
