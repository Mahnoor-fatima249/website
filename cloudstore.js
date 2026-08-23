const sheets = require('./sheets');

/* ------------------------------------------------------------------
   CLOUD-SAFE STORAGE (Render jaise host ke liye — disk ephemeral hoti hai)
   Users + weekly archive Google Sheet ke 2 HIDDEN tabs me rehte hain:
     _Users          → Username | Hash | CreatedAt   (bcrypt hashes safe)
     _WeeklyReports  → Key | From | To | Label | TotalLeads | Sent |
                       Pending | Duplicates | LinkedIn | ArchivedAt
   Tabs auto-create + auto-HIDE hote hain. Scrape tabs env me sirf
   day/night tabs listed hain, is liye scraper in tabs ko ignore karta hai.
------------------------------------------------------------------ */

const USERS_TAB = '_Users';
const ARCHIVE_TAB = '_WeeklyReports';

const USERS_HEADERS = ['Username', 'Hash', 'CreatedAt'];
const ARCHIVE_HEADERS = ['Key', 'From', 'To', 'Label', 'TotalLeads', 'Sent', 'Pending', 'Duplicates', 'LinkedIn', 'ArchivedAt'];

let client = null;
let sheetId = null;
let ready = false;

function colLetter(n) {
  let s = '';
  let x = n;
  while (x >= 0) {
    s = String.fromCharCode(65 + (x % 26)) + s;
    x = Math.floor(x / 26) - 1;
  }
  return s;
}

async function getMeta() {
  const res = await client.spreadsheets.get({ spreadsheetId: sheetId });
  return res.data;
}

/* Tab dhoondo; naya banao; headers likho; hidden karo */
async function ensureTab(title, headers) {
  let meta = await getMeta();
  let found = meta.sheets.find(s => s.properties.title === title);

  if (!found) {
    await client.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] }
    });
    console.log(`[cloud] Tab created: "${title}"`);
    meta = await getMeta();
    found = meta.sheets.find(s => s.properties.title === title);
  }

  const range = `${title}!A1:${colLetter(headers.length - 1)}1`;
  const res = await client.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  const row = res.data.values && res.data.values[0];
  if (!row || row.every(c => !c)) {
    await client.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${title}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] }
    });
    console.log(`[cloud] Headers written: "${title}"`);
  }

  if (!found.properties.hidden) {
    await client.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{
          updateSheetProperties: {
            properties: { sheetId: found.properties.sheetId, hidden: true },
            fields: 'hidden'
          }
        }]
      }
    });
    console.log(`[cloud] Tab hidden: "${title}"`);
  }

  return found.properties.sheetId;
}

async function init() {
  const c = sheets.getClient();
  if (!c) return false;
  client = c.client;
  sheetId = c.sheetId;

  await ensureTab(USERS_TAB, USERS_HEADERS);
  await ensureTab(ARCHIVE_TAB, ARCHIVE_HEADERS);

  ready = true;
  console.log('[cloud] Sheet-backed storage ready ("_Users" + "_WeeklyReports" hidden tabs)');
  return true;
}

function available() {
  return ready;
}

async function readGrid(title, width) {
  const res = await client.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${title}!A1:${colLetter(width - 1)}`
  });
  return res.data.values || [];
}

/* Header row (row 1) bacha kar sab data replace karo */
async function rewriteTab(title, rows) {
  await client.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: `${title}!A2:ZZ`
  });
  if (rows.length) {
    await client.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${title}!A2`,
      valueInputOption: 'RAW',
      requestBody: { values: rows }
    });
  }
}

/* ---------- USERS ---------- */

async function getUsers() {
  const grid = await readGrid(USERS_TAB, USERS_HEADERS.length);
  const out = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    if (!r || !r[0]) continue;
    out.push({
      username: String(r[0]).trim(),
      hash: String(r[1] || ''),
      createdAt: String(r[2] || '')
    });
  }
  return out;
}

async function saveUsers(users) {
  const rows = users.map(u => [
    u.username,
    u.hash,
    u.createdAt || new Date().toISOString()
  ]);
  await rewriteTab(USERS_TAB, rows);
}

/* ---------- WEEKLY ARCHIVE ---------- */

async function getArchive() {
  const grid = await readGrid(ARCHIVE_TAB, ARCHIVE_HEADERS.length);
  const out = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    if (!r || !r[0]) continue;
    out.push({
      key: String(r[0]),
      from: String(r[1] || ''),
      to: String(r[2] || ''),
      label: String(r[3] || ''),
      total: Number(r[4]) || 0,
      sent: Number(r[5]) || 0,
      pending: Number(r[6]) || 0,
      duplicates: Number(r[7]) || 0,
      linkedin: Number(r[8]) || 0,
      archivedAt: String(r[9] || '')
    });
  }
  out.sort((a, b) => b.key.localeCompare(a.key));
  return out;
}

async function saveArchive(archive) {
  const rows = archive.map(w => [
    w.key,
    w.from || '',
    w.to || '',
    w.label || '',
    w.total || 0,
    w.sent || 0,
    w.pending || 0,
    w.duplicates || 0,
    w.linkedin || 0,
    w.archivedAt || new Date().toISOString()
  ]);
  await rewriteTab(ARCHIVE_TAB, rows);
}

module.exports = { init, available, getUsers, saveUsers, getArchive, saveArchive };
