/**
 * 报名工具 · 后端接口（Cloudflare Pages Functions）
 * 路由：
 *   会员  /api/board  /api/signup  /api/cancel
 *   管理  /api/admin/login  /api/admin/config  /api/admin/cell
 *         /api/admin/sign   /api/admin/remove
 *
 * 课表默认值在 DEFAULTS 里，后台改过之后以数据库里的为准。
 */

/* ============ 默认课表（后台没设置过时用这套） ============ */

const DEFAULTS = {
  title: 'Hihi Studio',
  subtitle: '点格子报名 · 报名后 3 分钟内可取消',
  cancelMin: 3, // 取消窗口（分钟）
  showStats: true, // 会员页面是否显示「本周/本月/今年已报」
  periods: [
    { id: 't1', start: '08:30', end: '09:30', cap: 8 },
    { id: 't2', start: '09:45', end: '10:45', cap: 8 },
    { id: 't3', start: '11:00', end: '12:00', cap: 8 },
    { id: 't4', start: '15:00', end: '16:00', cap: 10 },
    { id: 't5', start: '16:10', end: '17:10', cap: 10 },
    { id: 't6', start: '19:30', end: '20:30', cap: 10 },
    { id: 't7', start: '20:45', end: '21:45', cap: 10 }
  ],
  dayOff: [],   // 整天停课的星期：0=周日 … 6=周六
  override: {}  // '星期-时段id': { cap: 20 } 或 { off: true }
};

/* ======================================================== */

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const TZ = 8 * 3600 * 1000; // 北京时间
const MAX_RENAMES = 1;      // 会员自己最多改几次名字，改完要找管理员

/* ---------------- 时间工具 ---------------- */

function bjEpoch(y, m, d, hh, mm) {
  return Date.UTC(y, m - 1, d, hh || 0, mm || 0) - TZ;
}

function bjParts(ts) {
  const t = new Date(ts + TZ);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
}

function ymd(p) {
  return p.y + '-' + String(p.m).padStart(2, '0') + '-' + String(p.d).padStart(2, '0');
}

function mdText(p) {
  return p.m + '/' + p.d;
}

function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  return { y, m: mo, d, dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() };
}

function hhmmOk(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
}

/* ---------------- 配置读取 / 规范化 ---------------- */

function intIn(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const periods = (Array.isArray(c.periods) ? c.periods : [])
    .filter((p) => p && hhmmOk(p.start) && hhmmOk(p.end))
    .slice(0, 20)
    .map((p, i) => ({
      id: String(p.id || 'p' + i).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'p' + i,
      start: p.start,
      end: p.end,
      cap: intIn(p.cap, 1, 999, 8)
    }));

  const dayOff = (Array.isArray(c.dayOff) ? c.dayOff : [])
    .map((x) => parseInt(x, 10))
    .filter((n) => n >= 0 && n <= 6);

  const override = {};
  if (c.override && typeof c.override === 'object') {
    for (const k of Object.keys(c.override)) {
      const v = c.override[k] || {};
      const o = {};
      if (v.cap !== undefined) o.cap = intIn(v.cap, 0, 999, 8);
      if (v.off === true) o.off = true;
      override[k.slice(0, 24)] = o;
    }
  }

  return {
    title: String(c.title || DEFAULTS.title).slice(0, 40),
    subtitle: String(c.subtitle === undefined ? DEFAULTS.subtitle : c.subtitle).slice(0, 80),
    cancelMin: intIn(c.cancelMin, 1, 120, 3),
    showStats: c.showStats !== false,
    periods: periods.length ? periods : DEFAULTS.periods.slice(),
    dayOff,
    override
  };
}

async function getConfig(env) {
  try {
    const row = await env.DB.prepare('SELECT value FROM config WHERE key = ?1').bind('schedule').first();
    if (row && row.value) return normalizeConfig(JSON.parse(row.value));
  } catch (e) {
    // config 表还没建：用默认值，不报错
  }
  return normalizeConfig(DEFAULTS);
}

async function saveConfig(env, cfg) {
  const value = JSON.stringify(cfg);
  await env.DB.prepare(
    'INSERT INTO config (key, value) VALUES (?1, ?2) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
    .bind('schedule', value)
    .run();
}

/* ---------------- 单元格解析 ---------------- */

function findPeriod(cfg, id) {
  return cfg.periods.find((x) => x.id === id) || null;
}

function resolveCell(p, period, cfg) {
  const ov = (cfg.override && cfg.override[p.dow + '-' + period.id]) || {};
  const cap = ov.cap === undefined ? period.cap : ov.cap;
  const off = ov.off === true || cfg.dayOff.indexOf(p.dow) >= 0 || cap <= 0;
  const [sh, sm] = period.start.split(':').map(Number);
  return { cap, off, startEpoch: bjEpoch(p.y, p.m, p.d, sh, sm), open: 0 };
}

/* ---------------- 看板 ---------------- */

async function loadBoard(env, cfg, clientId, nick) {
  // 身份按「昵称」认：换手机、换浏览器、苹果加到桌面，只要名字一样就是同一个人
  const nickKey = String(nick || '').trim().slice(0, 12);
  const now = Date.now();
  const t = bjParts(now);
  const todayStr = ymd(t);
  const backToMon = (t.dow + 6) % 7;
  const monday = bjEpoch(t.y, t.m, t.d, 0, 0) - backToMon * 86400000;

  const weeks = [];
  for (let w = 0; w < 2; w++) {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const p = bjParts(monday + (w * 7 + i) * 86400000);
      days.push({ date: ymd(p), p });
    }
    weeks.push(days);
  }

  const from = weeks[0][0].date;
  const to = weeks[1][6].date;

  const rs = await env.DB.prepare(
    'SELECT slot_date, slot_id, client_id, nickname, created_at FROM signups WHERE slot_date >= ?1 AND slot_date <= ?2 ORDER BY created_at'
  )
    .bind(from, to)
    .all();

  const bucket = new Map();
  for (const r of rs.results || []) {
    const k = r.slot_date + '|' + r.slot_id;
    if (!bucket.has(k)) bucket.set(k, []);
    bucket.get(k).push(r);
  }


  // 会员自己：本周 / 本月 / 今年各报了几次（含已经上过的课，取消掉的不算）
  const monthStart = t.y + '-' + String(t.m).padStart(2, '0') + '-01';
  const lastDay = new Date(Date.UTC(t.y, t.m, 0)).getUTCDate();
  const monthEnd = t.y + '-' + String(t.m).padStart(2, '0') + '-' + String(lastDay).padStart(2, '0');
  const weekStart = weeks[0][0].date;
  const weekEnd = weeks[0][6].date;
  const yearStart = t.y + '-01-01';
  const yearEnd = t.y + '-12-31';
  const qFrom = [yearStart, weekStart].sort()[0];
  const qTo = [yearEnd, weekEnd].sort().slice(-1)[0];

  // 后台可以关掉这个统计（关掉就完全不算、也不返回，省一次查询）
  let stats = null;
  if (cfg.showStats) {
    let statDates = [];
    const idCol = nickKey ? 'nickname' : 'client_id';
    const idVal = nickKey || clientId;
    if (idVal) {
      const sr = await env.DB.prepare(
        'SELECT slot_date FROM signups WHERE ' + idCol + ' = ?1 AND slot_date >= ?2 AND slot_date <= ?3'
      )
        .bind(idVal, qFrom, qTo)
        .all();
      statDates = (sr.results || []).map((r) => r.slot_date);
    }
    const yearStr = String(t.y);
    stats = {
      week: statDates.filter((d) => d >= weekStart && d <= weekEnd).length,
      month: statDates.filter((d) => d >= monthStart && d <= monthEnd).length,
      year: statDates.filter((d) => d.slice(0, 4) === yearStr).length
    };
  }

  const meRow = await getMember(env, clientId);
  const myName = meRow ? meRow.nick : '';
  const renamesLeft = meRow ? Math.max(0, MAX_RENAMES - meRow.renames) : MAX_RENAMES;

  const cancelMs = cfg.cancelMin * 60000;

  const outWeeks = weeks.map((days, wi) => ({
    label: wi === 0 ? '本周' : '下周',
    range: mdText(days[0].p) + '-' + mdText(days[6].p),
    days: days.map(({ date, p }) => {
      const past = date < todayStr;
      const isToday = date === todayStr;
      const cells = cfg.periods.map((per) => {
        const cfgCell = resolveCell(p, per, cfg);
        const list = bucket.get(date + '|' + per.id) || [];
        const mineRow = (nickKey
          ? list.find((x) => x.nickname === nickKey)
          : list.find((x) => x.client_id === clientId)) || null;
        const count = list.length;
        return {
          periodId: per.id,
          time: per.start + '-' + per.end,
          cap: cfgCell.cap,
          count,
          full: cfgCell.cap > 0 && count >= cfgCell.cap,
          off: cfgCell.off,
          open: !cfgCell.off && !past && now < cfgCell.startEpoch,
          mine: !!mineRow,
          myAt: mineRow ? mineRow.created_at : null,
          canCancel: !!mineRow && now - mineRow.created_at <= cancelMs,
          cancelLeft: mineRow ? Math.max(0, cancelMs - (now - mineRow.created_at)) : 0,
          names: list.map((x) => x.nickname)
        };
      });
      return { date, weekday: WEEK_CN[p.dow], md: mdText(p), past, isToday, cells };
    })
  }));

  return {
    title: cfg.title,
    subtitle: cfg.subtitle.replace('{n}', String(cfg.cancelMin)),
    now,
    today: todayStr,
    cancelMin: cfg.cancelMin,
    stats,
    myName,
    renamesLeft,
    renamesMax: MAX_RENAMES,
    periods: cfg.periods.map((p) => ({ id: p.id, start: p.start, end: p.end })),
    weeks: outWeeks
  };
}

/* ---------------- 报名（会员） ---------------- */

async function doSignup(env, cfg, body) {
  const { date, slotId, clientId, nickname } = body || {};
  if (!clientId) return { error: '缺少身份标识，请刷新页面' };

  const nick = String(nickname || '').trim().slice(0, 12);
  if (!nick) return { error: '请先填一个昵称' };

  const p = parseYmd(date);
  if (!p) return { error: '日期不对' };
  const period = findPeriod(cfg, slotId);
  if (!period) return { error: '没有这个时段' };

  const c = resolveCell(p, period, cfg);
  if (c.off) return { error: '这个时段不开课' };
  if (Date.now() >= c.startEpoch) return { error: '这个时段已经开始了，不能再报名' };

  // 一个人同一节课只能报一次：
  // 既按身份编号拦（同一台设备），也按昵称拦（换手机、清缓存后重名）
  const dup = await env.DB.prepare(
    'SELECT client_id FROM signups WHERE slot_date = ?1 AND slot_id = ?2 AND (client_id = ?3 OR nickname = ?4) LIMIT 1'
  )
    .bind(date, slotId, clientId, nick)
    .first();
  if (dup) return { error: '「' + nick + '」已经报过这个时段了，同一节课只能报一次' };

  const sql =
    'INSERT INTO signups (slot_date, slot_id, client_id, nickname, created_at) ' +
    'SELECT ?1, ?2, ?3, ?4, ?5 ' +
    'WHERE (SELECT COUNT(*) FROM signups WHERE slot_date = ?1 AND slot_id = ?2) < ?6';

  let res;
  try {
    res = await env.DB.prepare(sql).bind(date, slotId, clientId, nick, Date.now(), c.cap).run();
  } catch (e) {
    if (/UNIQUE/i.test(String((e && e.message) || ''))) return { error: '你已经报过这个时段了' };
    throw e;
  }

  if (!res.meta || !res.meta.changes) return { error: '名额已满' };
  return { ok: true };
}

/* ---------------- 取消（会员，3 分钟内） ---------------- */

async function doCancel(env, cfg, body) {
  const { date, slotId, clientId, nickname } = body || {};
  const nick = String(nickname || '').trim().slice(0, 12);
  if (!nick && !clientId) return { error: '缺少身份标识，请刷新页面' };

  const idCol = nick ? 'nickname' : 'client_id';
  const idVal = nick || clientId;

  const row = await env.DB.prepare(
    'SELECT created_at FROM signups WHERE slot_date = ?1 AND slot_id = ?2 AND ' + idCol + ' = ?3'
  )
    .bind(date, slotId, idVal)
    .first();

  if (!row) return { error: '你没有报名这个时段' };
  const cancelMs = cfg.cancelMin * 60000;
  if (Date.now() - row.created_at > cancelMs) {
    return { error: '已超过 ' + cfg.cancelMin + ' 分钟，不能取消了' };
  }

  await env.DB.prepare(
    'DELETE FROM signups WHERE slot_date = ?1 AND slot_id = ?2 AND ' + idCol + ' = ?3'
  )
    .bind(date, slotId, idVal)
    .run();

  return { ok: true };
}

/* ---------------- 管理：单元格详情 ---------------- */

async function adminCell(env, cfg, date, slotId) {
  const p = parseYmd(date);
  if (!p) return { error: '日期不对' };
  const period = findPeriod(cfg, slotId);
  if (!period) return { error: '没有这个时段' };

  const c = resolveCell(p, period, cfg);
  const now = Date.now();

  const rs = await env.DB.prepare(
    'SELECT client_id, nickname, created_at FROM signups WHERE slot_date = ?1 AND slot_id = ?2 ORDER BY created_at'
  )
    .bind(date, slotId)
    .all();

  const people = (rs.results || []).map((r) => ({
    clientId: r.client_id,
    nickname: r.nickname,
    at: r.created_at,
    byAdmin: String(r.client_id).indexOf('adm:') === 0
  }));

  return {
    date,
    slotId,
    weekday: WEEK_CN[p.dow],
    md: mdText(p),
    time: period.start + '-' + period.end,
    cap: c.cap,
    count: people.length,
    off: c.off,
    started: now >= c.startEpoch,
    past: date < ymd(bjParts(now)),
    editable: !c.off && now < c.startEpoch && date >= ymd(bjParts(now)),
    people
  };
}

/* ---------------- 管理：代报名 ---------------- */

async function adminSign(env, cfg, body) {
  const { date, slotId, nickname } = body || {};
  const nick = String(nickname || '').trim().slice(0, 12);
  if (!nick) return { error: '请填要代报的昵称' };

  const p = parseYmd(date);
  if (!p) return { error: '日期不对' };
  const period = findPeriod(cfg, slotId);
  if (!period) return { error: '没有这个时段' };

  const c = resolveCell(p, period, cfg);
  if (c.off) return { error: '这个时段不开课' };
  if (Date.now() >= c.startEpoch) return { error: '这个时段已经开始了，不能再报名' };

  // 代报也要查重：这个名字（不管是他自己报的还是别的管理员代报的）在这一格已经存在就不许再加
  const dup = await env.DB.prepare(
    'SELECT client_id FROM signups WHERE slot_date = ?1 AND slot_id = ?2 AND (nickname = ?3 OR client_id = ?4) LIMIT 1'
  )
    .bind(date, slotId, nick, 'adm:' + nick)
    .first();
  if (dup) return { error: '「' + nick + '」已经报过这个时段了，不能重复代报' };

  const clientId = 'adm:' + nick;
  const sql =
    'INSERT INTO signups (slot_date, slot_id, client_id, nickname, created_at) ' +
    'SELECT ?1, ?2, ?3, ?4, ?5 ' +
    'WHERE (SELECT COUNT(*) FROM signups WHERE slot_date = ?1 AND slot_id = ?2) < ?6';

  let res;
  try {
    res = await env.DB.prepare(sql).bind(date, slotId, clientId, nick, Date.now(), c.cap).run();
  } catch (e) {
    if (/UNIQUE/i.test(String((e && e.message) || ''))) return { error: '这个名字已经报过了' };
    throw e;
  }

  if (!res.meta || !res.meta.changes) return { error: '名额已满（上限 ' + c.cap + ' 人）' };
  return { ok: true };
}

/* ---------------- 管理：删除某人 ---------------- */

async function adminRemove(env, cfg, body) {
  const { date, slotId, clientId } = body || {};
  if (!clientId) return { error: '缺少要删除的人' };

  const p = parseYmd(date);
  if (!p) return { error: '日期不对' };
  const period = findPeriod(cfg, slotId);
  if (!period) return { error: '没有这个时段' };

  const c = resolveCell(p, period, cfg);
  if (Date.now() >= c.startEpoch) return { error: '这个时段已经开始了，不能改报名' };
  if (c.off) return { error: '这个时段不开课' };

  const res = await env.DB.prepare(
    'DELETE FROM signups WHERE slot_date = ?1 AND slot_id = ?2 AND client_id = ?3'
  )
    .bind(date, slotId, clientId)
    .run();

  if (!res.meta || !res.meta.changes) return { error: '没找到这条报名记录' };
  return { ok: true };
}


/* ---------------- 会员档案：昵称 + 改名次数 ---------------- */

async function getMember(env, clientId) {
  if (!clientId) return null;
  try {
    return await env.DB.prepare(
      'SELECT nick, renames FROM members WHERE client_id = ?1'
    ).bind(clientId).first();
  } catch (e) {
    return null; // members 表还没建，当作没档案
  }
}

// 改这个人的名字：档案 + 他名下所有报名记录一起改，
// 否则改名就等于把以前的报名弄丢了。
async function renameEverybody(env, clientId, nick, lock) {
  await env.DB.prepare(
    'UPDATE signups SET nickname = ?1 WHERE client_id = ?2'
  ).bind(nick, clientId).run();

  const m = await getMember(env, clientId);
  if (m) {
    await env.DB.prepare(
      'UPDATE members SET nick = ?1 WHERE client_id = ?2'
    ).bind(nick, clientId).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO members (client_id, nick, renames, created_at) VALUES (?1, ?2, 0, ?3)'
    ).bind(clientId, nick, Date.now()).run();
  }

  // 管理员改的名，要把会员自助改名的机会清零——
  // 否则她随手一改就又把名字改回去了。
  if (lock) {
    await env.DB.prepare(
      'UPDATE members SET renames = ?1 WHERE client_id = ?2'
    ).bind(MAX_RENAMES, clientId).run();
  }
}

// 改成这个名字会不会和同一格里别人撞名
async function nameClash(env, clientId, nick) {
  try {
    const row = await env.DB.prepare(
      'SELECT 1 AS x FROM signups a ' +
      'JOIN signups b ON a.slot_date = b.slot_date AND a.slot_id = b.slot_id ' +
      'WHERE a.client_id = ?1 AND b.nickname = ?2 AND b.client_id <> ?1 LIMIT 1'
    ).bind(clientId, nick).first();
    return !!row;
  } catch (e) {
    return false; // 表没有时不做检查，别把改名卡死
  }
}

async function setName(env, body) {
  const { clientId, nickname } = body || {};
  if (!clientId) return { error: '缺少身份标识，请刷新页面' };

  const nick = String(nickname || '').trim().slice(0, 12);
  if (!nick) return { error: '请填一个昵称' };

  let member;
  try {
    member = await env.DB.prepare(
      'SELECT nick, renames FROM members WHERE client_id = ?1'
    ).bind(clientId).first();
  } catch (e) {
    return { error: '数据库缺少 members 表，请先在 D1 里执行最新的 schema.sql' };
  }

  // 名字没变：不算次数
  if (member && member.nick === nick) {
    return { ok: true, nick, renamesLeft: Math.max(0, MAX_RENAMES - member.renames) };
  }

  if (member && member.renames >= MAX_RENAMES) {
    return { error: '改名次数已用完（只能改 ' + MAX_RENAMES + ' 次），要改请找群主' };
  }

  if (await nameClash(env, clientId, nick)) {
    return { error: '「' + nick + '」已经有人用了，换一个名字' };
  }

  await renameEverybody(env, clientId, nick, false);

  let left = MAX_RENAMES;
  if (member) {
    await env.DB.prepare(
      'UPDATE members SET renames = renames + 1 WHERE client_id = ?1'
    ).bind(clientId).run();
    left = Math.max(0, MAX_RENAMES - (member.renames + 1));
  }
  return { ok: true, nick, renamesLeft: left };
}

async function adminRename(env, cfg, body) {
  const { clientId, nickname } = body || {};
  if (!clientId) return { error: '缺少要改名的人' };

  const nick = String(nickname || '').trim().slice(0, 12);
  if (!nick) return { error: '昵称不能为空' };

  // 有报名记录，或者只是建过名字（还没报名）都允许改
  const hasSignup = await env.DB.prepare(
    'SELECT 1 AS x FROM signups WHERE client_id = ?1 LIMIT 1'
  ).bind(clientId).first();
  const hasProfile = await getMember(env, clientId);
  if (!hasSignup && !hasProfile) return { error: '没找到这个人的记录' };

  if (await nameClash(env, clientId, nick)) return { error: '「' + nick + '」已经有人用了' };

  await renameEverybody(env, clientId, nick, true);
  return { ok: true, locked: true };
}

async function adminResetRenames(env, body) {
  const { clientId } = body || {};
  if (!clientId) return { error: '缺少要重置的人' };

  try {
    const res = await env.DB.prepare(
      'UPDATE members SET renames = 0 WHERE client_id = ?1'
    ).bind(clientId).run();
    if (!res.meta || !res.meta.changes) return { error: '这个人还没设过名字，不用重置' };
    return { ok: true };
  } catch (e) {
    return { error: '数据库缺少 members 表，请先执行最新的 schema.sql' };
  }
}

/* ---------------- 入口 ---------------- */


function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function isAdmin(env, request) {
  const key = request.headers.get('x-admin-key') || '';
  return !!env.ADMIN_PASSWORD && key === env.ADMIN_PASSWORD;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');

  if (!env.DB) {
    return json({ error: '数据库未绑定：请在 Pages 项目 Settings → Bindings 里加一个 D1 绑定，变量名必须是 DB' }, 500);
  }

  try {
    /* ---- 管理：登录 ---- */
    if (path === 'admin/login') {
      if (request.method !== 'POST') return json({ error: '请用 POST' }, 405);
      if (!env.ADMIN_PASSWORD) {
        return json({ error: '还没设置管理员密码：请在 Pages 项目 Settings → Environment variables 里加一个 ADMIN_PASSWORD，然后重新部署' }, 500);
      }
      const body = await request.json().catch(() => ({}));
      if (String(body.password || '') !== env.ADMIN_PASSWORD) return json({ error: '密码不对' }, 401);
      return json({ ok: true });
    }

    /* ---- 管理：以下都要密码 ---- */
    if (path.indexOf('admin/') === 0) {
      if (!isAdmin(env, request)) return json({ error: '没有权限，请重新登录' }, 401);
      const cfg = await getConfig(env);

      if (path === 'admin/config') {
        if (request.method === 'GET') return json({ config: cfg });
        const body = await request.json().catch(() => ({}));
        const next = normalizeConfig(body.config || {});
        await saveConfig(env, next);
        return json({ ok: true, config: next });
      }

      if (path === 'admin/board') {
        return json(await loadBoard(env, cfg, url.searchParams.get('client') || ''));
      }

      if (path === 'admin/cell') {
        return json(await adminCell(env, cfg, url.searchParams.get('date') || '', url.searchParams.get('slotId') || ''));
      }

      if (path === 'admin/rename' || path === 'admin/resetrenames') {
        if (request.method !== 'POST') return json({ error: '请用 POST' }, 405);
        const body = await request.json().catch(() => ({}));
        const out = path === 'admin/rename'
          ? await adminRename(env, cfg, body)
          : await adminResetRenames(env, body);
        return json(out, out.error ? 400 : 200);
      }

      if (path === 'admin/sign' || path === 'admin/remove') {
        if (request.method !== 'POST') return json({ error: '请用 POST' }, 405);
        const body = await request.json().catch(() => ({}));
        const out = path === 'admin/sign'
          ? await adminSign(env, cfg, body)
          : await adminRemove(env, cfg, body);
        return json(out, out.error ? 400 : 200);
      }

      return json({ error: '接口不存在' }, 404);
    }

    /* ---- 会员 ---- */
    const cfg = await getConfig(env);

    if (path === 'board') {
      return json(await loadBoard(
        env,
        cfg,
        url.searchParams.get('client') || '',
        url.searchParams.get('nick') || ''
      ));
    }

    if (path === 'myname') {
      if (request.method !== 'POST') return json({ error: '请用 POST' }, 405);
      const body = await request.json().catch(() => ({}));
      const out = await setName(env, body);
      return json(out, out.error ? 400 : 200);
    }

    if (path === 'signup' || path === 'cancel') {
      if (request.method !== 'POST') return json({ error: '请用 POST' }, 405);
      const body = await request.json().catch(() => ({}));
      const out = path === 'signup' ? await doSignup(env, cfg, body) : await doCancel(env, cfg, body);
      return json(out, out.error ? 400 : 200);
    }

    return json({ error: '接口不存在' }, 404);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}
