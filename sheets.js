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

let tabsInfo = [];          // [{title, colMap}]
let scrapeCache = { data: null, at: 0 };
const SCRAPE_TTL_MS = 15000;

let trackerTabTitle = null;
let trackerNumericId = null;
let trackerHeaders = [];
let trackerCache = { data: null, at: 0 };
const TRACKER_TTL_MS = 10000;

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

function configured() {
  const sid = (process.env.SHEET_ID || '').trim();
  const hasCreds = fs.existsSync(credPath()) || Boolean(credsObject());
  return Boolean(sid && !sid.includes('apni_sheet_id') && hasCreds);
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
  return 'Other';
}

/* ---------- SCRAPE TABS (READ-ONLY) ---------- */

async function resolveScrapeTabs(m) {
  const raw = (process.env.SCRAPE_TABS || '').trim();
  let wanted = raw ? raw.split(',').map(t => t.trim()).filter(Boolean) : [];

  if (wanted.length) {
    for (const want of wanted) {
      const found = m.sheets.find(s => s.properties.title.trim().toLowerCase() === want.toLowerCase());
      if (found) {
        tabsInfo.push({ title: found.properties.title, colMap: {} });
      } else {
        console.warn(`[sheets] Tab "${want}" nahi mila — skip`);
      }
    }
  }

  // fallback: koi config nahi to pehla non-tracker tab
  if (!tabsInfo.length) {
    const first = m.sheets.find(s => s.properties.title !== trackerTabTitle);
    if (!first) throw new Error('Spreadsheet has no tabs');
    tabsInfo.push({ title: first.properties.title, colMap: {} });
    console.warn(`[sheets] SCRAPE_TABS set nahi tha — pehla tab "${first.properties.title}" use ho raha hai`);
  }

  console.log('[sheets] Reading tabs: ' + tabsInfo.map(t => `"${t.title}"`).join(', '));
}

async function buildScrapeMaps() {
  for (const info of tabsInfo) {
    const res = await client.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${info.title}!1:1` });
    const headers = ((res.data.values && res.data.values[0]) || []).map(h => String(h).trim().toLowerCase());
    while (headers.length && !headers[headers.length - 1]) headers.pop();

    info.colMap = {};
    for (const [field, aliases] of Object.entries(ALIASES)) {
      info.colMap[field] = findCol(headers, aliases);
    }
  }
}

async function fetchTabRows(title, minCols) {
  /* lastColIdx INCLUSIVE hai: Status col 27 (AA) me bhi ho to parha jaye */
  const lastColIdx = Math.max(minCols, 25);
  const res = await client.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${title}!A1:${colLetter(lastColIdx)}`
  });
  return res.data.values || [];
}

async function listLeads(force = false) {
  if (!force && scrapeCache.data && Date.now() - scrapeCache.at < SCRAPE_TTL_MS) {
    return scrapeCache.data;
  }

  const leads = [];
  for (const info of tabsInfo) {
    const maxCol = Math.max(...Object.values(info.colMap), 10);
    const grid = await fetchTabRows(info.title, maxCol);
    const shift = shiftLabel(info.title);

    for (let i = 1; i < grid.length; i++) {
      const arr = grid[i];
      if (!arr || arr.every(c => c == null || String(c).trim() === '')) continue;
      const v = c => (info.colMap[c] >= 0 && arr[info.colMap[c]] != null ? String(arr[info.colMap[c]]).trim() : '');
      leads.push({
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
      });
    }
  }

  scrapeCache = { data: leads, at: Date.now() };
  return leads;
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

async function trackerList(force = false) {
  if (!force && trackerCache.data && Date.now() - trackerCache.at < TRACKER_TTL_MS) {
    return trackerCache.data;
  }
  const grid = await fetchTrackerGrid();
  const out = [];
  for (let i = 1; i < grid.length; i++) {
    const arr = grid[i];
    if (!arr || arr.every(c => c == null || String(c).trim() === '')) continue;
    out.push(tRowToLead(arr, i + 1));
  }
  trackerCache = { data: out, at: Date.now() };
  return out;
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

/* ---------- INIT ---------- */

async function init() {
  if (!configured()) return false;

  let google;
  try {
    google = require('googleapis').google;
  } catch {
    console.warn('[sheets] googleapis package not installed');
    return false;
  }

  const authOpts = { scopes: ['https://www.googleapis.com/auth/spreadsheets'] };
  const credsObj = credsObject();
  if (credsObj) authOpts.credentials = credsObj;
  else authOpts.keyFile = credPath();

  const auth = new google.auth.GoogleAuth(authOpts);
  sheetId = process.env.SHEET_ID.trim();
  client = google.sheets({ version: 'v4', auth });

  const m = await meta();
  await resolveTrackerTab(m);
  await resolveScrapeTabs(m);
  await buildScrapeMaps();
  await ensureTrackerHeaders();
  rebuildTrackerMap();

  console.log('[sheets] READ-ONLY connect OK');
  console.log(`[sheets] Tracker tab ready: "${trackerTabTitle}"`);
  return true;
}

/* cloudstore ke liye: connected client + sheetId, warnah null */
function getClient() {
  return client && sheetId ? { client, sheetId } : null;
}

module.exports = {
  name: 'google',
  init,
  getClient,
  getTabs: () => tabsInfo.map(t => ({ title: t.title, shift: shiftLabel(t.title) })),
  listLeads,
  trackerList,
  trackerAdd,
  trackerUpdate,
  trackerDelete
};
