/**
 * Hihi Studio · 后端 v1.1（课表格子化）
 *
 * 核心变化：课表从「全周共用一组时段」改成「7 天 × N 节的格子矩阵」。
 *   · 每一天可以有自己的时间、名额、开关
 *   · 每节课固定 slotMinutes 分钟，结束时间由开始时间推算
 *   · 老配置（periods / dayOff / override）会自动迁移，时段 id 保持不变
 */

/* ==================== 默认课表 ==================== */

const BASE_PERIODS = [
  { id: 't1', start: '08:30', cap: 8 },
  { id: 't2', start: '09:45', cap: 8 },
  { id: 't3', start: '11:00', cap: 8 },
  { id: 't4', start: '15:00', cap: 10 },
  { id: 't5', start: '16:10', cap: 10 },
  { id: 't6', start: '19:30', cap: 10 },
  { id: 't7', start: '20:45', cap: 10 }
];

function defaultDays() {
  const days = {};
  for (let d = 0; d < 7; d++) {
    days[d] = d === 0 ? [] : BASE_PERIODS.map((p) => ({ id: p.id, start: p.start, cap: p.cap }));
  }
  return days;
}

const DEFAULTS = {
  title: 'Hihi Studio',
  subtitle: '点格子报名 · 报名后 3 分钟内可取消',
  cancelMin: 3,
  maxPerDay: 2,
  showStats: true,
  slotMinutes: 60,
  days: defaultDays()
};

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const TZ = 8 * 3600 * 1000;
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOGIN_MAX_FAILS = 5;
const CODE_MAX_FAILS = 10;
const LOCK_MS = 10 * 60 * 1000;

/* ==================== 小工具 ==================== */

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

function mdText(p) { return p.m + '/' + p.d; }

function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d, dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() };
}

function hhmmOk(s) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || '')); }

function toMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return -1;
  return (+m[1]) * 60 + (+m[2]);
}

function fromMin(n) {
  n = ((n % 1440) + 1440) % 1440;
  return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
}

function intIn(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function normCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function cleanName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 12);
}

function safeId(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16);
}

function newId() {
  const buf = new Uint8Array(5);
  crypto.getRandomValues(buf);
  let out = 's';
  for (let i = 0; i < 5; i++) out += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return out.toLowerCase();
}

/* ==================== 配置 ==================== */

function normSlot(s) {
  if (!s || !hhmmOk(s.start)) return null;
  const cap = intIn(s.cap, 0, 999, 8);
  const out = {
    id: safeId(s.id) || newId(),
    start: s.start,
    cap
  };
  if (s.off === true || cap === 0) out.off = true;
  return out;
}

function normalizeDays(d) {
  const out = {};
  for (let i = 0; i < 7; i++) {
    let arr = d[i];
    if (!Array.isArray(arr) && Array.isArray(d[String(i)])) arr = d[String(i)];
    if (!Array.isArray(arr)) arr = [];
    out[i] = arr.map(normSlot).filter(Boolean).slice(0, 12);
  }
  return out;
}

// 老格式 → 新格式。保留原时段 id，历史报名不会错位。
function migrateOld(c) {
  const periods = Array.isArray(c.periods) ? c.periods : [];
  const dayOff = Array.isArray(c.dayOff) ? c.dayOff.map(Number) : [];
  const ov = (c.override && typeof c.override === 'object') ? c.override : {};
  const days = {};
  for (let d = 0; d < 7; d++) {
    if (dayOff.indexOf(d) >= 0) { days[d] = []; continue; }
    days[d] = periods.map((p) => {
      const o = ov[d + '-' + p.id] || {};
      const slot = {
        id: safeId(p.id) || newId(),
        start: hhmmOk(p.start) ? p.start : '09:00',
        cap: o.cap === undefined ? intIn(p.cap, 0, 999, 8) : intIn(o.cap, 0, 999, 8)
      };
      if (o.off === true) slot.off = true;
      return slot;
    }).filter((s) => s);
  }
  return days;
}

function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  let days;
  if (c.days && typeof c.days === 'object') days = normalizeDays(c.days);
  else if (Array.isArray(c.periods)) days = normalizeDays(migrateOld(c));
  else days = normalizeDays(DEFAULTS.days);

  return {
    title: String(c.title || DEFAULTS.title).slice(0, 40),
    subtitle: String(c.subtitle === undefined ? DEFAULTS.subtitle : c.subtitle).slice(0, 80),
    cancelMin: intIn(c.cancelMin, 1, 120, 3),
    maxPerDay: intIn(c.maxPerDay, 1, 20, 2),
    showStats: c.showStats !== false,
    slotMinutes: intIn(c.slotMinutes, 15, 300, 60),
    days
  };
}

async function getConfig(env) {
  try {
    const row = await env.DB.prepare('SELECT value FROM config WHERE key = ?1').bind('schedule').first();
    if (row && row.value) return normalizeConfig(JSON.parse(row.value));
  } catch (e) { /* 表还没建 */ }
  return normalizeConfig(DEFAULTS);
}

async function saveConfig(env, cfg) {
  await env.DB.prepare(
    'INSERT INTO config (key, value) VALUES (?1, ?2) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind('schedule', JSON.stringify(cfg)).run();
}

/* ==================== 格子 ==================== */

function slotsOf(cfg, dow) {
  const a = cfg.days[dow];
  return Array.isArray(a) ? a : [];
}

function maxRows(cfg) {
  let n = 0;
  for (let d = 0; d < 7; d++) n = Math.max(n, slotsOf(cfg, d).length);
  return n;
}

// 每一行的"常规时间"：该行出现次数最多的开始时间
function rowStd(cfg, rows) {
  const out = [];
  for (let i = 0; i < rows; i++) {
    const cnt = {};
    for (let d = 0; d < 7; d++) {
      const s = slotsOf(cfg, d)[i];
      if (s && !s.off) cnt[s.start] = (cnt[s.start] || 0) + 1;
    }
    let best = '';
    let n = 0;
    for (const k of Object.keys(cnt)) {
      if (cnt[k] > n) { n = cnt[k]; best = k; }
    }
    out.push(best);
  }
  return out;
}

function slotEnd(cfg, slot) {
  const sm = toMin(slot.start);
  return fromMin(sm + cfg.slotMinutes);
}

function resolveCell(p, slot, cfg) {
  if (!slot) return null;
  const cap = slot.cap === undefined ? 0 : slot.cap;
  const off = slot.off === true || cap <= 0;
  const [sh, sm] = slot.start.split(':').map(Number);
  return {
    cap,
    off,
    start: slot.start,
    end: slotEnd(cfg, slot),
    startEpoch: bjEpoch(p.y, p.m, p.d, sh, sm)
  };
}

function findSlot(cfg, dow, slotId) {
  const arr = slotsOf(cfg, dow);
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].id === slotId) return { slot: arr[i], index: i };
  }
  return null;
}

/* ==================== 名单 / 入场码 ==================== */

function makeCode() {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return out;
}

async function uniqueCode(env) {
  for (let i = 0; i < 12; i++) {
    const c = makeCode();
    const hit = await env.DB.prepare('SELECT 1 AS x FROM roster WHERE code = ?1').bind(c).first();
    if (!hit) return c;
  }
  return makeCode();
}

async function rosterByCode(env, code) {
  if (!code) return null;
  try {
    return await env.DB.prepare('SELECT nick, code, disabled FROM roster WHERE code = ?1').bind(code).first();
  } catch (e) { return null; }
}

async function rosterByNick(env, nick) {
  if (!nick) return null;
  try {
    return await env.DB.prepare('SELECT nick, code, disabled FROM roster WHERE nick = ?1').bind(nick).first();
  } catch (e) { return null; }
}

async function touchDevice(env, code, clientId) {
  if (!code || !clientId) return;
  try {
    const now = Date.now();
    const hit = await env.DB.prepare(
      'SELECT 1 AS x FROM roster_devices WHERE code = ?1 AND client_id = ?2'
    ).bind(code, clientId).first();
    if (!hit) {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO roster_devices (code, client_id, first_seen, last_seen) VALUES (?1,?2,?3,?3)'
      ).bind(code, clientId, now).run();
    }
    const r = await env.DB.prepare('SELECT last_seen FROM roster WHERE code = ?1').bind(code).first();
    if (!r || !r.last_seen || now - r.last_seen > 300000) {
      await env.DB.prepare('UPDATE roster SET last_seen = ?1 WHERE code = ?2').bind(now, code).run();
    }
  } catch (e) { /* 忽略 */ }
}

/* ==================== 防爆破 ==================== */

function ipOf(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

async function lockedMinutes(env, key) {
  try {
    const row = await env.DB.prepare('SELECT until FROM throttle WHERE key = ?1').bind(key).first();
    if (row && row.until && row.until > Date.now()) {
      return Math.ceil((row.until - Date.now()) / 60000);
    }
  } catch (e) { /* 忽略 */ }
  return 0;
}

async function addFail(env, key, maxFails) {
  try {
    const now = Date.now();
    const row = await env.DB.prepare('SELECT fails, until FROM throttle WHERE key = ?1').bind(key).first();
    let fails = (row ? row.fails : 0) + 1;
    let until = 0;
    if (fails >= maxFails) { until = now + LOCK_MS; fails = 0; }
    await env.DB.prepare(
      'INSERT INTO throttle (key, fails, until) VALUES (?1,?2,?3) ' +
      'ON CONFLICT(key) DO UPDATE SET fails = excluded.fails, until = excluded.until'
    ).bind(key, fails, until).run();
  } catch (e) { /* 忽略 */ }
}

async function clearFails(env, key) {
  try {
    await env.DB.prepare('DELETE FROM throttle WHERE key = ?1').bind(key).run();
  } catch (e) { /* 忽略 */ }
}

/* ==================== 看板 ==================== */

async function loadBoard(env, cfg, who, clientId) {
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
    'SELECT slot_date, slot_id, nickname, created_at FROM signups ' +
    'WHERE slot_date >= ?1 AND slot_date <= ?2 ORDER BY created_at'
  ).bind(from, to).all();

  const bucket = new Map();
  for (const r of rs.results || []) {
    const k = r.slot_date + '|' + r.slot_id;
    if (!bucket.has(k)) bucket.set(k, []);
    bucket.get(k).push(r);
  }

  const myName = who ? who.nick : '';
  const rows = maxRows(cfg);
  const std = rowStd(cfg, rows);

  let stats = null;
  if (cfg.showStats) {
    const monthStart = t.y + '-' + String(t.m).padStart(2, '0') + '-01';
    const lastDay = new Date(Date.UTC(t.y, t.m, 0)).getUTCDate();
    const monthEnd = t.y + '-' + String(t.m).padStart(2, '0') + '-' + String(lastDay).padStart(2, '0');
    const weekStart = weeks[0][0].date;
    const weekEnd = weeks[0][6].date;
    const yearStart = t.y + '-01-01';
    const yearEnd = t.y + '-12-31';
    const qFrom = [yearStart, weekStart].sort()[0];
    const qTo = [yearEnd, weekEnd].sort().slice(-1)[0];

    let dates = [];
    if (myName) {
      const sr = await env.DB.prepare(
        'SELECT slot_date FROM signups WHERE nickname = ?1 AND slot_date >= ?2 AND slot_date <= ?3'
      ).bind(myName, qFrom, qTo).all();
      dates = (sr.results || []).map((r) => r.slot_date);
    }
    const yearStr = String(t.y);
    stats = {
      week: dates.filter((d) => d >= weekStart && d <= weekEnd).length,
      month: dates.filter((d) => d >= monthStart && d <= monthEnd).length,
      year: dates.filter((d) => d.slice(0, 4) === yearStr).length
    };
  }

  const cancelMs = cfg.cancelMin * 60000;

  const outWeeks = weeks.map((days, wi) => ({
    label: wi === 0 ? '本周' : '下周',
    range: mdText(days[0].p) + '-' + mdText(days[6].p),
    days: days.map(({ date, p }) => {
      const past = date < todayStr;
      const isToday = date === todayStr;
      const arr = slotsOf(cfg, p.dow);

      const cells = [];
      for (let i = 0; i < rows; i++) {
        const slot = arr[i];
        if (!slot) { cells.push({ row: i, empty: true }); continue; }

        const cc = resolveCell(p, slot, cfg);
        const list = bucket.get(date + '|' + slot.id) || [];
        const mineRow = myName ? (list.find((x) => x.nickname === myName) || null) : null;
        const count = list.length;

        cells.push({
          row: i,
          periodId: slot.id,
          start: cc.start,
          end: cc.end,
          time: cc.start + '-' + cc.end,
          odd: !!std[i] && cc.start !== std[i],
          cap: cc.cap,
          count,
          full: cc.cap > 0 && count >= cc.cap,
          off: cc.off,
          open: !cc.off && !past && now < cc.startEpoch,
          mine: !!mineRow,
          canCancel: !!mineRow && now - mineRow.created_at <= cancelMs,
          cancelLeft: mineRow ? Math.max(0, cancelMs - (now - mineRow.created_at)) : 0,
          names: list.map((x) => x.nickname)
        });
      }

      let myCountToday = 0;
      if (myName) {
        for (const per of arr) {
          const l = bucket.get(date + '|' + per.id) || [];
          if (l.some((x) => x.nickname === myName)) myCountToday++;
        }
      }

      return { date, weekday: WEEK_CN[p.dow], md: mdText(p), past, isToday, myCountToday, cells };
    })
  }));

  return {
    title: cfg.title,
    subtitle: cfg.subtitle,
    now, today: todayStr,
    cancelMin: cfg.cancelMin,
    maxPerDay: cfg.maxPerDay,
    slotMinutes: cfg.slotMinutes,
    stats,
    myName,
    rows,
    rowStd: std,
    weeks: outWeeks
  };
}

/* ==================== 会员：报名 / 取消 ==================== */

async function doSignup(env, cfg, who, body) {
  if (!who) return { error: '需要入场码' };
  if (who.disabled) return { error: '你的入场码已失效，请联系群主' };

  const { date, slotId } = body || {};
  const p = parseYmd(date);
  if (!p) return { error: '日期不对' };

  const found = findSlot(cfg, p.dow, slotId);
  if (!found) return { error: '没有这个时段' };
  const slot = found.slot;

  const cc = resolveCell(p, slot, cfg);
  if (cc.off) return { error: '这个时段不开课' };
  if (Date.now() >= cc.startEpoch) return { error: '这个时段已经开始了，不能再报名' };

  const used = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM signups WHERE nickname = ?1 AND slot_date = ?2'
  ).bind(who.nick, date).first();
  if (used && used.n >= cfg.maxPerDay) {
    return { error: '这一天你已经报了 ' + used.n + ' 节，最多 ' + cfg.maxPerDay + ' 节。要加课请联系群主' };
  }

  const sql =
    'INSERT INTO signups (slot_date, slot_id, nickname, created_at) ' +
    'SELECT ?1, ?2, ?3, ?4 ' +
    'WHERE (SELECT COUNT(*) FROM signups WHERE slot_date = ?1 AND slot_id = ?2) < ?5';

  let res;
  try {
    res = await env.DB.prepare(sql).bind(date, slot.id, who.nick, Date.now(), cc.cap).run();
  } catch (e) {
    if (/UNIQUE/i.test(String((e && e.message) || ''))) return { error: '你已经报过这个时段了' };
    throw e;
  }
  if (!res.meta || !res.meta.changes) return { error: '名额已满' };
  return { ok: true };
}

async function doCancel(env, cfg, who, body) {
  if (!who) return { error: '需要入场码' };
  const { date, slotId } = body || {};

  const row = await env.DB.prepare(
    'SELECT created_at FROM signups WHERE slot_date = ?1 AND slot_id = ?2 AND nickname = ?3'
  ).bind(date, slotId, who.nick).first();

  if (!row) return { error: '你没有报名这个时段' };
  if (Date.now() - row.created_at > cfg.cancelMin * 60000) {
    return { error: '已超过 ' + cfg.cancelMin + ' 分钟，不能取消了' };
  }

  await env.DB.prepare(
    'DELETE FROM signups WHERE slot_date = ?1 AND slot_id = ?2 AND nickname = ?3'
  ).bind(date, slotId, who.nick).run();

  return { ok: true };
}

/* ==================== 管理：格子 ==================== */

async function adminCell(env, cfg, date, slotId) {
  const p = parseYmd(date);
  if (!p) return { error: '日期不对' };

  const found = findSlot(cfg, p.dow, slotId);
  if (!found) return { error: '没有这个时段' };
  const slot = found.slot;

  const cc = resolveCell(p, slot, cfg);
  const now = Date.now();
  const todayStr = ymd(bjParts(now));

  const rs = await env.DB.prepare(
    'SELECT nickname, created_at FROM signups WHERE slot_date = ?1 AND slot_id = ?2 ORDER BY created_at'
  ).bind(date, slotId).all();

  const people = (rs.results || []).map((r) => ({ nickname: r.nickname, at: r.created_at }));

  return {
    date, slotId,
    row: found.index,
    weekday: WEEK_CN[p.dow], md: mdText(p),
    start: cc.start, end: cc.end,
    time: cc.start + '-' + cc.end,
    cap: cc.cap, count: people.length, off: cc.off,
    started: now >= cc.startEpoch,
    past: date < todayStr,
    editable: !cc.off && now < cc.startEpoch && date >= todayStr,
    people
  };
}

async function adminSign(env, cfg, body) {
  const { date, slotId } = body || {};
  const nick = cleanName(body && body.nickname);
  if (!nick) return { error: '请填要代报的名字' };

  const r = await rosterByNick(env, nick);
  if (!r) return { error: '名单里没有「' + nick + '」，先在「名单」页签里加进来' };
  if (r.disabled) return { error: '「' + nick + '」已被移出名单' };

  const p = parseYmd(date);
  if (!p) return { error: '日期不对' };

  const found = findSlot(cfg, p.dow, slotId);
  if (!found) return { error: '没有这个时段' };
  const slot = found.slot;

  const cc = resolveCell(p, slot, cfg);
  if (cc.off) return { error: '这个时段不开课' };
  if (Date.now() >= cc.startEpoch) return { error: '这个时段已经开始了，不能再报名' };

  const sql =
    'INSERT INTO signups (slot_date, slot_id, nickname, created_at) ' +
    'SELECT ?1, ?2, ?3, ?4 ' +
    'WHERE (SELECT COUNT(*) FROM signups WHERE slot_date = ?1 AND slot_id = ?2) < ?5';

  let res;
  try {
    res = await env.DB.prepare(sql).bind(date, slotId, nick, Date.now(), cc.cap).run();
  } catch (e) {
    if (/UNIQUE/i.test(String((e && e.message) || ''))) return { error: '「' + nick + '」已经报过这个时段了' };
    throw e;
  }
  if (!res.meta || !res.meta.changes) return { error: '名额已满（上限 ' + cc.cap + ' 人）' };
  return { ok: true };
}

async function adminRemove(env, cfg, body) {
  const { date, slotId } = body || {};
  const nick = cleanName(body && body.nickname);
  if (!nick) return { error: '缺少要删除的人' };

  const p = parseYmd(date);
  if (!p) return { error: '日期不对' };

  const found = findSlot(cfg, p.dow, slotId);
  if (!found) return { error: '没有这个时段' };

  const cc = resolveCell(p, found.slot, cfg);
  if (Date.now() >= cc.startEpoch) return { error: '这个时段已经开始了，不能改报名' };

  const res = await env.DB.prepare(
    'DELETE FROM signups WHERE slot_date = ?1 AND slot_id = ?2 AND nickname = ?3'
  ).bind(date, slotId, nick).run();

  if (!res.meta || !res.meta.changes) return { error: '没找到这条报名记录' };
  return { ok: true };
}

/* ==================== 管理：名单 ==================== */

async function adminRoster(env) {
  const rs = await env.DB.prepare(
    'SELECT nick, code, disabled, created_at, last_seen FROM roster ' +
    'ORDER BY disabled ASC, created_at DESC'
  ).all();

  const dev = await env.DB.prepare('SELECT code, COUNT(*) AS n FROM roster_devices GROUP BY code').all();
  const devMap = new Map();
  for (const d of dev.results || []) devMap.set(d.code, d.n);

  const cnt = await env.DB.prepare('SELECT nickname, COUNT(*) AS n FROM signups GROUP BY nickname').all();
  const cntMap = new Map();
  for (const c of cnt.results || []) cntMap.set(c.nickname, c.n);

  return {
    people: (rs.results || []).map((r) => ({
      nick: r.nick,
      code: r.code,
      disabled: !!r.disabled,
      devices: devMap.get(r.code) || 0,
      signups: cntMap.get(r.nick) || 0,
      lastSeen: r.last_seen || 0,
      createdAt: r.created_at
    }))
  };
}

async function adminRosterAdd(env, body) {
  const raw = String((body && body.names) || '');
  const names = raw.split(/[\n,，、;；]+/).map(cleanName).filter(Boolean);

  const uniq = [];
  for (const n of names) if (uniq.indexOf(n) < 0) uniq.push(n);
  if (!uniq.length) return { error: '没有解析出名字' };
  if (uniq.length > 200) return { error: '一次最多加 200 个' };

  const added = [];
  const skipped = [];

  for (const nick of uniq) {
    const exist = await env.DB.prepare('SELECT disabled FROM roster WHERE nick = ?1').bind(nick).first();
    if (exist) {
      if (exist.disabled) {
        await env.DB.prepare('UPDATE roster SET disabled = 0 WHERE nick = ?1').bind(nick).run();
        added.push(nick);
      } else {
        skipped.push(nick);
      }
      continue;
    }
    const code = await uniqueCode(env);
    await env.DB.prepare(
      'INSERT INTO roster (nick, code, disabled, created_at) VALUES (?1, ?2, 0, ?3)'
    ).bind(nick, code, Date.now()).run();
    added.push(nick);
  }

  return { ok: true, added, skipped };
}

async function adminRosterRotate(env, body) {
  const nick = cleanName(body && body.nick);
  if (!nick) return { error: '缺少名字' };
  const r = await rosterByNick(env, nick);
  if (!r) return { error: '名单里没有这个人' };

  const code = await uniqueCode(env);
  await env.DB.prepare('UPDATE roster SET code = ?1 WHERE nick = ?2').bind(code, nick).run();
  try {
    await env.DB.prepare('DELETE FROM roster_devices WHERE code = ?1').bind(r.code).run();
  } catch (e) { /* 忽略 */ }
  return { ok: true, code };
}

async function adminRosterRemove(env, body) {
  const nick = cleanName(body && body.nick);
  if (!nick) return { error: '缺少名字' };
  const r = await rosterByNick(env, nick);
  if (!r) return { error: '名单里没有这个人' };

  await env.DB.prepare('UPDATE roster SET disabled = 1 WHERE nick = ?1').bind(nick).run();

  let removed = 0;
  if (body && body.clearSignups) {
    const res = await env.DB.prepare('DELETE FROM signups WHERE nickname = ?1').bind(nick).run();
    removed = (res.meta && res.meta.changes) || 0;
  }
  return { ok: true, removedSignups: removed };
}

async function adminRosterRestore(env, body) {
  const nick = cleanName(body && body.nick);
  if (!nick) return { error: '缺少名字' };
  const r = await rosterByNick(env, nick);
  if (!r) return { error: '名单里没有这个人' };
  await env.DB.prepare('UPDATE roster SET disabled = 0 WHERE nick = ?1').bind(nick).run();
  return { ok: true };
}

async function adminRename(env, body) {
  const nick = cleanName(body && body.nick);
  const newNick = cleanName(body && body.newNick);
  if (!nick || !newNick) return { error: '名字不能为空' };
  if (nick === newNick) return { ok: true };

  const r = await rosterByNick(env, nick);
  if (!r) return { error: '名单里没有这个人' };
  if (await rosterByNick(env, newNick)) return { error: '「' + newNick + '」已经在名单里了' };

  await env.DB.prepare('UPDATE roster SET nick = ?1 WHERE nick = ?2').bind(newNick, nick).run();
  await env.DB.prepare('UPDATE signups SET nickname = ?1 WHERE nickname = ?2').bind(newNick, nick).run();
  return { ok: true };
}

/* ==================== 管理：导出 CSV ==================== */

async function adminExport(env, cfg, week) {
  const now = Date.now();
  const t = bjParts(now);
  const backToMon = (t.dow + 6) % 7;
  const base = bjEpoch(t.y, t.m, t.d, 0, 0) - backToMon * 86400000;
  const offset = (week === 1 ? 7 : 0) * 86400000;
  const from = ymd(bjParts(base + offset));
  const to = ymd(bjParts(base + offset + 6 * 86400000));

  const rs = await env.DB.prepare(
    'SELECT slot_date, slot_id, nickname FROM signups WHERE slot_date >= ?1 AND slot_date <= ?2'
  ).bind(from, to).all();

  const map = new Map();
  for (const r of rs.results || []) {
    const k = r.slot_date + '|' + r.slot_id;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r.nickname);
  }

  const rows = [['日期', '星期', '开始', '结束', '名额', '已报', '报名人']];
  for (let i = 0; i < 7; i++) {
    const p = bjParts(base + offset + i * 86400000);
    const date = ymd(p);
    for (const slot of slotsOf(cfg, p.dow)) {
      const cc = resolveCell(p, slot, cfg);
      if (cc.off) continue;
      const names = map.get(date + '|' + slot.id) || [];
      rows.push([date, WEEK_CN[p.dow], cc.start, cc.end,
                 String(cc.cap), String(names.length), names.join('、')]);
    }
  }

  const csv = rows.map((r) =>
    r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(',')
  ).join('\r\n');

  return { csv: '\uFEFF' + csv, filename: 'baoming_' + from + '_' + to + '.csv' };
}

/* ==================== 入口 ==================== */

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
  const ip = ipOf(request);

  if (!env.DB) {
    return json({ error: '数据库未绑定：Settings → Bindings 加 D1，变量名必须是 DB' }, 500);
  }

  try {
    if (path === 'admin/login') {
      if (request.method !== 'POST') return json({ error: '请用 POST' }, 405);
      if (!env.ADMIN_PASSWORD) {
        return json({ error: '还没设置管理员密码：Settings → Variables and secrets 加 ADMIN_PASSWORD，然后重新部署' }, 500);
      }
      const lock = await lockedMinutes(env, 'login:' + ip);
      if (lock > 0) return json({ error: '试太多次了，请等 ' + lock + ' 分钟再试' }, 429);

      const body = await request.json().catch(() => ({}));
      if (String(body.password || '') !== env.ADMIN_PASSWORD) {
        await addFail(env, 'login:' + ip, LOGIN_MAX_FAILS);
        return json({ error: '密码不对' }, 401);
      }
      await clearFails(env, 'login:' + ip);
      return json({ ok: true });
    }

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
      if (path === 'admin/board') return json(await loadBoard(env, cfg, null, ''));
      if (path === 'admin/cell') {
        return json(await adminCell(env, cfg, url.searchParams.get('date') || '', url.searchParams.get('slotId') || ''));
      }
      if (path === 'admin/roster') return json(await adminRoster(env));

      if (path === 'admin/export') {
        const out = await adminExport(env, cfg, url.searchParams.get('week') === '1' ? 1 : 0);
        return new Response(out.csv, {
          status: 200,
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="' + out.filename + '"',
            'cache-control': 'no-store'
          }
        });
      }

      if (request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        let out;
        if (path === 'admin/sign') out = await adminSign(env, cfg, body);
        else if (path === 'admin/remove') out = await adminRemove(env, cfg, body);
        else if (path === 'admin/roster/add') out = await adminRosterAdd(env, body);
        else if (path === 'admin/roster/rotate') out = await adminRosterRotate(env, body);
        else if (path === 'admin/roster/remove') out = await adminRosterRemove(env, body);
        else if (path === 'admin/roster/restore') out = await adminRosterRestore(env, body);
        else if (path === 'admin/rename') out = await adminRename(env, body);
        else return json({ error: '接口不存在' }, 404);
        return json(out, out.error ? 400 : 200);
      }

      return json({ error: '接口不存在' }, 404);
    }

    const cfg = await getConfig(env);

    const code = normCode(url.searchParams.get('k'));
    let who = null;
    if (code) {
      const lock = await lockedMinutes(env, 'code:' + ip);
      if (lock > 0) return json({ error: '输错太多次了，请等 ' + lock + ' 分钟再试', needCode: true }, 429);

      who = await rosterByCode(env, code);
      if (!who) {
        await addFail(env, 'code:' + ip, CODE_MAX_FAILS);
        return json({ error: '入场码不对，请检查后重新输入', needCode: true }, 401);
      }
      await clearFails(env, 'code:' + ip);
      if (who.disabled) {
        return json({ error: '你的入场码已失效，请联系群主', needCode: true }, 403);
      }
    }

    if (path === 'board') {
      if (!who) return json({ error: '需要入场码', needCode: true }, 401);
      await touchDevice(env, who.code, url.searchParams.get('client') || '');
      return json(await loadBoard(env, cfg, who, url.searchParams.get('client') || ''));
    }

    if (path === 'signup' || path === 'cancel') {
      if (request.method !== 'POST') return json({ error: '请用 POST' }, 405);
      if (!who) return json({ error: '需要入场码', needCode: true }, 401);
      const body = await request.json().catch(() => ({}));
      const out = path === 'signup'
        ? await doSignup(env, cfg, who, body)
        : await doCancel(env, cfg, who, body);
      return json(out, out.error ? 400 : 200);
    }

    return json({ error: '接口不存在' }, 404);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}
