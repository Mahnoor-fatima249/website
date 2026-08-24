const fs = require('fs');
const path = require('path');

/* Jab Google Sheet connect nahi hoti, tracker ka data local file me
   save hota hai (data/tracker.json). Scraped leads local mode me
   khali aate hain kyunki wo sirf sheet se hi aa sakte hain. */

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'tracker.json');

function ensureDir() {
  /* Read-only FS (Vercel) par mkdir fail ho sakta hai — crash na kare */
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}

function load() {
  ensureDir();
  try {
    const db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (db && Array.isArray(db.leads)) return db;
  } catch {}
  return { seq: 0, leads: [] };
}

function save(db) {
  try {
    ensureDir();
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.warn('[localstore] File write skip (read-only FS?):', err.message);
  }
}

async function listLeads() {
  return [];
}

async function trackerList() {
  return load().leads;
}

async function trackerAdd(dataIn) {
  const db = load();
  db.seq = (db.seq || 0) + 1;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const lead = {
    id: String(db.seq),
    ID: String(db.seq),
    Name: dataIn.Name || '',
    Email: dataIn.Email || '',
    LinkedIn: dataIn.LinkedIn || '',
    SCR: dataIn.SCR || '',
    Followed: dataIn.Followed || 'No',
    Emailed: dataIn.Emailed || 'No',
    'Connection Sent': dataIn['Connection Sent'] || 'No',
    Accepted: dataIn.Accepted || 'No',
    Notes: dataIn.Notes || '',
    'Added By': dataIn['Added By'] || '',
    Date: now
  };
  db.leads.push(lead);
  save(db);
  return lead;
}

async function trackerUpdate(id, patch) {
  const db = load();
  const idx = db.leads.findIndex(l => String(l.id) === String(id));
  if (idx === -1) throw new Error('Entry nahi mili');
  const merged = { ...db.leads[idx], ...patch };
  delete merged._tmp;
  db.leads[idx] = merged;
  save(db);
  return merged;
}

async function trackerDelete(id) {
  const db = load();
  const before = db.leads.length;
  db.leads = db.leads.filter(l => String(l.id) !== String(id));
  if (db.leads.length === before) throw new Error('Entry nahi mili');
  save(db);
  return true;
}

async function dailyList() {
  return load().daily || [];
}

async function dailyAdd(d) {
  const db = load();
  db.seq = (db.seq || 0) + 1;
  db.daily = db.daily || [];
  const entry = { id: String(db.seq), ...d };
  db.daily.push(entry);
  save(db);
  return entry;
}

async function dailyUpdate(id, patch) {
  const db = load();
  db.daily = db.daily || [];
  const idx = db.daily.findIndex(x => String(x.id) === String(id));
  if (idx === -1) throw new Error('Entry nahi mili');
  const merged = { ...db.daily[idx], ...patch };
  delete merged.AddedBy; /* malik nahi badalta */
  db.daily[idx] = merged;
  save(db);
  return merged;
}

async function dailyDelete(id) {
  const db = load();
  db.daily = db.daily || [];
  const before = db.daily.length;
  db.daily = db.daily.filter(x => String(x.id) !== String(id));
  if (db.daily.length === before) throw new Error('Entry nahi mili');
  save(db);
  return true;
}

module.exports = { name: 'local', init: async () => false, listLeads, trackerList, trackerAdd, trackerUpdate, trackerDelete, dailyList, dailyAdd, dailyUpdate, dailyDelete };
