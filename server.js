require('dotenv').config();
const path = require('path');
const os = require('os');
const fs = require('fs');
const express = require('express');
const session = require('express-session');

const users = require('./users');
const store = require('./store');
const cloudstore = require('./cloudstore');

const app = express();
const PORT = process.env.PORT || 3001;

/* Render ke reverse proxy ke peeche sahi req.protocol/secure cookie ke liye */
app.set('trust proxy', 1);

app.get('/ping', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use(express.json());
app.use(session({
  secret: users.getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7, httpOnly: true, sameSite: 'lax', secure: 'auto' }
}));

app.use(express.static(path.join(__dirname, 'public')));

function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Please log in first' });
}

/* ---------- AUTH ---------- */

app.get('/api/auth/status', async (req, res) => {
  res.json(await users.status());
});

app.post('/api/register', async (req, res) => {
  try {
    const user = await users.register(req.body.username, req.body.password);
    req.session.user = { name: user.username };
    res.json({ ok: true, user: req.session.user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const user = await users.login(req.body.username, req.body.password);
    req.session.user = { name: user.username };
    res.json({ ok: true, user: req.session.user });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.user) return res.json({ user: req.session.user });
  res.json({ user: null });
});

/* Sheet connect hone tak store-wali APIs yahan ruk jati hain,
   lekin server aur login page FORAN chalte hain */
let readyPromise = Promise.resolve();
app.use('/api', (req, res, next) => readyPromise.then(() => next(), () => next()));

app.get('/api/meta', requireLogin, (req, res) => {
  res.json({ mode: store.mode(), readonly: true });
});

/* ---------- SCRAPED LEADS (READ-ONLY) ---------- */

app.get('/api/scraped', requireLogin, async (req, res) => {
  try {
    const leads = await store.listLeads();
    res.json({ leads, readonly: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not load leads: ' + err.message });
  }
});

/* ---------- STATS + DUPLICATES ---------- */

function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

/* Sheet ke Status column se SENT counting (tracker khali ho to bhi sahi).
   "SENT", "Sent Email", "Email Sent" sab count; "Not sent" nahi */
function isSentRow(l) {
  const s = String(l.Status || '').trim().toLowerCase();
  return Boolean(s) && s.includes('sent') && !s.includes('not') && !s.includes("n't");
}

/* ---------- WEEKLY REPORTS (auto) ---------- */
const WEEKLY_FILE = path.join(__dirname, 'data', 'weekly-reports.json');

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
const pad2 = n => String(n).padStart(2, '0');

function mondayOf(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() - ((t.getDay() + 6) % 7));
  return t;
}
function wkKey(d) {
  const m = mondayOf(d);
  return `${m.getFullYear()}-${pad2(m.getMonth() + 1)}-${pad2(m.getDate())}`;
}
function addDays(d, n) { const t = new Date(d); t.setDate(t.getDate() + n); return t; }
function fmtD(d) { return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }

function dateRangeOf(leads) {
  const ds = leads.map(l => parseDate(l.Date)).filter(Boolean);
  if (!ds.length) return null;
  const min = new Date(Math.min(...ds)), max = new Date(Math.max(...ds));
  return { from: min.toISOString(), to: max.toISOString(), label: `${fmtD(min)} – ${fmtD(max)}, ${max.getFullYear()}` };
}

function buildWeekRows(leads, tracker) {
  /* sent ab sheet ke Status column se count hota hai (tracker match nahi) */
  const weeks = new Map();
  for (const l of leads) {
    const d = parseDate(l.Date);
    if (!d) continue;
    const k = wkKey(d);
    if (!weeks.has(k)) weeks.set(k, { key: k, total: 0, sent: 0, emails: new Map() });
    const w = weeks.get(k);
    w.total++;
    if (isSentRow(l)) w.sent++;
    const e = normEmail(l.Email);
    if (e) w.emails.set(e, (w.emails.get(e) || 0) + 1);
  }

  const linkedinAdds = {};
  for (const t of tracker) {
    const d = parseDate(t.Date);
    if (!d) continue;
    const k = wkKey(d);
    linkedinAdds[k] = (linkedinAdds[k] || 0) + 1;
  }

  const out = [];
  for (const [k, w] of weeks.entries()) {
    let dup = 0;
    for (const n of w.emails.values()) if (n > 1) dup += n;
    const from = mondayOf(parseDate(k));
    const to = addDays(from, 6);
    out.push({
      key: k,
      from: from.toISOString(),
      to: to.toISOString(),
      label: `${fmtD(from)} – ${fmtD(to)}, ${to.getFullYear()}`,
      total: w.total,
      duplicates: dup,
      sent: w.sent,
      pending: Math.max(0, w.total - w.sent),
      linkedin: linkedinAdds[k] || 0
    });
  }
  out.sort((a, b) => b.key.localeCompare(a.key));
  return out;
}

async function getWeekRows(force) {
  const [leads, tracker] = await Promise.all([store.listLeads(force), store.trackerList(force)]);
  return buildWeekRows(leads, tracker);
}

function loadArchive() {
  try { return JSON.parse(fs.readFileSync(WEEKLY_FILE, 'utf8')); } catch { return []; }
}

async function getWeeklyArchive() {
  if (cloudstore.available()) {
    try {
      return await cloudstore.getArchive();
    } catch (err) {
      console.warn('[weekly] Cloud archive read fail — file fallback:', err.message);
    }
  }
  return loadArchive();
}

async function saveWeeklyArchive(archive) {
  if (cloudstore.available()) {
    await cloudstore.saveArchive(archive);
    return;
  }
  fs.mkdirSync(path.dirname(WEEKLY_FILE), { recursive: true });
  fs.writeFileSync(WEEKLY_FILE, JSON.stringify(archive, null, 2));
}

/* Week khatam hone ke baad uski report khud save ho jati hai */
async function archivePastWeeks() {
  try {
    const rows = await getWeekRows(true);
    const curKey = wkKey(new Date());
    const past = rows.filter(w => w.key < curKey);
    if (!past.length) return;
    const archive = await getWeeklyArchive();
    let added = 0;
    for (const w of past) {
      if (!archive.some(a => a.key === w.key)) {
        archive.push({ ...w, archivedAt: new Date().toISOString() });
        added++;
      }
    }
    if (added) {
      archive.sort((a, b) => b.key.localeCompare(a.key));
      await saveWeeklyArchive(archive);
      console.log(`[weekly] ${added} week report(s) archived`);
    }
  } catch (err) {
    console.warn('[weekly] archive skipped:', err.message);
  }
}

app.get('/api/weeks', requireLogin, async (req, res) => {
  try {
    res.json({ currentWeek: wkKey(new Date()), weeks: await getWeekRows(false) });
  } catch (err) {
    res.status(500).json({ error: 'Could not build weekly data: ' + err.message });
  }
});

app.get('/api/weekly-reports', requireLogin, async (req, res) => {
  res.json({ archived: await getWeeklyArchive() });
});

app.get('/api/stats', requireLogin, async (req, res) => {
  try {
    const leads = await store.listLeads();
    const total = leads.length;

    const byEmail = new Map();
    let withEmail = 0;
    for (const l of leads) {
      const e = normEmail(l.Email);
      if (!e) continue;
      withEmail++;
      if (!byEmail.has(e)) byEmail.set(e, []);
      byEmail.get(e).push(l);
    }

    const dupGroups = [];
    let duplicateRows = 0;
    for (const [email, arr] of byEmail.entries()) {
      if (arr.length > 1) {
        duplicateRows += arr.length;
        dupGroups.push({
          email,
          count: arr.length,
          names: [...new Set(arr.map(l => l.Name).filter(Boolean))].slice(0, 4),
          rows: arr.map(l => l.id)
        });
      }
    }
    dupGroups.sort((a, b) => b.count - a.count);

    const statusCounts = {};
    const categoryCounts = {};
    const shiftCounts = {};
    for (const l of leads) {
      const s = l.Status || '(blank)';
      statusCounts[s] = (statusCounts[s] || 0) + 1;
      if (l.Category) categoryCounts[l.Category] = (categoryCounts[l.Category] || 0) + 1;
      const sh = l.Shift || 'Other';
      if (!shiftCounts[sh]) shiftCounts[sh] = { count: 0, sent: 0 };
      shiftCounts[sh].count++;
      if (isSentRow(l)) shiftCounts[sh].sent++;
    }

    const topCategories = Object.entries(categoryCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    const sentFromSheet = leads.filter(isSentRow).length;

    res.json({
      total,
      sentFromSheet,
      notSent: total - sentFromSheet,
      uniqueEmails: byEmail.size,
      duplicateRows,
      duplicatePercent: total ? Math.round((duplicateRows / total) * 100) : 0,
      missingEmail: total - withEmail,
      dateRange: dateRangeOf(leads),
      statusCounts: Object.entries(statusCounts)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      shiftCounts: Object.entries(shiftCounts)
        .map(([name, s]) => ({ name, count: s.count, sent: s.sent }))
        .sort((a, b) => b.count - a.count),
      tabs: store.getTabs ? store.getTabs() : [],
      topCategories,
      dupGroups: dupGroups.slice(0, 100),
      dupGroupCount: dupGroups.length
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not build stats: ' + err.message });
  }
});

/* ---------- DATE RANGE CALENDAR ---------- */
app.get('/api/range', requireLogin, async (req, res) => {
  try {
    const leads = await store.listLeads();
    const from = req.query.from ? parseDate(String(req.query.from) + 'T00:00:00') : null;
    const to = req.query.to ? parseDate(String(req.query.to) + 'T23:59:59') : null;
    if ((req.query.from || req.query.to) && (!from || !to)) throw new Error('Invalid dates');
    const list = leads.filter(l => {
      const d = parseDate(l.Date);
      if (!d) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
    let sent = 0;
    const days = {};
    const shifts = {};
    for (const l of list) {
      const isSent = isSentRow(l);
      if (isSent) sent++;
      const d = parseDate(l.Date);
      const k = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      if (!days[k]) days[k] = { date: k, total: 0, sent: 0 };
      days[k].total++;
      if (isSent) days[k].sent++;
      const sh = l.Shift || 'Other';
      if (!shifts[sh]) shifts[sh] = { name: sh, count: 0, sent: 0 };
      shifts[sh].count++;
      if (isSent) shifts[sh].sent++;
    }
    res.json({
      total: list.length,
      sent,
      notSent: list.length - sent,
      days: Object.values(days).sort((a, b) => (a.date < b.date ? 1 : -1)),
      shifts: Object.values(shifts).sort((a, b) => b.count - a.count)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------- LINKEDIN TRACKER (manual entries) ---------- */

function trackerFields(body) {
  const out = {};
  ['Name', 'Email', 'LinkedIn', 'SCR', 'Followed', 'Emailed', 'Connection Sent', 'Accepted', 'Bounced', 'Notes'].forEach(k => {
    if (body[k] !== undefined) out[k] = body[k];
  });
  return out;
}

app.get('/api/tracker', requireLogin, async (req, res) => {
  try {
    const entries = await store.trackerList();
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: 'Could not load tracker: ' + err.message });
  }
});

app.post('/api/tracker', requireLogin, async (req, res) => {
  try {
    const data = trackerFields(req.body);
    if (!String(data.Name || '').trim() && !String(data.LinkedIn || '').trim()) {
      throw new Error('Name or LinkedIn URL — at least one is required');
    }
    data['Added By'] = req.session.user.name;
    const entry = await store.trackerAdd(data);
    res.json({ ok: true, entry });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function canTouchEntry(entry, req) {
  const ab = String(entry['Added By'] || '').trim().toLowerCase();
  return !ab || ab === String((req.session.user && req.session.user.name) || '').trim().toLowerCase();
}

app.put('/api/tracker/:id', requireLogin, async (req, res) => {
  try {
    const list = await store.trackerList();
    const entry = list.find(x => String(x.id) === String(req.params.id));
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    if (!canTouchEntry(entry, req)) return res.status(403).json({ error: 'Ye entry aapki nahi hai — sirf apni entries edit kar sakte hain' });
    const patch = trackerFields(req.body);
    const updated = await store.trackerUpdate(req.params.id, patch);
    res.json({ ok: true, entry: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/tracker/:id', requireLogin, async (req, res) => {
  try {
    const list = await store.trackerList();
    const entry = list.find(x => String(x.id) === String(req.params.id));
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    if (!canTouchEntry(entry, req)) return res.status(403).json({ error: 'Ye entry aapki nahi hai — sirf apni entries delete kar sakte hain' });
    await store.trackerDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ---------- REPORT ---------- */

app.get('/api/report', requireLogin, async (req, res) => {
  try {
    const [leads, tracker] = await Promise.all([store.listLeads(), store.trackerList()]);

    // scraped side
    const byEmail = new Map();
    for (const l of leads) {
      const e = normEmail(l.Email);
      if (!e) continue;
      byEmail.set(e, (byEmail.get(e) || 0) + 1);
    }
    let duplicateRows = 0;
    for (const n of byEmail.values()) if (n > 1) duplicateRows += n;

    const emailedFromSheet = leads.filter(isSentRow).length;

    // tracker side
    const trackedTotal = tracker.length;
    const tEmailed = tracker.filter(t => t.Emailed === 'Yes').length;
    const tFollowed = tracker.filter(t => t.Followed === 'Yes').length;
    const tBounced = tracker.filter(t => t.Bounced === 'Yes').length;

    const perUserMap = {};
    tracker.forEach(t => {
      const u = t['Added By'] || 'Unknown';
      if (!perUserMap[u]) perUserMap[u] = { added: 0, emailed: 0, followed: 0, bounced: 0 };
      perUserMap[u].added++;
      if (t.Emailed === 'Yes') perUserMap[u].emailed++;
      if (t.Followed === 'Yes') perUserMap[u].followed++;
      if (t.Bounced === 'Yes') perUserMap[u].bounced++;
    });

    const scrNums = tracker.map(t => parseFloat(t.SCR)).filter(v => Number.isFinite(v));
    const scrAvg = scrNums.length ? +(scrNums.reduce((a, b) => a + b, 0) / scrNums.length).toFixed(1) : null;

    res.json({
      sheet: {
        total: leads.length,
        uniqueEmails: byEmail.size,
        duplicateRows,
        emailedFromSheet
      },
      tracker: {
        total: trackedTotal,
        emailed: tEmailed,
        followed: tFollowed,
        bounced: tBounced,
        scrAvg
      },
      emailPercent: trackedTotal ? Math.round((tEmailed / trackedTotal) * 100) : 0,
      followPercent: trackedTotal ? Math.round((tFollowed / trackedTotal) * 100) : 0,
      perUser: Object.entries(perUserMap).map(([name, s]) => ({ name, ...s })),
      generatedAt: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not generate report: ' + err.message });
  }
});

/* fallback */
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  const initPromise = store.init();
  readyPromise = initPromise;

  const maxSeats = parseInt(process.env.MAX_USERS, 10) || 4;
  app.listen(PORT, '0.0.0.0', () => {
    const nets = os.networkInterfaces();
    const ips = [];
    Object.values(nets).forEach(list => (list || []).forEach(n => {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }));

    console.log('');
    console.log('================================================');
    console.log('   LEAD MANAGER WEBSITE CHAL GAYI HAI');
    console.log('================================================');
    console.log(`   Apne computer par : http://localhost:${PORT}`);
    ips.forEach(ip => console.log(`   Dosre computer se : http://${ip}:${PORT}`));
    console.log(`   Sheet access      : READ-ONLY (kuch change/delete nahi hoga)`);
    console.log(`   Login limit       : ${maxSeats} log`);
    console.log('   Sheet connect ho rahi hai... kuch second lagenge');
    console.log('================================================');
    console.log('');
  });

  try { await initPromise; } catch {}

  /* Cloud storage: _Users/_WeeklyReports tabs + file-users ki migration */
  try {
    if (await cloudstore.init()) {
      await users.syncCloud();
    }
  } catch (err) {
    console.warn('[storage] Cloud users/archive setup skip:', err.message);
  }

  try {
    const st = await users.status();
    console.log(`[users] ${st.registered}/${st.max} seats in use`);
  } catch {}

  console.log('[storage] Website bilkul ready hai ✓ Browser refresh karein');

  await archivePastWeeks();
  setInterval(archivePastWeeks, 60 * 60 * 1000); // har ghantay check
}

start();
