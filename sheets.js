const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------
   RULES:
   1. Scrape tabs (SCRAPE_TABS env) ko website SIRF PARHTI hai.
      Kabhi update/delete/append nahi karti — scraper bilkul safe.
   2. Live feel: results 15 second tak cache hote hain. Frontend har
      30 second me refresh karta hai, is liye sheet me add/delete
      ka asar website par khud-ba-khud nazar aata hai.
   3. LinkedIn Tracker entries ek ALAG tab me save hoti hain.
------------------------------------------------------------------ */

let client = null;
let sheetId = null;
let lastInitError = null;   // Vercel diagnosis: connect na hone ki wajah

let tabsInfo = [];          // [{title, colMap}]
let scrapeCache = { data: null, at: 0 };
let scrapeFetchPromise = null;
/* Quota-safe: Vercel free tier par Google sirf 60 reads/min deta hai.
   Lambi TTL + single-flight dedup se reads kam se kam rakhe hain. */
const SCRAPE_TTL_MS = 60000;

let trackerTabTitle = null;
let trackerNumericId = null;
let trackerHeaders = [];
let trackerCache = { data: null, at: 0 };
let trackerFetchPromise = null;
const TRACKER_TTL_MS = 30000;

const TRACKER_TAB_DEFAULT = 'LinkedIn Tracker';
const TRACKER_HEADERS = ['ID', 'Name', 'Email', 'LinkedIn URL', 'SCR', 'Followed', 'Emailed', 'Connection Sent', 'Accepted', 'Notes', 'Added By', 'Date'];

const ALIASES = {
  Name: ['business name', 'company name', 'business', 'company', 'lead name', 'name'],
  Email: ['email address', 'e-mail', 'email'],
  Phone: ['phone number', 'mobile', 'contact', 'phone'],
  LinkedIn: ['linkedin url', 'linkedin profile', 'linkedin'],
  Status: ['status', 'email status', 'outreach status'],
  Category: ['category', 'type', 'industry'],
  Website: ['website', 'site', 'url'],
  Date: ['scraped date', 'created', 'added date', 'date']
};

const YES_WORDS = ['yes', 'y', 'true', '1', 'sent', 'done', 'followed', 'complete', 'completed', 'replied'];

/* Ye keys website khud manage karta hai — extra column kabhi inpar overwrite nahi hoga */
const RESERVED_KEYS = new Set(['id', 'ID', 'Shift', 'Tab', ...Object.keys(ALIASES)]);

function credPath() {
  return process.env.GOOGLE_CREDENTIALS || path.join(__dirname, 'credentials', 'service-account.json');
}

/* Cloud hosting (Render waghera) ke liye: key file base64 env me bhi de sakte hain */
function credsObject() {
  const b64 = (process.env.GOOGLE_CREDENTIALS_B64 || '').trim();
  if (!b64) return null;
  try {
    const j = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    if (j.client_email && j.private_key) return { client_email: j.client_email, private_key: j.private_key };
  } catch (err) {
    console.warn('[sheets] GOOGLE_CREDENTIALS_B64 parse nahi hua:', err.message);
  }
  return null;
}

function normYN(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return '';
  return YES_WORDS.includes(s) ? 'Yes' : 'No';
}

function colLetter(n) {
  let s = '';
  let x = n;
  while (x >= 0) {
    s = String.fromCharCode(65 + (x % 26)) + s;
    x = Math.floor(x / 26) - 1;
  }
  return s;
}

async function meta() {
  const res = await client.spreadsheets.get({ spreadsheetId: sheetId });
  return res.data;
}

function findCol(lowerHeaders, aliases) {
  for (const a of aliases) {
    const i = lowerHeaders.indexOf(a);
    if (i !== -1) return i;
  }
  for (const a of aliases) {
    const i = lowerHeaders.findIndex(h => h.includes(a));
    if (i !== -1) return i;
  }
  return -1;
}

function shiftLabel(title) {
  const t = String(title).toLowerCase();
  if (t.includes('night')) return 'Night';
  if (t.includes('day')) return 'Day';
  return String(title).trim() || 'Other';
}

/* ---------- SCRAPE TABS (READ-ONLY) ---------- */

async function resolveScrapeTabs(m) {
  const raw = (process.env.SCRAPE_TABS || '').trim();
  let wanted = raw ? raw.split(',').map(t => t.trim()).filter(Boolean) : [];

  if (wanted.length) {
    for (const want of wanted) {
      const found = m.sheets.find(s => s.properties.title.trim().toLowerCase() === want.toLowerCase());
      if (found) {
        tabsInfo.push({ title: found.properties.title });
      } else {
        console.warn(`[sheets] Tab "${want}" nahi mila — skip`);
      }
    }
  }

  // fallback: koi config nahi to pehla non-tracker tab
  if (!tabsInfo.length) {
    const first = m.sheets.find(s => s.properties.title !== trackerTabTitle);
    if (!first) throw new Error('Spreadsheet has no tabs');
    tabsInfo.push({ title: first.properties.title });
    console.warn(`[sheets] SCRAPE_TABS set nahi tha — pehla tab "${first.properties.title}" use ho raha hai`);
  }

  console.log('[sheets] Reading tabs: ' + tabsInfo.map(t => `"${t.title}"`).join(', '));
}

async function fetchTabRows(title) {
  /* A1:ZZ open range — baad me jitne naye columns add hon sab parhne me aa jate hain */
  const res = await client.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${title}!A1:ZZ`
  });
  return res.data.values || [];
}

function fetchLeadsOnce() {
  /* Single-flight: jitne bhi callers wait karein, sheet read SIRF EK dafa.
     Har read par headers DOBARA parse hote hain — sheet me naya column
     add karo to wo khud-ba-khud (max ~1 min me) website par aa jata hai. */
  const p = (async () => {
    const leads = [];
    for (const info of tabsInfo) {
      const grid = await fetchTabRows(info.title);
      if (!grid.length) continue;

      const headers = grid[0].map(h => String(h).trim());
      const lower = headers.map(h => h.toLowerCase());
      while (lower.length && !lower[lower.length - 1]) lower.pop();

      /* canonical fields alias se match karo */
      const colMap = {};
      for (const [field, aliases] of Object.entries(ALIASES)) {
        colMap[field] = findCol(lower, aliases);
      }

      /* baqi SAB columns extra ke tor par utha lo (naye columns live) */
      const used = new Set(Object.values(colMap).filter(i => i >= 0));
      const extras = [];
      headers.forEach((name, idx) => {
        if (idx >= lower.length || !name) return;
        if (used.has(idx) || RESERVED_KEYS.has(name)) return;
        extras.push({ idx, name });
      });

      const shift = shiftLabel(info.title);

      for (let i = 1; i < grid.length; i++) {
        const arr = grid[i];
        if (!arr || arr.every(c => c == null || String(c).trim() === '')) continue;
        const v = c => (colMap[c] >= 0 && arr[colMap[c]] != null ? String(arr[colMap[c]]).trim() : '');
        const lead = {
          id: `${shift.replace(/\s/g, '')}-${i + 1}`,
          Name: v('Name'),
          Email: v('Email'),
          Phone: v('Phone'),
          LinkedIn: v('LinkedIn'),
          Status: v('Status'),
          Category: v('Category'),
          Website: v('Website'),
          Date: v('Date'),
          Shift: shift,
          Tab: info.title
        };
        for (const ex of extras) {
          lead[ex.name] = arr[ex.idx] != null ? String(arr[ex.idx]).trim() : '';
        }
        leads.push(lead);
      }
    }
    scrapeCache = { data: leads, at: Date.now() };
    return leads;
  })();
  return p.finally(() => { scrapeFetchPromise = null; });
}

async function listLeads(force = false) {
  if (!force && scrapeCache.data && Date.now() - scrapeCache.at < SCRAPE_TTL_MS) {
    return scrapeCache.data;
  }
  if (force) return fetchLeadsOnce();
  if (scrapeFetchPromise) return scrapeFetchPromise;
  scrapeFetchPromise = fetchLeadsOnce();
  return scrapeFetchPromise;
}

/* ---------- LINKEDIN TRACKER TAB ---------- */

async function resolveTrackerTab(m) {
  trackerTabTitle = (process.env.TRACKER_TAB || TRACKER_TAB_DEFAULT).trim();

  let found = m.sheets.find(s => s.properties.title === trackerTabTitle);
  if (!found) {
    await client.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: trackerTabTitle } } }] }
    });
    console.log(`[sheets] Created new tab (tracker only): "${trackerTabTitle}"`);
    found = (await meta()).sheets.find(s => s.properties.title === trackerTabTitle);
  }
  trackerNumericId = found.properties.sheetId;
}

async function ensureTrackerHeaders() {
  const res = await client.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${trackerTabTitle}!A1:${colLetter(TRACKER_HEADERS.length - 1)}1`
  });
  const row = res.data.values && res.data.values[0];
  if (!row || row.every(c => !c)) {
    await client.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${trackerTabTitle}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [TRACKER_HEADERS] }
    });
    trackerHeaders = TRACKER_HEADERS.map(h => h.toLowerCase());
  } else {
    trackerHeaders = row.map(h => String(h).trim().toLowerCase());
    for (const h of TRACKER_HEADERS) {
      if (!trackerHeaders.includes(h.toLowerCase())) {
        const idx = trackerHeaders.length;
        await client.spreadsheets.values.update({
          spreadsheetId: sheetId,
          range: `${trackerTabTitle}!${colLetter(idx)}1`,
          valueInputOption: 'RAW',
          requestBody: { values: [[h]] }
        });
        trackerHeaders.push(h.toLowerCase());
        console.log(`[sheets] Tracker column added: "${h}"`);
      }
    }
  }
}

/* Column map ACTUAL sheet layout se banta hai (ensureTrackerHeaders ke baad),
   kyunki purane tabs me naye columns end me append hote hain */
let T = {};
function rebuildTrackerMap() {
  T = Object.fromEntries(TRACKER_HEADERS.map(h => [h, trackerHeaders.indexOf(h.toLowerCase())]));
}

function tRowToLead(arr, rowNumber) {
  const v = idx => (idx >= 0 && arr[idx] != null ? String(arr[idx]).trim() : '');
  return {
    id: String(rowNumber),
    ID: String(v(T.ID) || rowNumber),
    Name: v(T.Name),
    Email: v(T.Email),
    LinkedIn: v(T['LinkedIn URL']),
    SCR: v(T.SCR),
    Followed: normYN(v(T.Followed)),
    Emailed: normYN(v(T.Emailed)),
    'Connection Sent': normYN(v(T['Connection Sent'])),
    Accepted: normYN(v(T.Accepted)),
    Notes: v(T.Notes),
    'Added By': v(T['Added By']),
    Date: v(T.Date)
  };
}

async function fetchTrackerGrid() {
  const res = await client.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${trackerTabTitle}!A1:${colLetter(trackerHeaders.length - 1)}`
  });
  return res.data.values || [];
}

async function nextTrackerId(grid) {
  let max = 0;
  for (let i = 1; i < grid.length; i++) {
    const n = parseInt(grid[i][T.ID], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

function fetchTrackerOnce() {
  const p = (async () => {
    const grid = await fetchTrackerGrid();
    const out = [];
    for (let i = 1; i < grid.length; i++) {
      const arr = grid[i];
      if (!arr || arr.every(c => c == null || String(c).trim() === '')) continue;
      out.push(tRowToLead(arr, i + 1));
    }
    trackerCache = { data: out, at: Date.now() };
    return out;
  })();
  return p.finally(() => { trackerFetchPromise = null; });
}

async function trackerList(force = false) {
  if (!force && trackerCache.data && Date.now() - trackerCache.at < TRACKER_TTL_MS) {
    return trackerCache.data;
  }
  if (force) return fetchTrackerOnce();
  if (trackerFetchPromise) return trackerFetchPromise;
  trackerFetchPromise = fetchTrackerOnce();
  return trackerFetchPromise;
}

function clearTrackerCache() { trackerCache = { data: null, at: 0 }; }

async function trackerAdd(dataIn) {
  const grid = await fetchTrackerGrid();
  const id = await nextTrackerId(grid);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16);

  const row = new Array(trackerHeaders.length).fill('');
  row[T.ID] = String(id);
  if (dataIn.Name != null) row[T.Name] = String(dataIn.Name);
  if (dataIn.Email != null) row[T.Email] = String(dataIn.Email);
  if (dataIn.LinkedIn != null) row[T['LinkedIn URL']] = String(dataIn.LinkedIn);
  if (dataIn.SCR != null) row[T.SCR] = String(dataIn.SCR);
  if (dataIn.Followed != null) row[T.Followed] = String(dataIn.Followed);
  if (dataIn.Emailed != null) row[T.Emailed] = String(dataIn.Emailed);
  if (dataIn['Connection Sent'] != null && T['Connection Sent'] >= 0) row[T['Connection Sent']] = String(dataIn['Connection Sent']);
  if (dataIn.Accepted != null && T.Accepted >= 0) row[T.Accepted] = String(dataIn.Accepted);
  if (dataIn.Notes != null) row[T.Notes] = String(dataIn.Notes);
  if (dataIn['Added By'] != null) row[T['Added By']] = String(dataIn['Added By']);
  row[T.Date] = now;

  await client.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${trackerTabTitle}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });

  clearTrackerCache();
  return { id: String(id), ID: String(id), ...dataIn, Date: now };
}

async function trackerUpdate(id, patch) {
  const rowNumber = parseInt(id, 10);
  if (!Number.isFinite(rowNumber) || rowNumber < 2) throw new Error('Invalid row');

  const data = [];
  const pairs = [
    ['Name', T.Name], ['Email', T.Email], ['LinkedIn', T['LinkedIn URL']], ['SCR', T.SCR],
    ['Followed', T.Followed], ['Emailed', T.Emailed],
    ['Connection Sent', T['Connection Sent']], ['Accepted', T.Accepted], ['Notes', T.Notes]
  ];
  for (const [field, col] of pairs) {
    if (patch[field] !== undefined && col >= 0) {
      data.push({ range: `${trackerTabTitle}!${colLetter(col)}${rowNumber}`, values: [[String(patch[field])]] });
    }
  }
  if (!data.length) throw new Error('Nothing to update');

  await client.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { valueInputOption: 'RAW', data }
  });
  clearTrackerCache();
  return { id: String(rowNumber), ...patch };
}

async function trackerDelete(id) {
  const rowNumber = parseInt(id, 10);
  if (!Number.isFinite(rowNumber) || rowNumber < 2) throw new Error('Invalid row');

  await client.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId: trackerNumericId, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber }
        }
      }]
    }
  });
  clearTrackerCache();
  return true;
}

/* ---------- DAILY OUTREACH LOG (_DailyLog tab) ---------- */
const DAILY_TAB = '_DailyLog';
const DAILY_HEADERS = ['ID', 'Date', 'Added By', 'Outreach Emails Sent', 'Emails Bounced', 'Follow Up Emails Sent', 'Follow Up Emails Bounced', 'Email Responses Autogenerated', 'Email Responses Genuine', 'LinkedIn Outreach', 'LinkedIn Responses'];
let dailyTabNumericId = null;
let dailyCache = { data: null, at: 0 };
let dailyFetchPromise = null;
const DAILY_TTL_MS = 60 * 1000;

async function ensureDailyTab() {
  let m = await meta();
  let found = m.sheets.find(s => s.properties.title === DAILY_TAB);
  if (!found) {
    await client.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: DAILY_TAB } } }] }
    });
    console.log(`[sheets] Tab created: "${DAILY_TAB}"`);
    m = await meta();
    found = m.sheets.find(s => s.properties.title === DAILY_TAB);
  }
  dailyTabNumericId = found.properties.sheetId;

  const headRes = await client.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${DAILY_TAB}!A1:${colLetter(DAILY_HEADERS.length - 1)}1`
  });
  const row = headRes.data.values && headRes.data.values[0];
  if (!row || row.every(c => !c)) {
    await client.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${DAILY_TAB}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [DAILY_HEADERS] }
    });
    console.log(`[sheets] Headers written: "${DAILY_TAB}"`);
  }
}

function dRowToEntry(arr) {
  const n = v => { const x = parseFloat(v); return Number.isFinite(x) && x > 0 ? Math.round(x) : 0; };
  return {
    id: String(arr[0] || ''),
    Date: String(arr[1] || ''),
    AddedBy: String(arr[2] || ''),
    sent: n(arr[3]),
    bounced: n(arr[4]),
    fuSent: n(arr[5]),
    fuBounced: n(arr[6]),
    respAuto: n(arr[7]),
    respGenuine: n(arr[8]),
    liOutreach: n(arr[9]),
    liResponses: n(arr[10])
  };
}

function fetchDailyOnce() {
  const p = (async () => {
    const res = await client.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${DAILY_TAB}!A1:${colLetter(DAILY_HEADERS.length - 1)}`
    });
    const grid = res.data.values || [];
    const out = [];
    for (let i = 1; i < grid.length; i++) {
      const arr = grid[i];
      if (!arr || arr.every(c => c == null || String(c).trim() === '')) continue;
      out.push(dRowToEntry(arr));
    }
    dailyCache = { data: out, at: Date.now() };
    return out;
  })();
  return p.finally(() => { dailyFetchPromise = null; });
}

async function dailyList(force = false) {
  if (!force && dailyCache.data && Date.now() - dailyCache.at < DAILY_TTL_MS) {
    return dailyCache.data;
  }
  if (force) return fetchDailyOnce();
  if (dailyFetchPromise) return dailyFetchPromise;
  dailyFetchPromise = fetchDailyOnce();
  return dailyFetchPromise;
}

function clearDailyCache() { dailyCache = { data: null, at: 0 }; }

async function nextDailyId() {
  const res = await client.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${DAILY_TAB}!A2:A` });
  let max = 0;
  for (const r of res.data.values || []) {
    const x = parseInt(r && r[0], 10);
    if (Number.isFinite(x) && x > max) max = x;
  }
  return max + 1;
}

async function dailyAdd(dataIn) {
  const id = await nextDailyId();
  const row = [
    String(id),
    String(dataIn.Date || ''),
    String(dataIn.AddedBy || ''),
    dataIn.sent || 0,
    dataIn.bounced || 0,
    dataIn.fuSent || 0,
    dataIn.fuBounced || 0,
    dataIn.respAuto || 0,
    dataIn.respGenuine || 0,
    dataIn.liOutreach || 0,
    dataIn.liResponses || 0
  ];
  await client.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${DAILY_TAB}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });
  clearDailyCache();
  return dRowToEntry(row);
}

async function dailyDelete(id) {
  const rowNumber = parseInt(id, 10);
  if (!Number.isFinite(rowNumber) || rowNumber < 2) throw new Error('Invalid row');
  await client.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId: dailyTabNumericId, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber }
        }
      }]
    }
  });
  clearDailyCache();
  return true;
}

/* ---------- INIT ---------- */

async function init() {
  lastInitError = null;

  const sid = (process.env.SHEET_ID || '').trim();
  const haveCredsFile = fs.existsSync(credPath());
  const haveCredsB64 = Boolean(credsObject());

  if (!sid || sid.includes('apni_sheet_id')) {
    lastInitError = 'SHEET_ID env var missing/invalid';
    return false;
  }
  if (!haveCredsFile && !haveCredsB64) {
    lastInitError = 'GOOGLE_CREDENTIALS_B64 env var missing ya base64 adhura hai';
    return false;
  }

  let google;
  try {
    google = require('googleapis').google;
  } catch {
    lastInitError = 'googleapis package not installed';
    return false;
  }

  try {
    const authOpts = { scopes: ['https://www.googleapis.com/auth/spreadsheets'] };
    const credsObj = credsObject();
    if (credsObj) authOpts.credentials = credsObj;
    else authOpts.keyFile = credPath();

    const auth = new google.auth.GoogleAuth(authOpts);
    sheetId = sid;
    client = google.sheets({ version: 'v4', auth });

    const m = await meta();
    await resolveTrackerTab(m);
    await resolveScrapeTabs(m);
    await ensureTrackerHeaders();
    rebuildTrackerMap();
    await ensureDailyTab();

    console.log('[sheets] READ-ONLY connect OK');
    console.log(`[sheets] Tracker tab ready: "${trackerTabTitle}"`);
    console.log(`[sheets] Daily log tab ready: "${DAILY_TAB}"`);
    return true;
  } catch (err) {
    lastInitError = err.message;
    throw err;
  }
}

/* cloudstore ke liye: connected client + sheetId, warnah null */
function getClient() {
  return client && sheetId ? { client, sheetId } : null;
}

module.exports = {
  name: 'google',
  init,
  getClient,
  getInitError: () => lastInitError,
  getTabs: () => tabsInfo.map(t => ({ title: t.title, shift: shiftLabel(t.title) })),
  listLeads,
  trackerList,
  trackerAdd,
  trackerUpdate,
  trackerDelete,
  dailyList,
  dailyAdd,
  dailyDelete
};
