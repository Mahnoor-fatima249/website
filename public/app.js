/* ============ helpers ============ */
const $ = id => document.getElementById(id);

function esc(s) {
  return String(s == null ? '' : s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  $('toastWrap').appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

function fmtDate(d) {
  if (!d) return '-';
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString();
}

function markSync() {
  $('lastSync').textContent = 'Updated ' + new Date().toLocaleTimeString();
}

/* ============ THEME (dark/light) ============ */
const THEME_KEY = 'lm-theme';

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(t, rerenderChartsToo) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch {}
  const btn = $('themeBtn');
  if (btn) btn.textContent = t === 'dark' ? '☀️' : '🌙';
  if (rerenderChartsToo) rerenderCharts();
}
applyTheme(currentTheme(), false);
$('themeBtn').onclick = () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);

/* ============ CHARTS (Chart.js) ============ */
const charts = {};

function chartPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  return {
    muted: v('--muted'), grid: v('--chart-grid'), card: v('--card'),
    brand: '#06b6d4', blue: '#3b82f6', violet: '#8b5cf6',
    ok: '#10b981', warn: '#f59e0b', danger: '#f43f5e', slate: '#64748b'
  };
}

function mountChart(id, cfg) {
  if (typeof Chart === 'undefined') return;
  const el = $(id);
  if (!el || el.closest('.hidden')) return;
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  const p = chartPalette();
  Chart.defaults.color = p.muted;
  Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";
  cfg.options = Object.assign({ responsive: true, maintainAspectRatio: false }, cfg.options);
  charts[id] = new Chart(el.getContext('2d'), cfg);
}

function rerenderCharts() {
  renderDailyChart();
  renderStatusChart();
  renderReportChart();
}

/* ============ state ============ */
const state = {
  user: null,
  view: 'overview',
  leads: [], page: 1, pageSize: 50,
  tracker: [], trackMineOnly: true,
  editingTrackId: null, confirmAction: null,
  chartData: { daily: null, status: null, report: null }
};

/* ============ auth view ============ */
async function refreshSlots() {
  try {
    const st = await api('/api/auth/status');
    const el = $('slotsInfo');
    if (st.full) {
      el.textContent = `All ${st.max} seats are taken (${st.registered}/${st.max}). New accounts are not allowed.`;
      ['regUser', 'regPass', 'regPass2'].forEach(id => $(id).disabled = true);
      $('registerForm').querySelector('button[type=submit]').disabled = true;
    } else {
      el.textContent = `${st.slotsLeft} seat${st.slotsLeft > 1 ? 's' : ''} left — ${st.registered} of ${st.max} in use`;
    }
  } catch {}
}

$('tabLogin').onclick = () => switchTab('login');
$('tabRegister').onclick = () => { switchTab('register'); refreshSlots(); };

function switchTab(which) {
  $('tabLogin').classList.toggle('active', which === 'login');
  $('tabRegister').classList.toggle('active', which === 'register');
  $('loginForm').classList.toggle('hidden', which !== 'login');
  $('registerForm').classList.toggle('hidden', which !== 'register');
}

$('loginForm').onsubmit = async e => {
  e.preventDefault();
  $('loginMsg').textContent = '';
  try {
    const r = await api('/api/login', { method: 'POST', body: { username: $('loginUser').value, password: $('loginPass').value } });
    enterApp(r.user);
  } catch (err) {
    $('loginMsg').textContent = err.message;
  }
};

$('registerForm').onsubmit = async e => {
  e.preventDefault();
  $('registerMsg').textContent = '';
  if ($('regPass').value !== $('regPass2').value) {
    $('registerMsg').textContent = 'Passwords do not match';
    return;
  }
  try {
    const r = await api('/api/register', { method: 'POST', body: { username: $('regUser').value, password: $('regPass').value } });
    toast('Account created! Welcome, ' + r.user.username, 'ok');
    enterApp(r.user);
  } catch (err) {
    $('registerMsg').textContent = err.message;
    refreshSlots();
  }
};

$('logoutBtn').onclick = async () => {
  await api('/api/logout', { method: 'POST' });
  location.reload();
};

async function boot() {
  try {
    const r = await api('/api/me');
    if (r.user) enterApp(r.user);
  } catch {}
  refreshSlots();
}

function enterApp(user) {
  state.user = user;
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('userName').textContent = user.name;

  loadStats();
  loadLeads();
  loadTracker();

  api('/api/meta').then(m => {
    if (m.mode !== 'google') {
      const b = $('modeBanner');
      b.classList.remove('hidden');
      const reason = m.reason ? `<br><b>Wajah:</b> ${esc(m.reason)}` : '';
      b.innerHTML = '<b>Google Sheet is not connected yet.</b> Vercel par Environment Variables check karein (SHEET_ID, GOOGLE_CREDENTIALS_B64) aur Redeploy karein.' + reason;
    }
  }).catch(() => {});

  startLiveSync();
}

/* ============ LIVE SYNC ============ */
let liveTimer = null;
/* 60 sec: Vercel free tier par Google Sheets ki read quota (60/min) safe rehti hai */
const LIVE_INTERVAL_MS = 60000;

function startLiveSync() {
  markSync();
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = setInterval(() => { if (!document.hidden) refreshView(true); }, LIVE_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshView(true); });
}

function refreshView(silent) {
  if (state.view === 'overview') loadStats(silent);
  else if (state.view === 'leads') loadLeads(silent);
  else if (state.view === 'linkedin') loadTracker(silent);
  else if (state.view === 'report') loadReport(silent);
}

/* ============ navigation ============ */
const VIEWS = {
  overview: { nav: 'navOverview', sec: 'overviewView' },
  leads: { nav: 'navLeads', sec: 'leadsView' },
  linkedin: { nav: 'navLinkedin', sec: 'linkedinView' },
  report: { nav: 'navReport', sec: 'reportView' }
};

Object.entries(VIEWS).forEach(([name, v]) => {
  $(v.nav).onclick = () => switchView(name);
});

function switchView(v) {
  state.view = v;
  Object.values(VIEWS).forEach(x => {
    $(x.nav).classList.remove('active');
    $(x.sec).classList.add('hidden');
  });
  $(VIEWS[v].nav).classList.add('active');
  $(VIEWS[v].sec).classList.remove('hidden');
  if (v === 'overview') loadStats();
  if (v === 'report') loadReport();
}

/* ============ OVERVIEW / STATS ============ */
async function loadStats(silent) {
  try {
    const s = await api('/api/stats');
    state.lastStats = s;
    markSync();

    const drEl = $('dateRange');
    if (s.dateRange && s.dateRange.label) {
      drEl.classList.remove('hidden');
      drEl.innerHTML = `<span class="cal">📅</span> Scraped dates: <b>${esc(s.dateRange.label)}</b>`;
    } else {
      drEl.classList.add('hidden');
    }

    let cards = `
      <div class="stat-card brand"><div class="stat-num">${s.total.toLocaleString()}</div><div class="stat-label">Total Leads</div></div>
      <div class="stat-card ok"><div class="stat-num">${(s.sentFromSheet || 0).toLocaleString()}</div><div class="stat-label">✅ Sent (from sheet)</div></div>
      <div class="stat-card warn"><div class="stat-num">${(s.notSent != null ? s.notSent : 0).toLocaleString()}</div><div class="stat-label">❌ Not sent</div></div>
      <div class="stat-card ok"><div class="stat-num">${s.uniqueEmails.toLocaleString()}</div><div class="stat-label">Unique Emails</div></div>
      <div class="stat-card warn"><div class="stat-num">${s.duplicateRows.toLocaleString()}</div><div class="stat-label">Duplicate Rows (${s.duplicatePercent}%)</div></div>
      <div class="stat-card"><div class="stat-num">${s.dupGroupCount.toLocaleString()}</div><div class="stat-label">Duplicated Email Types</div></div>
      <div class="stat-card"><div class="stat-num">${s.missingEmail.toLocaleString()}</div><div class="stat-label">Missing Email</div></div>`;
    (s.shiftCounts || []).forEach(sc => {
      const low = sc.name.toLowerCase();
      const cls = low === 'day' ? 'ok' : low === 'night' ? 'violet' : 'brand';
      const lbl = (low === 'day' || low === 'night') ? sc.name + ' Time Leads' : sc.name + ' Leads';
      cards += `<div class="stat-card ${cls}"><div class="stat-num">${sc.count.toLocaleString()}</div><div class="stat-label">${esc(lbl)}</div><div class="stat-sub">✅ ${sc.sent || 0} sent</div></div>`;
    });
    $('overviewStats').innerHTML = cards;

    const chipHtml = arr => arr.length
      ? arr.map(x => `<span class="chip">${esc(x.name)} <b>${x.count}</b></span>`).join('')
      : '<span class="cell-muted">No data</span>';
    $('shiftChips').innerHTML = chipHtml(s.shiftCounts || []);
    $('categoryChips').innerHTML = chipHtml(s.topCategories);

    state.chartData.status = s.statusCounts || [];
    $('statusChartEmpty').classList.add('hidden');
    renderStatusChart();
    loadDailyChart();

    if (s.dupGroups.length) {
      $('dupEmpty').classList.add('hidden');
      $('dupBody').innerHTML = s.dupGroups.map(g => `
        <tr>
          <td><b>${esc(g.email)}</b></td>
          <td><span class="badge warnb">${g.count}x</span></td>
          <td class="cell-muted" style="max-width:340px">${esc(g.names.join(', '))}${g.names.length >= 4 ? ' ...' : ''}</td>
          <td class="cell-muted">rows ${g.rows.slice(0, 6).join(', ')}${g.rows.length > 6 ? '+' : ''}</td>
        </tr>`).join('');
    } else {
      $('dupBody').innerHTML = '';
      $('dupEmpty').classList.remove('hidden');
    }
  } catch (err) {
    if (!silent) toast(err.message, 'err');
  }
}
$('statsRefresh').onclick = () => { loadStats(); loadLeads(); };

/* ---------- SHIFT FILTER (dynamic — har tab ka apna option) ---------- */
function buildShiftFilter() {
  const sel = $('shiftFilter');
  const cur = sel.value;
  const names = [...new Set(state.leads.map(l => l.Shift || 'Other'))];
  sel.innerHTML = '<option value="">Shift: All</option>' + names.map(n => {
    const low = String(n).toLowerCase();
    const lbl = (low === 'day' || low === 'night') ? n + ' Time' : n;
    return `<option value="${esc(n)}">${esc(lbl)}</option>`;
  }).join('');
  sel.value = names.includes(cur) ? cur : '';
}

/* ---------- DATE RANGE CALENDAR ---------- */
const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function loadRange(from, to) {
  try {
    const r = await api(`/api/range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    $('rangeResult').innerHTML = `
      <div class="stats-grid" style="margin-top:12px">
        <div class="stat-card brand"><div class="stat-num">${r.total.toLocaleString()}</div><div class="stat-label">Leads (${esc(from)} → ${esc(to)})</div></div>
        <div class="stat-card ok"><div class="stat-num">${r.sent.toLocaleString()}</div><div class="stat-label">✅ Sent</div></div>
        <div class="stat-card warn"><div class="stat-num">${r.notSent.toLocaleString()}</div><div class="stat-label">❌ Not sent</div></div>
      </div>
      ${(r.shifts || []).length ? '<div class="chips" style="margin:10px 0">' + r.shifts.map(x => `<span class="chip">${esc(x.name)}: <b>${x.count}</b> • ✅ ${x.sent} sent</span>`).join('') + '</div>' : ''}
      ${(r.days || []).length ? `
      <table class="leads-table dup-table" style="margin-top:10px">
        <thead><tr><th>Din (Date)</th><th>Leads</th><th>Sent</th></tr></thead>
        <tbody>${r.days.map(d => `<tr><td>${esc(d.date)}</td><td><b>${d.total}</b></td><td>✅ ${d.sent}</td></tr>`).join('')}</tbody>
      </table>` : '<p class="cell-muted" style="margin-top:10px">Is range me koi dated lead nahi mili.</p>'}`;
  } catch (err) {
    toast(err.message, 'err');
  }
}

$('rngGo').onclick = () => {
  const f = $('rngFrom').value, t = $('rngTo').value;
  if (!f || !t) { toast('Dono dates choose karo', 'err'); return; }
  loadRange(f, t);
};
$('rng7').onclick = () => {
  const to = new Date(), from = new Date();
  from.setDate(from.getDate() - 6);
  $('rngFrom').value = isoOf(from); $('rngTo').value = isoOf(to);
  loadRange(isoOf(from), isoOf(to));
};
$('rngWeek').onclick = () => {
  const now = new Date();
  const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  $('rngFrom').value = isoOf(mon); $('rngTo').value = isoOf(now);
  loadRange(isoOf(mon), isoOf(now));
};
$('rngMonth').onclick = () => {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  $('rngFrom').value = isoOf(first); $('rngTo').value = isoOf(now);
  loadRange(isoOf(first), isoOf(now));
};
$('rngClear').onclick = () => {
  $('rngFrom').value = ''; $('rngTo').value = ''; $('rangeResult').innerHTML = '';
};

/* ---------- CHART RENDERERS ---------- */
async function loadDailyChart() {
  try {
    const to = new Date(), from = new Date();
    from.setDate(from.getDate() - 13);
    const r = await api(`/api/range?from=${isoOf(from)}&to=${isoOf(to)}`);
    state.chartData.daily = r.days || [];
    const anyData = (r.days || []).some(d => d.total > 0);
    $('dailyChartEmpty').classList.toggle('hidden', anyData);
    renderDailyChart();
  } catch {}
}

function renderDailyChart() {
  const days = state.chartData.daily;
  if (!days) return;
  const map = new Map(days.map(d => [d.date, d]));
  const labels = [], totals = [], sents = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const rec = map.get(isoOf(d)) || { total: 0, sent: 0 };
    labels.push(d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));
    totals.push(rec.total);
    sents.push(rec.sent);
  }
  const p = chartPalette();
  mountChart('dailyChart', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Total Leads', data: totals, backgroundColor: p.blue + 'd9', hoverBackgroundColor: p.blue, borderRadius: 5, maxBarThickness: 20 },
        { label: 'Sent', data: sents, backgroundColor: p.ok + 'd9', hoverBackgroundColor: p.ok, borderRadius: 5, maxBarThickness: 20 }
      ]
    },
    options: {
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, usePointStyle: true } } },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 8 } },
        y: { beginAtZero: true, grid: { color: p.grid }, ticks: { precision: 0 } }
      }
    }
  });
}

function renderStatusChart() {
  const counts = state.chartData.status;
  if (!counts) return;
  const top = counts.slice(0, 6);
  const otherSum = counts.slice(6).reduce((a, x) => a + x.count, 0);
  const rows = otherSum > 0 ? top.concat([{ name: 'Other', count: otherSum }]) : top;
  $('statusChartEmpty').classList.toggle('hidden', rows.length > 0);
  if (!rows.length) return;
  const p = chartPalette();
  const colors = [p.brand, p.violet, p.ok, p.warn, p.danger, p.blue, p.slate];
  mountChart('statusChart', {
    type: 'doughnut',
    data: {
      labels: rows.map(x => x.name),
      datasets: [{
        data: rows.map(x => x.count),
        backgroundColor: colors.map(c => c + 'e6'),
        borderColor: p.card, borderWidth: 2, hoverOffset: 6
      }]
    },
    options: {
      cutout: '58%',
      plugins: { legend: { position: 'right', labels: { boxWidth: 10, usePointStyle: true } } }
    }
  });
}

function renderReportChart() {
  const d = state.chartData.report;
  if (!d) return;
  const p = chartPalette();
  mountChart('reportChart', {
    type: 'bar',
    data: {
      labels: ['✅ Sent', '⏳ Pending'],
      datasets: [{
        data: [d.sent, d.pending],
        backgroundColor: [p.ok + 'e6', p.danger + 'e6'],
        borderRadius: 10, maxBarThickness: 64
      }]
    },
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true, grid: { color: p.grid }, ticks: { precision: 0 } },
        y: { grid: { display: false }, ticks: { font: { size: 14, weight: '600' } } }
      }
    }
  });
}

/* ---------- TEAM LEADERBOARD ---------- */
function renderLeaderboard(perUser) {
  const board = [...perUser].sort((a, b) => b.added - a.added || b.emailed - a.emailed || b.followed - a.followed);
  const medals = ['🥇', '🥈', '🥉'];
  $('lbEmpty').classList.toggle('hidden', board.length > 0);
  $('leaderboard').innerHTML = board.map((u, i) => `
    <div class="lb-card ${i === 0 ? 'gold' : ''}">
      <div class="lb-rank ${medals[i] ? '' : 'num'}">${medals[i] || '#' + (i + 1)}</div>
      <div class="lb-ava">${esc(String(u.name || '?').charAt(0).toUpperCase())}</div>
      <div class="lb-info">
        <div class="lb-name">${esc(u.name)}</div>
        <div class="lb-stats">
          <span><b>${u.added}</b> entries</span>
          <span>✉️ <b>${u.emailed}</b> emails</span>
          <span>👥 <b>${u.followed}</b> followed</span>
        </div>
      </div>
    </div>`).join('');
}

/* ============ LEADS (READ ONLY + PAGINATION) ============ */
async function loadLeads(silent) {
  try {
    const r = await api('/api/scraped');
    state.leads = r.leads || [];
    buildStatusFilter();
    buildShiftFilter();
    renderLeads();
    markSync();
  } catch (err) {
    if (!silent) toast(err.message, 'err');
  }
}
$('leadsRefresh').onclick = () => loadLeads();

function buildStatusFilter() {
  const sel = $('statusFilter');
  const cur = sel.value;
  const statuses = [...new Set(state.leads.map(l => l.Status).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">Status: All</option>' +
    statuses.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
}

function filteredLeads() {
  const q = $('leadSearch').value.trim().toLowerCase();
  const sf = $('statusFilter').value;
  const shf = $('shiftFilter').value;
  return state.leads.filter(l => {
    if (sf && l.Status !== sf) return false;
    if (shf && l.Shift !== shf) return false;
    if (!q) return true;
    /* HAR column me search — sheet me naye added columns bhi search hote hain */
    return Object.keys(l).some(k => (k !== 'Tab' && k !== 'id') &&
      String(l[k] == null ? '' : l[k]).toLowerCase().includes(q));
  });
}

/* Sheet ke naye columns jo website ke fixed layout me nahi hain */
const LEAD_BASE_KEYS = ['id', 'Name', 'Email', 'Phone', 'LinkedIn', 'Status', 'Category', 'Website', 'Date', 'Shift', 'Tab'];

function leadExtraCols() {
  const extras = [];
  for (const l of state.leads) {
    for (const k of Object.keys(l)) {
      if (!LEAD_BASE_KEYS.includes(k) && !extras.includes(k) && String(k).trim()) extras.push(k);
    }
  }
  return extras; /* koi limit nahi — jitne columns sheet me hon sab dikhenge (table scroll hoti hai) */
}

function renderLeads() {
  const rows = filteredLeads();
  const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  if (state.page > pages) state.page = pages;

  const slice = rows.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
  $('leadCountInfo').textContent = `${rows.length.toLocaleString()} lead${rows.length === 1 ? '' : 's'} found`;

  /* Dynamic columns: sheet me jo bhi naya column ho wo khud table me aa jata hai */
  const extraCols = leadExtraCols();
  const theadTr = document.querySelector('#leadsView .leads-table thead tr');
  if (theadTr) {
    theadTr.innerHTML =
      '<th>#</th><th>Business</th><th>Email</th><th>Phone</th><th>LinkedIn</th>' +
      extraCols.map(h => `<th>${esc(h)}</th>`).join('') +
      '<th>Shift</th><th>Status</th><th>Category</th><th>Date</th>';
  }

  $('leadsBody').innerHTML = slice.map(l => `
    <tr>
      <td class="cell-muted">${esc(l.id)}</td>
      <td><b>${esc(l.Name)}</b>${l.Website ? `<br><a href="${esc(l.Website)}" target="_blank" rel="noopener" style="font-size:12px">${esc(l.Website.replace(/^https?:\/\//, '').slice(0, 40))}</a>` : ''}</td>
      <td>${l.Email ? `<a href="mailto:${esc(l.Email)}">${esc(l.Email)}</a>` : '<span class="cell-muted">-</span>'}</td>
      <td class="cell-muted">${esc(l.Phone) || '-'}</td>
      <td>${l.LinkedIn ? `<a href="${esc(normUrl(l.LinkedIn))}" target="_blank" rel="noopener">Profile</a>` : '<span class="cell-muted">-</span>'}</td>
      ${extraCols.map(h => `<td class="cell-muted lead-extra">${esc(l[h]) || '-'}</td>`).join('')}
      <td><span class="badge shiftb ${l.Shift === 'Day' ? 'dayb' : l.Shift === 'Night' ? 'nightb' : ''}">${esc(l.Shift)}</span></td>
      <td>${l.Status ? `<span class="badge statb">${esc(l.Status)}</span>` : '<span class="cell-muted">-</span>'}</td>
      <td class="cell-muted">${esc(l.Category) || '-'}</td>
      <td class="cell-muted">${fmtDate(l.Date)}</td>
    </tr>`).join('');

  $('leadsEmpty').classList.toggle('hidden', rows.length > 0);
  $('pgInfo').textContent = `Page ${state.page} of ${pages}`;
  $('pgPrev').disabled = state.page <= 1;
  $('pgNext').disabled = state.page >= pages;
}

$('pgPrev').onclick = () => { if (state.page > 1) { state.page--; renderLeads(); } };
$('pgNext').onclick = () => { state.page++; renderLeads(); };
['leadSearch'].forEach(id => $(id).addEventListener('input', () => { state.page = 1; renderLeads(); }));
['statusFilter', 'shiftFilter'].forEach(id => $(id).addEventListener('change', () => { state.page = 1; renderLeads(); }));

/* ============ LINKEDIN TRACKER ============ */
function normUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return 'https://' + s.replace(/^\/+/, '');
}

async function loadTracker(silent) {
  try {
    const r = await api('/api/tracker');
    state.tracker = r.entries || [];
    renderTrackStats();
    renderTrackTable();
    markSync();
  } catch (err) {
    if (!silent) toast(err.message, 'err');
  }
}

function scopedTracker() {
  if (!state.trackMineOnly) return state.tracker;
  const me = String((state.user && state.user.name) || '').trim().toLowerCase();
  return state.tracker.filter(t => {
    const ab = String(t['Added By'] || '').trim().toLowerCase();
    return !ab || ab === me;
  });
}

function renderTrackStats() {
  const mine = scopedTracker();
  const total = mine.length;
  const emailed = mine.filter(t => t.Emailed === 'Yes').length;
  const followed = mine.filter(t => t.Followed === 'Yes').length;
  const connSent = mine.filter(t => t['Connection Sent'] === 'Yes').length;
  const accepted = mine.filter(t => t.Accepted === 'Yes').length;
  const teamTotal = state.tracker.length;
  $('trackStats').innerHTML = `
    <div class="stat-card brand"><div class="stat-num">${total}</div><div class="stat-label">${state.trackMineOnly ? 'Aapki Entries' : 'Total Entries'}</div><div class="stat-sub">${state.trackMineOnly ? 'Team total: ' + teamTotal : 'Sab members mila kar'}</div></div>
    <div class="stat-card ok"><div class="stat-num">${connSent}</div><div class="stat-label">Connections Sent</div></div>
    <div class="stat-card ok"><div class="stat-num">${accepted}</div><div class="stat-label">Accepted</div></div>
    <div class="stat-card violet"><div class="stat-num">${followed}</div><div class="stat-label">Followed</div></div>
    <div class="stat-card ok"><div class="stat-num">${emailed}</div><div class="stat-label">Emails Sent</div></div>
    <div class="stat-card warn"><div class="stat-num">${total - emailed}</div><div class="stat-label">Email Pending</div></div>`;
}

function filteredTracker() {
  const base = scopedTracker();
  const q = $('trackSearch').value.trim().toLowerCase();
  if (!q) return base;
  return base.filter(t =>
    ['Name', 'Email', 'LinkedIn', 'Notes', 'SCR', 'Added By'].some(k => String(t[k]).toLowerCase().includes(q)));
}

function renderTrackTable() {
  const rows = filteredTracker();
  $('trackCountInfo').textContent = `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`;
  $('trackBody').innerHTML = rows.map(t => `
    <tr data-id="${esc(t.id)}">
      <td class="cell-muted">${esc(t.ID)}</td>
      <td><b>${esc(t.Name)}</b></td>
      <td>${t.Email ? `<a href="mailto:${esc(t.Email)}">${esc(t.Email)}</a>` : '<span class="cell-muted">-</span>'}</td>
      <td>${t.LinkedIn ? `<a href="${esc(normUrl(t.LinkedIn))}" target="_blank" rel="noopener">Profile</a>` : '<span class="cell-muted">-</span>'}</td>
      <td><b>${esc(t.SCR) || '-'}</b></td>
      <td><span class="badge ${t.Followed === 'Yes' ? 'yes' : 'no'} toggle" data-field="Followed">${t.Followed === 'Yes' ? 'Followed' : 'Not yet'}</span></td>
      <td><span class="badge ${t.Emailed === 'Yes' ? 'yes' : 'no'} toggle" data-field="Emailed">${t.Emailed === 'Yes' ? 'Sent ✓' : 'Not sent'}</span></td>
      <td><span class="badge ${t['Connection Sent'] === 'Yes' ? 'yes' : 'no'} toggle" data-field="Connection Sent">${t['Connection Sent'] === 'Yes' ? 'Sent ✓' : 'Not yet'}</span></td>
      <td><span class="badge ${t.Accepted === 'Yes' ? 'yes' : 'no'} toggle" data-field="Accepted">${t.Accepted === 'Yes' ? 'Accepted ✓' : 'Pending'}</span></td>
      <td class="cell-muted" style="max-width:220px">${esc(t.Notes)}</td>
      <td>${esc(t['Added By'])}</td>
      <td class="cell-muted">${fmtDate(t.Date)}</td>
      <td><div class="row-actions">
        <button class="mini-btn edit">Edit</button>
        <button class="mini-btn del">Del</button>
      </div></td>
    </tr>`).join('');

  const emptyEl = $('trackEmpty');
  emptyEl.classList.toggle('hidden', rows.length > 0);
  if (!rows.length) {
    emptyEl.innerHTML = (state.trackMineOnly && state.tracker.length)
      ? '<b>Aapke is username ki koi entry nahi mili</b><p>Shayad entries kisi doosre account se banayi gayi thin. Neeche <b>"Sab Dikhao"</b> button dabayen — ya usi username se login karein jis se entries save ki thin.</p>'
      : '<b>No entries yet</b><p>Click "+ Add LinkedIn Lead" to start tracking.</p>';
  }
}

$('trackSearch').addEventListener('input', renderTrackTable);

$('trackScopeBtn').onclick = () => {
  state.trackMineOnly = !state.trackMineOnly;
  $('trackScopeBtn').textContent = state.trackMineOnly ? 'Sab Dikhao' : 'Sirf Meri';
  renderTrackStats();
  renderTrackTable();
};

$('trackBody').addEventListener('click', async e => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const id = tr.dataset.id;

  if (e.target.classList.contains('toggle')) {
    const field = e.target.dataset.field;
    const entry = state.tracker.find(x => String(x.id) === String(id));
    if (!entry) return;
    const next = entry[field] === 'Yes' ? 'No' : 'Yes';
    try {
      await api(`/api/tracker/${id}`, { method: 'PUT', body: { [field]: next } });
      entry[field] = next;
      renderTrackStats(); renderTrackTable();
    } catch (err) { toast(err.message, 'err'); }
    return;
  }

  if (e.target.classList.contains('edit')) openTrackModal(id);

  if (e.target.classList.contains('del')) {
    askConfirm('Delete this LinkedIn entry? (Only removes it from the tracker — your sheet data is never touched)', async () => {
      try {
        await api(`/api/tracker/${id}`, { method: 'DELETE' });
        toast('Entry deleted', 'ok');
        loadTracker(true);
      } catch (err) { toast(err.message, 'err'); }
    });
  }
});

/* ============ TRACKER MODAL ============ */
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

document.querySelectorAll('.modal-overlay').forEach(ov => {
  ov.addEventListener('click', e => {
    if (e.target === ov || e.target.closest('[data-close]')) ov.classList.add('hidden');
  });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-overlay').forEach(m => m.classList.add('hidden'));
});

function openTrackModal(id) {
  $('trackMsg').textContent = '';
  const t = id ? state.tracker.find(x => String(x.id) === String(id)) : null;
  state.editingTrackId = t ? t.id : null;
  $('trackModalTitle').textContent = t ? `Edit Entry #${t.ID}` : 'New LinkedIn Lead';
  $('tName').value = t ? t.Name : '';
  $('tEmail').value = t ? t.Email : '';
  $('tLinkedin').value = t ? t.LinkedIn : '';
  $('tScr').value = t ? t.SCR : '';
  $('tNotes').value = t ? t.Notes : '';
  $('tFollowed').checked = !!(t && t.Followed === 'Yes');
  $('tEmailed').checked = !!(t && t.Emailed === 'Yes');
  $('tConn').checked = !!(t && t['Connection Sent'] === 'Yes');
  $('tAccepted').checked = !!(t && t.Accepted === 'Yes');
  openModal('trackModal');
  setTimeout(() => $('tName').focus(), 50);
}

$('addTrackBtn').onclick = () => openTrackModal(null);

$('trackForm').onsubmit = async e => {
  e.preventDefault();
  $('trackMsg').textContent = '';
  const body = {
    Name: $('tName').value.trim(),
    Email: $('tEmail').value.trim(),
    LinkedIn: normUrl($('tLinkedin').value),
    SCR: $('tScr').value.trim(),
    Notes: $('tNotes').value.trim(),
    Followed: $('tFollowed').checked ? 'Yes' : 'No',
    Emailed: $('tEmailed').checked ? 'Yes' : 'No',
    'Connection Sent': $('tConn').checked ? 'Yes' : 'No',
    Accepted: $('tAccepted').checked ? 'Yes' : 'No'
  };
  if (!body.Name && !body.LinkedIn) {
    $('trackMsg').textContent = 'Name or LinkedIn URL — at least one is required';
    return;
  }
  try {
    if (state.editingTrackId) {
      await api(`/api/tracker/${state.editingTrackId}`, { method: 'PUT', body });
      toast('Entry updated ✓', 'ok');
    } else {
      await api('/api/tracker', { method: 'POST', body });
      toast('Entry saved ✓', 'ok');
    }
    closeModal('trackModal');
    loadTracker(true);
  } catch (err) {
    $('trackMsg').textContent = err.message;
  }
};

/* ============ CONFIRM MODAL ============ */
function askConfirm(text, action) {
  $('confirmText').textContent = text;
  state.confirmAction = action;
  openModal('confirmModal');
}
$('confirmYes').onclick = async () => {
  closeModal('confirmModal');
  if (state.confirmAction) await state.confirmAction();
  state.confirmAction = null;
};

/* ============ REPORT ============ */
let lastReport = null, lastWeeks = [], currentWeekKey = null;

async function loadReport(silent) {
  try {
    const [r, w] = await Promise.all([api('/api/report'), api('/api/weeks')]);
    lastReport = r;
    lastWeeks = w.weeks || [];
    currentWeekKey = w.currentWeek;
    markSync();

    /* ---- headline numbers ---- */
    const total = r.sheet.total;
    const sent = lastWeeks.reduce((a, x) => a + x.sent, 0);
    const pending = Math.max(0, total - sent);
    const dups = r.sheet.duplicateRows;

    const rangeLabel = (state.lastStats && state.lastStats.dateRange && state.lastStats.dateRange.label)
      || (lastWeeks.length ? `${lastWeeks[lastWeeks.length - 1].label.split('–')[0].trim()} – ${lastWeeks[0].label.split('–')[1].trim()}` : 'No dates yet');
    $('reportMeta').textContent = rangeLabel + (r.tracker.scrAvg != null ? `   •   Average SCR: ${r.tracker.scrAvg}` : '');

    $('rpStats').innerHTML = `
      <div class="stat-card brand"><div class="stat-num">${total.toLocaleString()}</div><div class="stat-label">Total Leads</div></div>
      <div class="stat-card ok"><div class="stat-num">${sent.toLocaleString()}</div><div class="stat-label">Total Sent Mails</div></div>
      <div class="stat-card warn"><div class="stat-num">${dups.toLocaleString()}</div><div class="stat-label">Duplicate Emails</div></div>
      <div class="stat-card violet"><div class="stat-num">${r.tracker.total.toLocaleString()}</div><div class="stat-label">LinkedIn Tracked</div></div>
      <div class="stat-card"><div class="stat-num">${pending.toLocaleString()}</div><div class="stat-label">Pending (not sent)</div></div>
      <div class="stat-card ok"><div class="stat-num">${(r.tracker.followed || 0).toLocaleString()}</div><div class="stat-label">Follow-ups Done</div></div>`;

    $('rpSummary').innerHTML =
      `<span class="ok-text">✔ Sent: <b>${sent.toLocaleString()}</b> leads</span>` +
      `<span class="sep">•</span>` +
      `<span class="pend-text">✘ Not sent yet: <b>${pending.toLocaleString()}</b> persons</span>`;

    state.chartData.report = { sent, pending };
    renderReportChart();
    renderLeaderboard(r.perUser || []);

    /* ---- weeks table ---- */
    if (lastWeeks.length) {
      $('weeksEmpty').classList.add('hidden');
      $('weeksBody').innerHTML = lastWeeks.map(x => `
        <tr class="${x.key === currentWeekKey ? 'cur-week' : ''}">
          <td><b>${esc(x.label)}</b>${x.key === currentWeekKey ? ' <span class="badge statb">current</span>' : ''}</td>
          <td>${x.total.toLocaleString()}</td>
          <td><b style="color:var(--ok)">${x.sent}</b></td>
          <td>${x.pending}</td>
          <td>${x.duplicates}</td>
          <td>${x.linkedin}</td>
          <td><div class="row-actions">
            <button class="btn btn-ghost btn-sm week-print" data-key="${esc(x.key)}">Print</button>
            <button class="btn btn-ghost btn-sm week-png" data-key="${esc(x.key)}">PNG</button>
          </div></td>
        </tr>`).join('');
    } else {
      $('weeksBody').innerHTML = '';
      $('weeksEmpty').classList.remove('hidden');
    }

    /* ---- team + progress ---- */
    if (r.perUser.length) {
      $('perUserBody').innerHTML = r.perUser.map(u => `
        <tr>
          <td><b>${esc(u.name)}</b></td>
          <td>${u.added}</td>
          <td>${u.emailed}</td>
          <td>${u.followed}</td>
        </tr>`).join('');
      $('perUserEmpty').classList.add('hidden');
    } else {
      $('perUserBody').innerHTML = '';
      $('perUserEmpty').classList.remove('hidden');
    }

    $('progressBars').innerHTML = `
      <div class="progress-row">
        <div class="progress-top"><span>Email Progress</span><span>${total ? Math.round((sent / total) * 100) : 0}%</span></div>
        <div class="progress-track"><div class="progress-fill green" style="width:${total ? Math.round((sent / total) * 100) : 0}%"></div></div>
      </div>`;
  } catch (err) {
    if (!silent) toast(err.message, 'err');
  }
}

/* ---- printing: screen pe hidden area print me dikhta hai ----
   Background watermark = Nexe Agent logo 40% opacity,
   Footer credit = Team Mahnoor Fatima & Sana Shakeel */
function buildPrintSheet(label, stats) {
  return `
    <div class="pr-sheet">
      <img src="/logo.png" class="pr-mark" alt="">
      <div class="pr-content">
        <div class="pr-logo-wrap"><img src="/logo.png" class="pr-logo" alt="Nexe Agent"></div>
        <div class="pr-title">Weekly Report</div>
        <div class="pr-sub">Nexe Agent</div>
        <div class="pr-range">${esc(label)}</div>
        <table class="pr-table">
          <tr><td>Total Leads</td><td class="num">${stats.total.toLocaleString()}</td></tr>
          <tr><td>Total Sent Mails</td><td class="num">${stats.sent.toLocaleString()}</td></tr>
          <tr><td>Follow-ups Done</td><td class="num">${(stats.followed || 0).toLocaleString()}</td></tr>
          <tr><td>Duplicate Emails</td><td class="num">${stats.dups.toLocaleString()}</td></tr>
          <tr><td>LinkedIn Tracked</td><td class="num">${stats.linkedin.toLocaleString()}</td></tr>
        </table>
        <div class="pr-summary">
          Sent: <b>${stats.sent.toLocaleString()}</b> &nbsp;|&nbsp; Not sent yet: <b>${stats.pending.toLocaleString()}</b> persons
        </div>
        <div class="pr-team">Team Mahnoor Fatima &amp; Sana Shakeel<div class="pr-team-sub">Nexe Agent</div></div>
        <div class="pr-foot">Generated: ${new Date().toLocaleString()} • Lead Manager</div>
      </div>
    </div>`;
}

function fillPrintSheet(getStats) {
  if (!lastReport) return;
  const total = lastReport.sheet.total;
  const sent = lastWeeks.reduce((a, x) => a + x.sent, 0);
  const rangeLabel = (state.lastStats && state.lastStats.dateRange && state.lastStats.dateRange.label)
    || (lastWeeks.length ? `${lastWeeks[lastWeeks.length - 1].label.split('–')[0].trim()} – ${lastWeeks[0].label.split('–')[1].trim()}` : 'All time');
  const stats = Object.assign({
    total, sent, dups: lastReport.sheet.duplicateRows,
    linkedin: lastReport.tracker.total,
    followed: lastReport.tracker.followed || 0,
    pending: Math.max(0, total - sent)
  }, getStats || {});
  $('printArea').innerHTML = buildPrintSheet(rangeLabel, stats);
  return { rangeLabel, stats };
}

$('printBtn').onclick = () => {
  if (!fillPrintSheet(null)) return;
  window.print();
  $('printArea').innerHTML = '';
};

async function capturePng(filename) {
  if (typeof html2canvas === 'undefined') { toast('PNG library load nahi hui — internet check karo', 'err'); return; }
  const stage = document.createElement('div');
  stage.style.cssText = 'position:fixed;left:-9999px;top:0;width:720px;background:#fff;z-index:-1;';
  stage.appendChild($('printArea').firstElementChild.cloneNode(true));
  document.body.appendChild(stage);
  try {
    const canvas = await html2canvas(stage.firstElementChild, { backgroundColor: '#ffffff', scale: 2, useCORS: true });
    await new Promise(resolve => {
      canvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        resolve();
      }, 'image/png');
    });
    toast('PNG download ho gayi ✓', 'ok');
  } catch (err) {
    toast('PNG fail: ' + err.message, 'err');
  } finally {
    stage.remove();
    $('printArea').innerHTML = '';
  }
}

$('pngBtn').onclick = async () => {
  if (!lastReport) return;
  if (!fillPrintSheet(null)) return;
  await capturePng('weekly-report-' + new Date().toISOString().slice(0, 10) + '.png');
};

/* ---- WhatsApp share ---- */
$('waBtn').onclick = () => {
  if (!lastReport) { toast('Report abhi load nahi hui — thori dair baad try karein', 'err'); return; }
  const total = lastReport.sheet.total;
  const sent = lastWeeks.reduce((a, x) => a + x.sent, 0);
  const pending = Math.max(0, total - sent);
  const rangeLabel = (state.lastStats && state.lastStats.dateRange && state.lastStats.dateRange.label)
    || (lastWeeks.length ? `${lastWeeks[lastWeeks.length - 1].label.split('–')[0].trim()} – ${lastWeeks[0].label.split('–')[1].trim()}` : 'All time');
  const lines = [
    '📊 *NEXE AGENT — WEEKLY REPORT*',
    '',
    `📅 Range: ${rangeLabel}`,
    `👥 Total Leads: *${total.toLocaleString()}*`,
    `✅ Emails Sent: *${sent.toLocaleString()}*`,
    `⏳ Pending: *${pending.toLocaleString()}*`,
    `🔁 Duplicate Emails: *${lastReport.sheet.duplicateRows.toLocaleString()}*`,
    `🔗 LinkedIn Tracked: *${lastReport.tracker.total.toLocaleString()}*`,
    lastReport.tracker.scrAvg != null ? `⭐ Average SCR: *${lastReport.tracker.scrAvg}*` : '',
    '',
    '_Team Mahnoor Fatima & Sana Shakeel_'
  ].filter(Boolean);
  window.open('https://wa.me/?text=' + encodeURIComponent(lines.join('\n')), '_blank', 'noopener');
};

function fillWeekPrintSheet(w) {
  $('printArea').innerHTML = buildPrintSheet(w.label, {
    total: w.total, sent: w.sent, dups: w.duplicates,
    linkedin: w.linkedin,
    followed: lastReport && lastReport.tracker ? lastReport.tracker.followed : 0,
    pending: w.pending
  });
}

$('weeksBody').addEventListener('click', async e => {
  const pbtn = e.target.closest('.week-print');
  const gbtn = e.target.closest('.week-png');
  if (!pbtn && !gbtn) return;
  const w = lastWeeks.find(x => x.key === (pbtn || gbtn).dataset.key);
  if (!w) return;
  fillWeekPrintSheet(w);
  if (pbtn) {
    window.print();
    $('printArea').innerHTML = '';
  } else {
    await capturePng(`weekly-${w.key}.png`);
  }
});

$('reportRefresh').onclick = loadReport;

/* ============ start ============ */
boot();
