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
  subtitle: '点开格子，点亮精彩',
  maxPerDay: 2,
  showStats: true,
  slotMinutes: 60,
  cancelBeforeHour: 21,     // 开课前一天的这个钟点之后，不能自己取消
  maxPerWeek: 6,            // 每人每个自然周最多报几节
  cancelQuota: 2,           // 每人每个自然周最多能取消几次
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
    maxPerDay: intIn(c.maxPerDay, 1, 20, 2),
    showStats: c.showStats !== false,
    slotMinutes: intIn(c.slotMinutes, 15, 300, 60),
    cancelBeforeHour: intIn(c.cancelBeforeHour, 0, 23, 21),
    maxPerWeek: intIn(c.maxPerWeek, 1, 60, 6),
    cancelQuota: intIn(c.cancelQuota, 0, 20, 2),
    days
  };
}

const OLD_SUBTITLES = [
  '点格子报名 · 报名后 3 分钟内可取消',
  '点格子报名 · 开课时扣 1 次'
];

async function getConfig(env) {
  try {
    const row = await env.DB.prepare('SELECT value FROM config WHERE key = ?1').bind('schedule').first();
    if (row && row.value) {
      const cfg = normalizeConfig(JSON.parse(row.value));
      // 老版本存在库里的默认副标题（提到"3 分钟"）自动换成新的，只替换完全一致的那种
      if (OLD_SUBTITLES.indexOf(cfg.subtitle) >= 0) {
        cfg.subtitle = DEFAULTS.subtitle;
        await saveConfig(env, cfg);
      }
      return cfg;
    }
  } catch (e) { /* 表还没建 */ }
  return normalizeConfig(DEFAULTS);
}

async function saveConfig(env, cfg) {
  await env.DB.prepare(
    'INSERT INTO config (key, value) VALUES (?1, ?2) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind('schedule', JSON.stringify(cfg)).run();
}

/* ==================== 次卡：余额 / 流水 ==================== */

function weekStartOf(dateStr) {
  const p = parseYmd(dateStr);
  if (!p) return null;
  const back = (p.dow + 6) % 7;
  return ymd(bjParts(bjEpoch(p.y, p.m, p.d, 0, 0) - back * 86400000));
}

function cancelCutoff(p, cfg) {
  // 开课前一天 cfg.cancelBeforeHour 点（北京时间）
  return bjEpoch(p.y, p.m, p.d, 0, 0) - 86400000 + cfg.cancelBeforeHour * 3600000;
}

async function getCredits(env, nick) {
  try {
    const r = await env.DB.prepare('SELECT credits FROM wallets WHERE nick = ?1').bind(nick).first();
    return r ? r.credits : 0;
  } catch (e) { return 0; }
}

async function dbAdd(env, nick, delta, kind, amount, note) {
  try {
    await env.DB.prepare('INSERT OR IGNORE INTO wallets (nick, credits) VALUES (?1, 0)').bind(nick).run();
  } catch (e) { /* 忽略 */ }
  await env.DB.prepare('UPDATE wallets SET credits = credits + ?1 WHERE nick = ?2').bind(delta, nick).run();
  const after = await getCredits(env, nick);
  try {
    await env.DB.prepare(
      'INSERT INTO wallet_log (nick, delta, kind, amount, note, balance_after, created_at) ' +
      'VALUES (?1,?2,?3,?4,?5,?6,?7)'
    ).bind(nick, delta, kind, amount === undefined ? null : amount, note || '', after, Date.now()).run();
  } catch (e) { /* 忽略 */ }
  return after;
}

async function countSignups(env, nick) {
  try {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM signups WHERE nickname = ?1').bind(nick).first();
    return r ? r.n : 0;
  } catch (e) { return 0; }
}

async function countConsumptions(env, nick) {
  try {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM consumptions WHERE nick = ?1').bind(nick).first();
    return r ? r.n : 0;
  } catch (e) { return 0; }
}

async function weekSignupCount(env, nick, weekStart) {
  const p = parseYmd(weekStart);
  if (!p) return 0;
  const end = ymd(bjParts(bjEpoch(p.y, p.m, p.d, 0, 0) + 6 * 86400000));
  try {
    const r = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM signups WHERE nickname = ?1 AND slot_date >= ?2 AND slot_date <= ?3'
    ).bind(nick, weekStart, end).first();
    return r ? r.n : 0;
  } catch (e) { return 0; }
}

async function weekLimitOf(env, cfg, nick, weekStart) {
  if (!nick) return cfg.maxPerWeek;
  try {
    const r = await env.DB.prepare(
      'SELECT limits FROM week_limits WHERE nick = ?1 AND week_start = ?2'
    ).bind(nick, weekStart).first();
    if (r && r.limits > 0) return r.limits;
  } catch (e) { /* 忽略 */ }
  return cfg.maxPerWeek;
}

async function cancelCount(env, nick, weekStart) {
  if (!nick) return 0;
  try {
    const r = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM cancel_log WHERE nick = ?1 AND week_start = ?2'
    ).bind(nick, weekStart).first();
    return r ? r.n : 0;
  } catch (e) { return 0; }
}

/**
 * 惰性结算：把「已经开课、有报名、还没记账」的课补记成消费。
 * 不需要定时任务——任何人打开页面就会补上；唯一键保证不会重复扣。
 */
async function settle(env, cfg) {
  const now = Date.now();
  const todayStr = ymd(bjParts(now));
  const from = ymd(bjParts(now - 60 * 86400000));

  let rows;
  try {
    rows = await env.DB.prepare(
      'SELECT slot_date, slot_id, nickname FROM signups WHERE slot_date >= ?1 AND slot_date <= ?2'
    ).bind(from, todayStr).all();
  } catch (e) { return; }

  const list = rows.results || [];
  if (!list.length) return;

  for (const r of list) {
    const p = parseYmd(r.slot_date);
    if (!p) continue;

    const arr = slotsOf(cfg, p.dow);
    let slot = null;
    for (const x of arr) if (x.id === r.slot_id) { slot = x; break; }
    if (!slot) continue;

    const cc = resolveCell(p, slot, cfg);
    if (!cc || cc.off) continue;          // 停课的不扣
    if (now < cc.startEpoch) continue;    // 还没开课

    let dup = null;
    try {
      dup = await env.DB.prepare(
        'SELECT 1 AS x FROM consumptions WHERE nick = ?1 AND slot_date = ?2 AND slot_id = ?3'
      ).bind(r.nickname, r.slot_date, r.slot_id).first();
    } catch (e) { return; }
    if (dup) continue;

    try {
      await env.DB.prepare(
        'INSERT INTO consumptions (nick, slot_date, slot_id, created_at, refunded) VALUES (?1,?2,?3,?4,0)'
      ).bind(r.nickname, r.slot_date, r.slot_id, cc.startEpoch).run();
    } catch (e) { continue; }

    await dbAdd(env, r.nickname, -1, 'consume', null,
      '上课扣次 ' + r.slot_date + ' ' + slot.start);
  }
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

/* ==================== 后台操作日志 ==================== */

async function audit(env, action, target, detail) {
  try {
    await env.DB.prepare(
      'INSERT INTO admin_log (action, target, detail, created_at) VALUES (?1,?2,?3,?4)'
    ).bind(String(action || ''), String(target || '').slice(0, 40),
           String(detail || '').slice(0, 120), Date.now()).run();
  } catch (e) { /* 日志写失败不影响主流程 */ }
}

async function adminLogs(env, limit) {
  try {
    const r = await env.DB.prepare(
      'SELECT action, target, detail, created_at FROM admin_log ORDER BY id DESC LIMIT ?1'
    ).bind(limit).all();
    return { logs: r.results || [] };
  } catch (e) { return { logs: [] }; }
}

async function adminExportLogs(env) {
  const out = await adminLogs(env, 2000);
  const rows = [['时间', '动作', '对象', '详情']];
  for (const x of out.logs) {
    const d = new Date(x.created_at + 8 * 3600000);
    const t = d.toISOString().replace('T', ' ').slice(0, 19);
    rows.push([t, x.action, x.target || '', x.detail || '']);
  }
  const csv = rows.map((r) =>
    r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(',')
  ).join('\r\n');
  return { csv: '\uFEFF' + csv, filename: 'admin_log.csv' };
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

async function rosterByNickCI(env, nick) {
  if (!nick) return null;
  try {
    return await env.DB.prepare(
      'SELECT nick, code, disabled FROM roster WHERE nick = ?1 COLLATE NOCASE'
    ).bind(nick).first();
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
  await settle(env, cfg);
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


  let wallet = null;
  if (myName) {
    const credits = await getCredits(env, myName);
    const totalSign = await countSignups(env, myName);
    const consumed = await countConsumptions(env, myName);
    const pending = Math.max(0, totalSign - consumed);
    wallet = { credits, pending, available: credits - pending };
  }

  const wkInfo = [];
  for (let w = 0; w < 2; w++) {
    const ws = weeks[w][0].date;
    wkInfo.push({
      cancelUsed: await cancelCount(env, myName, ws),
      cancelQuota: cfg.cancelQuota,
      signupUsed: await weekSignupCount(env, myName, ws),
      signupLimit: await weekLimitOf(env, cfg, myName, ws)
    });
  }

  const outWeeks = weeks.map((days, wi) => ({
    label: wi === 0 ? '本周' : '下周',
    range: mdText(days[0].p) + '-' + mdText(days[6].p),
    cancelUsed: wkInfo[wi].cancelUsed,
    cancelQuota: wkInfo[wi].cancelQuota,
    signupUsed: wkInfo[wi].signupUsed,
    signupLimit: wkInfo[wi].signupLimit,
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

        // 能不能取消：没开课 + 没过截止 + 本周额度没用完
        const cutoff = cancelCutoff(p, cfg);
        const wkQuotaLeft = cfg.cancelQuota - wkInfo[wi].cancelUsed;
        let canCancel = false;
        let cancelWhy = '';
        if (mineRow) {
          if (now >= cc.startEpoch) cancelWhy = '已经开课了';
          else if (now >= cutoff) cancelWhy = '已过取消截止（' + mdText(bjParts(cc.startEpoch - 86400000)) + ' ' + cfg.cancelBeforeHour + ':00）';
          else if (wkQuotaLeft <= 0) cancelWhy = '这一周取消次数已用完（' + wkInfo[wi].cancelUsed + '/' + cfg.cancelQuota + '）';
          else canCancel = true;
        }

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
          canCancel,
          cancelWhy,
          cancelLeft: Math.max(0, wkQuotaLeft),
          cancelByText: mdText(bjParts(cc.startEpoch - 86400000)) + ' ' + cfg.cancelBeforeHour + ':00',
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
    maxPerDay: cfg.maxPerDay,
    slotMinutes: cfg.slotMinutes,
    cancelBeforeHour: cfg.cancelBeforeHour,
    cancelQuota: cfg.cancelQuota,
    maxPerWeek: cfg.maxPerWeek,
    wallet,
    stats,
    myName,
    rows,
    rowStd: std,
    weeks: outWeeks
  };
}

/* ==================== 会员：我的档案 ==================== */

async function memberProfile(env, cfg, who) {
  const now = Date.now();
  const t = bjParts(now);
  const backToMon = (t.dow + 6) % 7;
  const monday = bjEpoch(t.y, t.m, t.d, 0, 0) - backToMon * 86400000;

  const wStart = ymd(bjParts(monday));
  const wEnd = ymd(bjParts(monday + 6 * 86400000));
  const nStart = ymd(bjParts(monday + 7 * 86400000));
  const nEnd = ymd(bjParts(monday + 13 * 86400000));

  const mStart = t.y + '-' + String(t.m).padStart(2, '0') + '-01';
  const mLast = new Date(Date.UTC(t.y, t.m, 0)).getUTCDate();
  const mEnd = t.y + '-' + String(t.m).padStart(2, '0') + '-' + String(mLast).padStart(2, '0');
  const yStart = t.y + '-01-01';
  const yEnd = t.y + '-12-31';

  const credits = await getCredits(env, who.nick);
  const totalSign = await countSignups(env, who.nick);
  const consumedN = await countConsumptions(env, who.nick);
  const pending = Math.max(0, totalSign - consumedN);

  let rows = [];
  try {
    const r = await env.DB.prepare(
      'SELECT slot_date, slot_id FROM signups WHERE nickname = ?1 ORDER BY slot_date'
    ).bind(who.nick).all();
    rows = r.results || [];
  } catch (e) { /* 忽略 */ }

  let weekN = 0, monthN = 0, yearN = 0;
  const upcoming = [];

  for (const r of rows) {
    const ps = parseYmd(r.slot_date);
    if (!ps) continue;
    let slot = null;
    for (const x of slotsOf(cfg, ps.dow)) if (x.id === r.slot_id) { slot = x; break; }
    if (!slot) continue;
    const cc = resolveCell(ps, slot, cfg);
    if (!cc) continue;

    const d = r.slot_date;
    if (d >= wStart && d <= wEnd) weekN++;
    if (d >= mStart && d <= mEnd) monthN++;
    if (d >= yStart && d <= yEnd) yearN++;

    if (cc.startEpoch > now) {
      upcoming.push({
        date: d, weekday: WEEK_CN[ps.dow], md: mdText(ps),
        start: cc.start, end: cc.end
      });
    }
  }

  const log = [];
  try {
    const l = await env.DB.prepare(
      'SELECT delta, kind, note, balance_after, created_at FROM wallet_log ' +
      'WHERE nick = ?1 ORDER BY id DESC LIMIT 20'
    ).bind(who.nick).all();
    log.push.apply(log, l.results || []);
  } catch (e) { /* 忽略 */ }

  return {
    nick: who.nick,
    wallet: { credits, pending, available: credits - pending },
    stats: cfg.showStats ? { week: weekN, month: monthN, year: yearN } : null,
    weeks: [
      {
        label: '本周',
        range: mdText(bjParts(monday)) + '-' + mdText(bjParts(monday + 6 * 86400000)),
        cancelUsed: await cancelCount(env, who.nick, wStart),
        cancelQuota: cfg.cancelQuota,
        signupUsed: await weekSignupCount(env, who.nick, wStart),
        signupLimit: await weekLimitOf(env, cfg, who.nick, wStart)
      },
      {
        label: '下周',
        range: mdText(bjParts(monday + 7 * 86400000)) + '-' + mdText(bjParts(monday + 13 * 86400000)),
        cancelUsed: await cancelCount(env, who.nick, nStart),
        cancelQuota: cfg.cancelQuota,
        signupUsed: await weekSignupCount(env, who.nick, nStart),
        signupLimit: await weekLimitOf(env, cfg, who.nick, nStart)
      }
    ],
    upcoming: upcoming.slice(0, 6),
    log
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

  const ws = weekStartOf(date);
  const wkLimit = await weekLimitOf(env, cfg, who.nick, ws);
  const wkUsed = await weekSignupCount(env, who.nick, ws);
  if (wkUsed >= wkLimit) {
    return { error: '这一周你已经报了 ' + wkUsed + ' 节，上限 ' + wkLimit + ' 节。要加课请联系群主' };
  }

  const credits = await getCredits(env, who.nick);
  const pending = Math.max(0, (await countSignups(env, who.nick)) - (await countConsumptions(env, who.nick)));
  if (credits - pending < 1) {
    return { error: '余额不够了（可用 ' + Math.max(0, credits - pending) + ' 次），请联系群主充值' };
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

  const p = parseYmd(date);
  if (!p) return { error: '日期不对' };
  const found = findSlot(cfg, p.dow, slotId);
  if (!found) return { error: '没有这个时段' };

  const cc = resolveCell(p, found.slot, cfg);
  if (cc && Date.now() >= cc.startEpoch) return { error: '这个时段已经开始了，不能取消' };

  if (cc && Date.now() >= cancelCutoff(p, cfg)) {
    return { error: '已过取消截止时间（开课前一天 ' + cfg.cancelBeforeHour + ':00），请联系群主' };
  }

  const ws = weekStartOf(date);
  const used = await cancelCount(env, who.nick, ws);
  if (used >= cfg.cancelQuota) {
    return { error: '这一周你已经取消了 ' + used + ' 次，最多 ' + cfg.cancelQuota + ' 次，请联系群主' };
  }

  await env.DB.prepare(
    'DELETE FROM signups WHERE slot_date = ?1 AND slot_id = ?2 AND nickname = ?3'
  ).bind(date, slotId, who.nick).run();

  try {
    await env.DB.prepare(
      'INSERT INTO cancel_log (nick, slot_date, slot_id, week_start, created_at) VALUES (?1,?2,?3,?4,?5)'
    ).bind(who.nick, date, slotId, ws, Date.now()).run();
  } catch (e) { /* 忽略 */ }

  return { ok: true, cancelLeft: cfg.cancelQuota - used - 1 };
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
  await audit(env, '代报名', nick, date + ' ' + cc.start);
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

  // 管理员可以删已开课的报名（会员自己不能，只能找管理员）
  // 已开课的那节如果扣过次，删的时候可选退还
  // 先看这节是不是已经扣过次
  let consumed = null;
  try {
    consumed = await env.DB.prepare(
      'SELECT refunded FROM consumptions WHERE nick = ?1 AND slot_date = ?2 AND slot_id = ?3'
    ).bind(nick, date, slotId).first();
  } catch (e) { /* 忽略 */ }

  const res = await env.DB.prepare(
    'DELETE FROM signups WHERE slot_date = ?1 AND slot_id = ?2 AND nickname = ?3'
  ).bind(date, slotId, nick).run();

  if (!res.meta || !res.meta.changes) return { error: '没找到这条报名记录' };

  let refunded = false;
  if (consumed && !consumed.refunded && body && body.refund) {
    try {
      await env.DB.prepare(
        'UPDATE consumptions SET refunded = 1 WHERE nick = ?1 AND slot_date = ?2 AND slot_id = ?3'
      ).bind(nick, date, slotId).run();
      await dbAdd(env, nick, 1, 'refund', null, '管理员删除已开课的报名，退还 1 次');
      refunded = true;
    } catch (e) { /* 忽略 */ }
  }

  await audit(env, '删报名', nick,
    date + ' ' + (cc ? cc.start : found.slot.start) +
    (refunded ? '（退 1 次）' : (consumed ? '（未退次）' : '')));
  return { ok: true, refunded, hadConsumed: !!consumed };
}

/* ==================== 管理：数据看板 ==================== */

async function adminStats(env, cfg) {
  const now = Date.now();
  const t = bjParts(now);
  const backToMon = (t.dow + 6) % 7;
  const monday = bjEpoch(t.y, t.m, t.d, 0, 0) - backToMon * 86400000;
  const wStart = ymd(bjParts(monday));
  const wEnd = ymd(bjParts(monday + 6 * 86400000));

  const cnt = new Map();
  const peopleSet = new Set();
  try {
    const rs = await env.DB.prepare(
      'SELECT slot_date, slot_id, nickname FROM signups WHERE slot_date >= ?1 AND slot_date <= ?2'
    ).bind(wStart, wEnd).all();
    for (const r of rs.results || []) {
      const k = r.slot_date + '|' + r.slot_id;
      cnt.set(k, (cnt.get(k) || 0) + 1);
      peopleSet.add(r.nickname);
    }
  } catch (e) { /* 忽略 */ }

  let capacity = 0, filled = 0, emptyCells = 0;
  const cold = [];

  for (let i = 0; i < 7; i++) {
    const pd = bjParts(monday + i * 86400000);
    const d = ymd(pd);
    for (const slot of slotsOf(cfg, pd.dow)) {
      const cc = resolveCell(pd, slot, cfg);
      if (!cc || cc.off) continue;
      capacity += cc.cap;
      const n = cnt.get(d + '|' + slot.id) || 0;
      filled += n;
      if (n === 0) emptyCells++;
      if (n <= 1) cold.push({ date: d, weekday: WEEK_CN[pd.dow], start: cc.start, n, cap: cc.cap });
    }
  }

  const mFirstEpoch = bjEpoch(t.y, t.m, 1, 0, 0);
  const mLastDay = new Date(Date.UTC(t.y, t.m, 0)).getUTCDate();
  const mAfterEpoch = bjEpoch(t.y, t.m, mLastDay, 23, 59) + 120000;

  let recharge = 0, consume = 0, refund = 0, adjust = 0;
  try {
    const lg = await env.DB.prepare(
      'SELECT kind, SUM(delta) AS s FROM wallet_log WHERE created_at >= ?1 AND created_at < ?2 GROUP BY kind'
    ).bind(mFirstEpoch, mAfterEpoch).all();
    for (const x of lg.results || []) {
      const v = x.s || 0;
      if (x.kind === 'recharge') recharge += v;
      else if (x.kind === 'consume') consume += -v;
      else if (x.kind === 'refund') refund += -v;
      else adjust += v;
    }
  } catch (e) { /* 忽略 */ }

  let cancels = 0;
  try {
    const c = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM cancel_log WHERE created_at >= ?1 AND created_at < ?2'
    ).bind(mFirstEpoch, mAfterEpoch).first();
    cancels = c ? c.n : 0;
  } catch (e) { /* 忽略 */ }

  let active = [];
  try {
    const ro = await adminRoster(env);
    active = ro.people.filter((x) => !x.disabled);
  } catch (e) { /* 忽略 */ }

  const withCredits = active.filter((x) => x.credits > 0).length;
  const zero = active.filter((x) => x.credits <= 0).length;
  const creditsTotal = active.reduce((n, x) => n + (x.credits || 0), 0);
  const low = active.filter((x) => x.credits <= 2);

  let idle = [];
  try {
    const last = await env.DB.prepare(
      'SELECT nickname, MAX(slot_date) AS d FROM signups GROUP BY nickname'
    ).all();
    const m = new Map();
    for (const x of last.results || []) m.set(x.nickname, x.d);
    const cut = ymd(bjParts(now - 21 * 86400000));
    idle = active.filter((x) => {
      const d = m.get(x.nick);
      return !d || d < cut;
    });
  } catch (e) { /* 忽略 */ }

  return {
    week: {
      label: '本周',
      range: mdText(bjParts(monday)) + '-' + mdText(bjParts(monday + 6 * 86400000)),
      filled, capacity,
      rate: capacity ? Math.round(filled / capacity * 100) : 0,
      people: peopleSet.size,
      emptyCells
    },
    month: {
      label: t.y + ' 年 ' + t.m + ' 月',
      recharge, consume, refund, adjust, cancels,
      people: active.length, withCredits, zero, creditsTotal
    },
    alerts: {
      low: low.slice(0, 8).map((x) => x.nick + ' ' + x.credits + '次'),
      lowCount: low.length,
      idle: idle.slice(0, 8).map((x) => x.nick),
      idleCount: idle.length,
      cold: cold.slice(0, 4)
    }
  };
}

/* ==================== 管理：名单 ==================== */

async function adminRoster(env) {
  let rs;
  try {
    rs = await env.DB.prepare(
      'SELECT nick, code, disabled, created_at, last_seen, phone, memo FROM roster ' +
      'ORDER BY disabled ASC, created_at DESC'
    ).all();
  } catch (e) {
    rs = await env.DB.prepare(
      'SELECT nick, code, disabled, created_at, last_seen FROM roster ' +
      'ORDER BY disabled ASC, created_at DESC'
    ).all();
  }

  const dev = await env.DB.prepare('SELECT code, COUNT(*) AS n FROM roster_devices GROUP BY code').all();
  const devMap = new Map();
  for (const d of dev.results || []) devMap.set(d.code, d.n);

  const cnt = await env.DB.prepare('SELECT nickname, COUNT(*) AS n FROM signups GROUP BY nickname').all();
  const cntMap = new Map();
  for (const c of cnt.results || []) cntMap.set(c.nickname, c.n);

  const credMap = new Map();
  try {
    const w = await env.DB.prepare('SELECT nick, credits FROM wallets').all();
    for (const x of w.results || []) credMap.set(x.nick, x.credits);
  } catch (e) { /* 忽略 */ }

  return {
    people: (rs.results || []).map((r) => ({
      nick: r.nick,
      code: r.code,
      disabled: !!r.disabled,
      devices: devMap.get(r.code) || 0,
      signups: cntMap.get(r.nick) || 0,
      credits: credMap.has(r.nick) ? credMap.get(r.nick) : 0,
      phone: r.phone || '',
      memo: r.memo || '',
      lastSeen: r.last_seen || 0,
      createdAt: r.created_at
    }))
  };
}

async function adminWallet(env, body) {
  const nick = cleanName(body && body.nick);
  const delta = parseInt(body && body.delta, 10);
  if (!nick) return { error: '缺少名字' };
  if (!Number.isFinite(delta) || delta === 0) return { error: '变动次数要填一个非零整数' };
  if (Math.abs(delta) > 9999) return { error: '一次最多变动 9999 次' };

  if (!(await rosterByNick(env, nick))) return { error: '名单里没有「' + nick + '」' };

  const kind = String((body && body.kind) || 'adjust').slice(0, 12);
  let amount = null;
  if (body && body.amount !== undefined && body.amount !== '' && body.amount !== null) {
    const n = parseInt(body.amount, 10);
    if (Number.isFinite(n)) amount = n;
  }
  const note = String((body && body.note) || '').slice(0, 60);

  const after = await dbAdd(env, nick, delta, kind, amount, note);
  const KINDTXT = { recharge: '充值', refund: '退款', adjust: '调整' };
  await audit(env, KINDTXT[kind] || kind, nick,
    (delta > 0 ? '+' : '') + delta + ' 次' + (note ? '｜' + note : '') + '（余 ' + after + '）');
  return { ok: true, credits: after };
}

async function adminCards(env) {
  try {
    const r = await env.DB.prepare(
      'SELECT id, name, credits, price, active FROM cards ORDER BY credits ASC, id ASC'
    ).all();
    return { cards: r.results || [] };
  } catch (e) {
    return { cards: [] };
  }
}

async function adminCardSave(env, body) {
  const name = cleanName(body && body.name).slice(0, 20);
  const credits = parseInt(body && body.credits, 10);
  const priceRaw = parseInt(body && body.price, 10);
  const id = parseInt(body && body.id, 10);

  if (!name) return { error: '请填次卡名字' };
  if (!Number.isFinite(credits) || credits < 1 || credits > 999) return { error: '次数要填 1~999' };
  const price = Number.isFinite(priceRaw) && priceRaw >= 0 ? priceRaw : 0;

  if (Number.isFinite(id) && id > 0) {
    await env.DB.prepare('UPDATE cards SET name = ?1, credits = ?2, price = ?3 WHERE id = ?4')
      .bind(name, credits, price, id).run();
    await audit(env, '改次卡', name, credits + ' 次 / ¥' + price);
    return { ok: true, id };
  }

  await env.DB.prepare(
    'INSERT INTO cards (name, credits, price, active, created_at) VALUES (?1,?2,?3,1,?4)'
  ).bind(name, credits, price, Date.now()).run();

  await audit(env, '建次卡', name, credits + ' 次 / ¥' + price);
  return { ok: true };
}

async function adminCardRemove(env, body) {
  const id = parseInt(body && body.id, 10);
  if (!Number.isFinite(id)) return { error: '缺少 id' };
  await env.DB.prepare('DELETE FROM cards WHERE id = ?1').bind(id).run();
  await audit(env, '删次卡', 'id ' + id, '');
  return { ok: true };
}

async function adminLimit(env, cfg, body) {
  const nick = cleanName(body && body.nick);
  if (!nick) return { error: '缺少名字' };
  if (!(await rosterByNick(env, nick))) return { error: '名单里没有「' + nick + '」' };

  const ws = String((body && body.weekStart) || '');
  if (!parseYmd(ws)) return { error: '周次不对（要 2026-11-16 这种格式）' };

  const limits = parseInt(body && body.limits, 10);
  if (!Number.isFinite(limits)) return { error: '上限要填数字' };

  if (limits <= 0) {
    await env.DB.prepare('DELETE FROM week_limits WHERE nick = ?1 AND week_start = ?2').bind(nick, ws).run();
    return { ok: true, limits: cfg.maxPerWeek, cleared: true };
  }

  const v = Math.min(60, limits);
  await env.DB.prepare(
    'INSERT INTO week_limits (nick, week_start, limits) VALUES (?1,?2,?3) ' +
    'ON CONFLICT(nick, week_start) DO UPDATE SET limits = excluded.limits'
  ).bind(nick, ws, v).run();
  await audit(env, '提额', nick, ws + ' 这周可报 ' + v + ' 节');
  return { ok: true, limits: v };
}

async function adminPerson(env, body) {
  const nick = cleanName(body && body.nick);
  if (!nick) return { error: '缺少名字' };
  if (!(await rosterByNick(env, nick))) return { error: '名单里没有「' + nick + '」' };

  const phone = String((body && body.phone) || '').replace(/[^0-9+\-\s]/g, '').slice(0, 20);
  const memo = String((body && body.memo) || '').slice(0, 60);

  try {
    await env.DB.prepare('UPDATE roster SET phone = ?1, memo = ?2 WHERE nick = ?3')
      .bind(phone, memo, nick).run();
  } catch (e) {
    return { error: '数据库还没加 phone / memo 列，请先执行 schema.sql 里的 ALTER 语句' };
  }
  await audit(env, '资料', nick, (phone ? '手机 ' + phone : '') + (memo ? ' 备注 ' + memo : ''));
  return { ok: true };
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
    const exist = await rosterByNickCI(env, nick);
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

  await audit(env, '加会员', added.join('、').slice(0, 40), '新增 ' + added.length + ' 人');
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
  await audit(env, '换入场码', nick, '旧码 ' + r.code + ' → 新码 ' + code);
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
  await audit(env, '移出会员', nick, body && body.clearSignups ? '并删除报名 ' + removed + ' 条' : '保留报名');
  return { ok: true, removedSignups: removed };
}

async function adminRosterRestore(env, body) {
  const nick = cleanName(body && body.nick);
  if (!nick) return { error: '缺少名字' };
  const r = await rosterByNick(env, nick);
  if (!r) return { error: '名单里没有这个人' };
  await env.DB.prepare('UPDATE roster SET disabled = 0 WHERE nick = ?1').bind(nick).run();
  await audit(env, '恢复会员', nick, '');
  return { ok: true };
}

async function adminRename(env, body) {
  const nick = cleanName(body && body.nick);
  const newNick = cleanName(body && body.newNick);
  if (!nick || !newNick) return { error: '名字不能为空' };
  if (nick === newNick) return { ok: true };

  const r = await rosterByNick(env, nick);
  if (!r) return { error: '名单里没有这个人' };
  const clash = await rosterByNickCI(env, newNick);
  if (clash && clash.nick !== nick) {
    return { error: '「' + clash.nick + '」已经在名单里了（英文不区分大小写）' };
  }

  await env.DB.prepare('UPDATE roster SET nick = ?1 WHERE nick = ?2').bind(newNick, nick).run();
  await env.DB.prepare('UPDATE signups SET nickname = ?1 WHERE nickname = ?2').bind(newNick, nick).run();
  await audit(env, '改名', nick + ' → ' + newNick, '报名记录同步');
  return { ok: true };
}

/* ==================== 管理：导出会员表 ==================== */

function bjDateStr(ts) {
  const p = bjParts(ts);
  return p.y + '-' + String(p.m).padStart(2, '0') + '-' + String(p.d).padStart(2, '0');
}

async function adminExportMembers(env) {
  let rs;
  try {
    rs = await env.DB.prepare(
      'SELECT nick, code, disabled, created_at, phone, memo FROM roster ' +
      'ORDER BY disabled ASC, created_at DESC'
    ).all();
  } catch (e) {
    rs = await env.DB.prepare(
      'SELECT nick, code, disabled, created_at FROM roster ' +
      'ORDER BY disabled ASC, created_at DESC'
    ).all();
  }

  const credMap = new Map();
  try {
    const w = await env.DB.prepare('SELECT nick, credits FROM wallets').all();
    for (const x of w.results || []) credMap.set(x.nick, x.credits);
  } catch (e) { /* 忽略 */ }

  const sumMap = new Map();
  try {
    const lg = await env.DB.prepare(
      'SELECT nick, kind, SUM(delta) AS s FROM wallet_log GROUP BY nick, kind'
    ).all();
    for (const x of lg.results || []) {
      let o = sumMap.get(x.nick);
      if (!o) { o = { recharge: 0, consume: 0, refund: 0, adjust: 0 }; sumMap.set(x.nick, o); }
      const v = x.s || 0;
      if (x.kind === 'recharge') o.recharge += v;
      else if (x.kind === 'consume') o.consume += -v;
      else if (x.kind === 'refund') o.refund += -v;
      else o.adjust += v;
    }
  } catch (e) { /* 忽略 */ }

  const signMap = new Map();
  try {
    const sg = await env.DB.prepare(
      'SELECT nickname, COUNT(*) AS n, MAX(slot_date) AS d FROM signups GROUP BY nickname'
    ).all();
    for (const x of sg.results || []) signMap.set(x.nickname, { n: x.n, last: x.d });
  } catch (e) { /* 忽略 */ }

  const consMap = new Map();
  try {
    const c = await env.DB.prepare('SELECT nick, COUNT(*) AS n FROM consumptions GROUP BY nick').all();
    for (const x of c.results || []) consMap.set(x.nick, x.n);
  } catch (e) { /* 忽略 */ }

  const canMap = new Map();
  try {
    const c = await env.DB.prepare('SELECT nick, COUNT(*) AS n FROM cancel_log GROUP BY nick').all();
    for (const x of c.results || []) canMap.set(x.nick, x.n);
  } catch (e) { /* 忽略 */ }

  const rows = [[
    '姓名', '手机号', '备注', '状态', '剩余次数', '待扣次数', '可用次数',
    '累计充值', '累计消耗', '累计退款调整', '累计报名', '最近报名',
    '累计取消', '加入日期', '入场码'
  ]];

  for (const r of rs.results || []) {
    const credits = credMap.get(r.nick) || 0;
    const sg = signMap.get(r.nick) || {};
    const total = sg.n || 0;
    const consumed = consMap.get(r.nick) || 0;
    const pending = Math.max(0, total - consumed);
    const sm = sumMap.get(r.nick) || { recharge: 0, consume: 0, refund: 0, adjust: 0 };

    rows.push([
      r.nick,
      r.phone || '',
      r.memo || '',
      r.disabled ? '已移出' : '正常',
      String(credits),
      String(pending),
      String(credits - pending),
      String(sm.recharge),
      String(sm.consume),
      String(sm.refund + sm.adjust),
      String(total),
      sg.last || '',
      String(canMap.get(r.nick) || 0),
      bjDateStr(r.created_at),
      r.code
    ]);
  }

  const csv = rows.map((row) =>
    row.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(',')
  ).join('\r\n');

  return { csv: '\uFEFF' + csv, filename: '会员表_' + bjDateStr(Date.now()) + '.csv' };
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
        await audit(env, '课表设置', 'schedule', '标题/时长/每天时段/名额');
        return json({ ok: true, config: next });
      }
      if (path === 'admin/board') return json(await loadBoard(env, cfg, null, ''));
      if (path === 'admin/cell') {
        return json(await adminCell(env, cfg, url.searchParams.get('date') || '', url.searchParams.get('slotId') || ''));
      }
      if (path === 'admin/roster') return json(await adminRoster(env));
      if (path === 'admin/cards') return json(await adminCards(env));
      if (path === 'admin/stats') return json(await adminStats(env, cfg));
      if (path === 'admin/logs') return json(await adminLogs(env, 200));

      if (path === 'admin/export-logs') {
        const out = await adminExportLogs(env);
        return new Response(out.csv, {
          status: 200,
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="' + out.filename + '"',
            'cache-control': 'no-store'
          }
        });
      }

      if (path === 'admin/export-members') {
        const out = await adminExportMembers(env);
        // HTTP 头只能放 ASCII，中文文件名要用 filename* 的百分号编码
        const ascii = out.filename.replace(/[^\x20-\x7e]/g, '') || 'members.csv';
        return new Response(out.csv, {
          status: 200,
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="' + ascii + '"; ' +
              "filename*=UTF-8''" + encodeURIComponent(out.filename),
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
        else if (path === 'admin/wallet') out = await adminWallet(env, body);
        else if (path === 'admin/limit') out = await adminLimit(env, cfg, body);
        else if (path === 'admin/person') out = await adminPerson(env, body);
        else if (path === 'admin/cards/save') out = await adminCardSave(env, body);
        else if (path === 'admin/cards/remove') out = await adminCardRemove(env, body);
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

    if (path === 'mine') {
      if (!who) return json({ error: '需要入场码', needCode: true }, 401);
      await settle(env, cfg);
      return json(await memberProfile(env, cfg, who));
    }

    if (path === 'board') {
      if (!who) return json({ error: '需要入场码', needCode: true }, 401);
      await touchDevice(env, who.code, url.searchParams.get('client') || '');
      return json(await loadBoard(env, cfg, who, url.searchParams.get('client') || ''));
    }

    if (path === 'signup' || path === 'cancel') {
      if (request.method !== 'POST') return json({ error: '请用 POST' }, 405);
      if (!who) return json({ error: '需要入场码', needCode: true }, 401);
      await settle(env, cfg);
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
