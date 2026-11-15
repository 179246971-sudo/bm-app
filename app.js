/* 报名工具 · 会员页（白名单入场版） */

const API = '/api';

const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 忽略 */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* 忽略 */ } }
};

const state = {
  code: '',
  data: null,
  clientId: store.get('bm_client_id'),
  timer: null
};

if (!state.clientId) {
  state.clientId = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  store.set('bm_client_id', state.clientId);
}

/* 链接里带 ?k=码 时，直接进场并从地址栏抹掉 */
(function readCodeFromUrl() {
  const q = new URLSearchParams(location.search);
  const raw = (q.get('k') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw) {
    store.set('bm_code', raw);
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* 忽略 */ }
  }
  state.code = raw || store.get('bm_code');
})();

const $ = (s) => document.querySelector(s);
const esc = Grid.esc;

function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

async function api(path, body) {
  const opt = body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  const r = await fetch(API + path, opt);
  let j = {};
  try { j = await r.json(); } catch (e) { /* ignore */ }
  if (!r.ok || j.error) {
    const err = new Error(j.error || ('HTTP ' + r.status));
    err.needCode = !!j.needCode;
    err.status = r.status;
    throw err;
  }
  return j;
}

function withCode(path, sep) {
  return path + (sep || '?') + 'k=' + encodeURIComponent(state.code) +
         '&client=' + encodeURIComponent(state.clientId);
}

/* ---------------- 入场页 ---------------- */

function showEntry(msg) {
  $('#appView').hidden = true;
  $('#entry').hidden = false;
  $('#entryErr').textContent = msg || '';
  state.data = null;
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  setTimeout(() => { try { $('#codeInput').focus(); } catch (e) { /* 忽略 */ } }, 200);
}

function showApp() {
  $('#entry').hidden = true;
  $('#appView').hidden = false;
}

async function tryCode() {
  const raw = ($('#codeInput').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length < 4) {
    $('#entryErr').textContent = '入场码是 6 位字母数字';
    return;
  }

  $('#codeBtn').disabled = true;
  $('#codeBtn').textContent = '正在进入…';
  $('#entryErr').textContent = '';

  const back = state.code;
  state.code = raw;

  try {
    const d = await api('/board?k=' + encodeURIComponent(raw) +
                        '&client=' + encodeURIComponent(state.clientId));
    store.set('bm_code', raw);
    showApp();
    state.data = d;
    render();
    startPolling();
  } catch (e) {
    state.code = back;
    $('#entryErr').textContent = e.needCode ? e.message : ('进不去：' + e.message);
  } finally {
    $('#codeBtn').disabled = false;
    $('#codeBtn').textContent = '进 入';
  }
}

/* ---------------- 渲染 ---------------- */

function render() {
  const d = state.data;
  if (!d) return;

  showApp();
  $('#title').textContent = d.title || 'Hihi Studio';
  $('#sub').textContent = d.subtitle || '';
  $('#me').textContent = d.myName ? ('我是 ' + d.myName) : '';

  const statsBox = $('#stats');
  if (statsBox) {
    if (d.stats) {
      $('#statWeek').textContent = d.stats.week || 0;
      $('#statMonth').textContent = d.stats.month || 0;
      const yEl = $('#statYear');
      if (yEl) yEl.textContent = d.stats.year || 0;
      statsBox.hidden = false;
    } else {
      statsBox.hidden = true;
    }
  }

  const board = $('#board');
  Grid.renderGrid(board, d, { onCell: openDialog });
  board.appendChild(Grid.buildLegend());
}

/* ---------------- 弹窗 ---------------- */

function closeDialog() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  $('#mask').hidden = true;
  $('#dialog').innerHTML = '';
}

function openDialog(day, cell) {
  closeDialog();

  const d = state.data;
  const dlg = $('#dialog');
  const names = (cell.names || []).map(esc).join('、');
  const where = day.weekday + ' ' + day.md + ' · ' + cell.time;

  let head =
    '<div class="dlg-h">' + esc(where) + '</div>' +
    '<div class="dlg-meta">' +
      (cell.off ? '这个时段不开课' : ('已报 ' + cell.count + '/' + cell.cap + ' 人')) +
    '</div>' +
    (cell.off ? '' : '<div class="dlg-people">' + (names || '<i>还没有人报名</i>') + '</div>');

  let note = '';
  let btns = '';
  const maxDay = d ? d.maxPerDay : 2;
  const usedToday = day.myCountToday || 0;

  if (day.past) {
    note = '<div class="dlg-note mute">这一天已经过去，只能查看。</div>';
    btns = '<button class="btn" data-act="close">知道了</button>';
  } else if (cell.off) {
    note = '<div class="dlg-note mute">这一天这个时段不开课。</div>';
    btns = '<button class="btn" data-act="close">知道了</button>';
  } else if (cell.mine) {
    if (cell.canCancel) {
      note = '<div class="dlg-note" id="cd">取消窗口剩余 ' + mmss(cell.cancelLeft) + '</div>';
      btns = '<button class="btn" data-act="close">再想想</button>' +
        '<button class="btn danger" data-act="cancel">确认取消</button>';
    } else {
      note = '<div class="dlg-note mute">报名已超过 ' + d.cancelMin + ' 分钟，不能取消了。</div>';
      btns = '<button class="btn" data-act="close">知道了</button>';
    }
  } else if (!cell.open) {
    note = '<div class="dlg-note mute">这个时段已经开课，报名已截止。</div>';
    btns = '<button class="btn" data-act="close">知道了</button>';
  } else if (cell.full) {
    note = '<div class="dlg-note">名额已满。</div>';
    btns = '<button class="btn" data-act="close">知道了</button>';
  } else if (usedToday >= maxDay) {
    note = '<div class="dlg-note">这一天你已经报了 ' + usedToday + ' 节，最多 ' + maxDay +
           ' 节。<br>还想加课请找群主。</div>';
    btns = '<button class="btn" data-act="close">知道了</button>';
  } else {
    note = '<div class="dlg-note mute">报名后 ' + d.cancelMin + ' 分钟内可以取消。<br>' +
           '这一天你还能报 ' + (maxDay - usedToday) + ' 节。</div>';
    btns = '<button class="btn" data-act="close">否</button>' +
      '<button class="btn primary" data-act="signup">确认报名</button>';
  }

  dlg.innerHTML = head + note + '<div class="dlg-btns">' + btns + '</div>';

  dlg.querySelectorAll('[data-act]').forEach((b) => {
    b.addEventListener('click', () => {
      const act = b.dataset.act;
      if (act === 'close') closeDialog();
      if (act === 'signup') doSignup(day, cell);
      if (act === 'cancel') doCancel(day, cell);
    });
  });

  if (cell.mine && cell.canCancel) {
    const t0 = Date.now();
    const base = cell.cancelLeft;
    state.timer = setInterval(() => {
      const left = base - (Date.now() - t0);
      const cd = document.getElementById('cd');
      if (!cd) return;
      if (left <= 0) {
        clearInterval(state.timer);
        state.timer = null;
        cd.textContent = '取消窗口已关闭，不能取消了。';
        cd.className = 'dlg-note mute';
        const btn = document.querySelector('[data-act="cancel"]');
        if (btn) btn.disabled = true;
      } else {
        cd.textContent = '取消窗口剩余 ' + mmss(left);
      }
    }, 500);
  }

  $('#mask').hidden = false;
}

/* ---------------- 报名 / 取消 ---------------- */

async function doSignup(day, cell) {
  try {
    await api('/signup?k=' + encodeURIComponent(state.code), {
      date: day.date,
      slotId: cell.periodId
    });
    closeDialog();
    await load();
  } catch (e) {
    if (e.needCode) { showEntry('入场码失效了，请重新输入'); return; }
    alert('报名失败：' + e.message);
  }
}

async function doCancel(day, cell) {
  try {
    await api('/cancel?k=' + encodeURIComponent(state.code), {
      date: day.date,
      slotId: cell.periodId
    });
    closeDialog();
    await load();
  } catch (e) {
    if (e.needCode) { showEntry('入场码失效了，请重新输入'); return; }
    alert('取消失败：' + e.message);
  }
}

/* ---------------- 加载 / 轮询 ---------------- */

async function load() {
  if (!state.code) { showEntry(); return; }
  try {
    const d = await api('/board?k=' + encodeURIComponent(state.code) +
                        '&client=' + encodeURIComponent(state.clientId));
    state.data = d;
    render();
  } catch (e) {
    if (e.needCode) {
      store.del('bm_code');
      state.code = '';
      showEntry(e.message);
      return;
    }
    const b = $('#board');
    if (b) b.innerHTML = '<div class="err">加载失败：' + esc(e.message) + '</div>';
  }
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (document.visibilityState === 'visible') load();
  }, 20000);
}

/* ---------------- 启动 ---------------- */

$('#codeBtn').addEventListener('click', tryCode);
$('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryCode(); });
$('#codeInput').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

$('#mask').addEventListener('click', (e) => {
  if (e.target === $('#mask')) closeDialog();
});

// 从桌面图标点开、或从后台切回来时刷新
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.code) load();
});

// 注册 Service Worker（安卓安装提示需要；不缓存任何东西）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// 微信里提示换浏览器（才能加桌面）
(function wechatTip() {
  const bar = document.getElementById('tipbar');
  if (!bar) return;
  const inWeChat = /MicroMessenger/i.test(navigator.userAgent);
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
                     window.navigator.standalone === true;
  if (inWeChat && !standalone && !store.get('bm_tip_closed')) bar.hidden = false;
  const btn = document.getElementById('tipclose');
  if (btn) {
    btn.addEventListener('click', () => {
      bar.hidden = true;
      store.set('bm_tip_closed', '1');
    });
  }
})();

if (state.code) load(); else showEntry();
