/* 报名工具 · 会员页 */

const API = '/api';

const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 忽略 */ } }
};

const state = {
  data: null,
  clientId: store.get('bm_client_id'),
  nickname: store.get('bm_nickname'),
  renamesLeft: 1,
  renamesMax: 1,
  timer: null
};

if (!state.clientId) {
  state.clientId = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  store.set('bm_client_id', state.clientId);
}

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
  if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

/* ---------------- 渲染 ---------------- */

function render() {
  const d = state.data;
  if (!d) return;

  $('#title').textContent = d.title || 'Hihi Studio';
  $('#sub').textContent = d.subtitle || '';

  // 本周 / 本月各报了几次
  // 后台关掉统计时 stats 为 null，整块不显示
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
  $('#me').textContent = state.nickname ? ('我是 ' + state.nickname) : '还没设置昵称';

  const rn = $('#rename');
  if (rn) {
    if (state.renamesLeft > 0) {
      rn.textContent = '改昵称 · 剩 ' + state.renamesLeft + ' 次';
      rn.style.opacity = '';
    } else {
      rn.textContent = '改名次数已用完';
      rn.style.opacity = '.55';
    }
  }

  // 改昵称旁边的提示
  const hint = $('#renameHint');
  if (hint) {
    if (state.renamesLeft > 0) {
      hint.textContent = state.nickname
        ? ('昵称建好后只能改 ' + state.renamesMax + ' 次，想清楚再定')
        : ('先起个名字，之后只能改 ' + state.renamesMax + ' 次');
      hint.dataset.warn = '';
    } else {
      hint.textContent = '改名次数已用完，要改请找群主';
      hint.dataset.warn = '1';
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
      note = '<div class="dlg-note mute">报名已超过 ' + (state.data.cancelMin || 3) + ' 分钟，不能取消了。</div>';
      btns = '<button class="btn" data-act="close">知道了</button>';
    }
  } else if (!cell.open) {
    note = '<div class="dlg-note mute">这个时段已经开课，报名已截止。</div>';
    btns = '<button class="btn" data-act="close">知道了</button>';
  } else if (cell.full) {
    note = '<div class="dlg-note">名额已满。</div>';
    btns = '<button class="btn" data-act="close">知道了</button>';
  } else {
    note = '<div class="dlg-note mute">报名后 ' + (state.data.cancelMin || 3) + ' 分钟内可以取消，超过就退不掉了。</div>';
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

async function changeName() {
  if (state.renamesLeft <= 0) {
    alert('改名次数已用完（只能改 ' + state.renamesMax + ' 次）。\n要改的话找群主，让他在后台帮你改。');
    return null;
  }

  const v = prompt(
    '你叫什么？（群里能认出来的名字，12 字以内）\n\n' +
    '还有 ' + state.renamesLeft + ' 次改名机会。\n' +
    '改名后，你之前报的名会一起改成新名字，不会丢。',
    state.nickname || ''
  );
  if (v == null) return null;

  const n = v.trim().slice(0, 12);
  if (!n) return null;
  if (n === state.nickname) return state.nickname;

  try {
    const r = await api('/myname', { clientId: state.clientId, nickname: n });
    state.nickname = r.nick;
    if (typeof r.renamesLeft === 'number') state.renamesLeft = r.renamesLeft;
    store.set('bm_nickname', r.nick);
    return r.nick;
  } catch (e) {
    alert(e.message);
    return null;
  }
}

async function doSignup(day, cell) {
  let nick = state.nickname;
  if (!nick) {
    nick = await changeName();
    if (!nick) return;
  }
  try {
    await api('/signup', {
      date: day.date,
      slotId: cell.periodId,
      clientId: state.clientId,
      nickname: nick
    });
    closeDialog();
    await load();
  } catch (e) {
    alert('报名失败：' + e.message);
  }
}

async function doCancel(day, cell) {
  try {
    await api('/cancel', {
      date: day.date,
      slotId: cell.periodId,
      clientId: state.clientId,
      nickname: state.nickname
    });
    closeDialog();
    await load();
  } catch (e) {
    alert('取消失败：' + e.message);
  }
}

/* ---------------- 启动 ---------------- */

async function load() {
  try {
    const d = await api('/board?client=' + encodeURIComponent(state.clientId) +
      '&nick=' + encodeURIComponent(state.nickname || ''));

    // 管理员在后台改过名字：自动跟过来，不用本人操作
    if (d.myName && d.myName !== state.nickname && d.myName !== '') {
      state.nickname = d.myName;
      store.set('bm_nickname', d.myName);
      if (typeof d.renamesLeft === 'number') state.renamesLeft = d.renamesLeft;
      return load();
    }

    if (typeof d.renamesLeft === 'number') state.renamesLeft = d.renamesLeft;
    if (typeof d.renamesMax === 'number') state.renamesMax = d.renamesMax;
    state.data = d;
    render();
  } catch (e) {
    $('#board').innerHTML = '<div class="err">加载失败：' + esc(e.message) + '</div>';
  }
}

$('#mask').addEventListener('click', (e) => {
  if (e.target === $('#mask')) closeDialog();
});

$('#rename').addEventListener('click', async (e) => {
  e.preventDefault();
  const n = await changeName();
  if (n) await load();
});

load();
setInterval(load, 20000);

/* ---------------- 加到桌面 / 回到前台自动刷新 ---------------- */

// 从桌面图标点开、或从后台切回来时，重新拉一次，保证看到的是最新
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') load();
});

// 注册 Service Worker：安卓 Chrome 需要它才会出现「安装到桌面」的提示。
// 这个 SW 不缓存任何东西，所以不会出现「数据是旧的」。
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// 在微信里打开时不支持加到桌面，提示用户换浏览器
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
