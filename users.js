const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const cloudstore = require('./cloudstore');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.txt');

function maxUsers() {
  const n = parseInt(process.env.MAX_USERS, 10);
  return Number.isFinite(n) && n > 0 ? n : 12;
}

function ensureDataDir() {
  /* Vercel jaise read-only FS par mkdir fail ho sakta hai — crash na kare */
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}

function readLocalUsers() {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeLocalUsers(users) {
  try {
    ensureDataDir();
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.warn('[users] File write skip (read-only FS?):', err.message);
  }
}

/* Cloud (sheet ke _Users tab) available ho to wahan se, warnah local file */
async function loadUsers() {
  if (cloudstore.available()) {
    try {
      return await cloudstore.getUsers();
    } catch (err) {
      console.warn('[users] Cloud read fail — file fallback:', err.message);
    }
  }
  return readLocalUsers();
}

async function saveUsers(users) {
  if (cloudstore.available()) {
    await cloudstore.saveUsers(users);
    return;
  }
  writeLocalUsers(users);
}

/* File-only users ko ek dafa cloud (_Users tab) me push karo
   (migration: Mahnoor + Sana jo pehle data/users.json me the) */
async function syncCloud() {
  if (!cloudstore.available()) return false;
  const cloud = await cloudstore.getUsers();
  const local = readLocalUsers();
  let added = 0;
  for (const u of local) {
    if (u && u.username && u.hash &&
        !cloud.some(c => String(c.username).toLowerCase() === String(u.username).toLowerCase())) {
      cloud.push({ username: u.username, hash: u.hash, createdAt: u.createdAt || new Date().toISOString() });
      added++;
    }
  }
  if (added) {
    await cloudstore.saveUsers(cloud);
    console.log(`[users] ${added} user(s) file se sheet (_Users tab) me migrate ho gaye`);
  }
  return true;
}

/* SESSION_SECRET env (cloud) → data/secret.txt (local) → deterministic
   fallback (serverless cold-starts ke darmiyan stable rehta hai) */
function getSessionSecret() {
  const envSecret = (process.env.SESSION_SECRET || '').trim();
  if (envSecret) return envSecret;
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (s) return s;
  } catch {}
  const seed = ['lead-manager', process.env.SHEET_ID || '', (process.env.GOOGLE_CREDENTIALS_B64 || '').slice(0, 80)].join('|');
  const secret = crypto.createHash('sha256').update(seed).digest('hex');
  try { ensureDataDir(); fs.writeFileSync(SECRET_FILE, secret); } catch {}
  return secret;
}

async function status() {
  const users = await loadUsers();
  return {
    max: maxUsers(),
    registered: users.length,
    slotsLeft: Math.max(0, maxUsers() - users.length),
    full: users.length >= maxUsers()
  };
}

async function register(username, password) {
  username = String(username || '').trim();
  password = String(password || '');

  if (username.length < 3) throw new Error('Username must be at least 3 characters');
  if (!/^[\w.\- ]+$/.test(username)) throw new Error('Username can only contain letters, numbers, spaces and . _ -');
  if (password.length < 4) throw new Error('Password must be at least 4 characters');

  const users = await loadUsers();
  if (users.length >= maxUsers()) {
    throw new Error(`Sorry! All ${maxUsers()} seats are full. New accounts are not allowed.`);
  }
  if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    throw new Error('This username is already taken. Please choose another.');
  }

  const hash = await bcrypt.hash(password, 10);
  users.push({
    username,
    hash,
    createdAt: new Date().toISOString()
  });
  await saveUsers(users);
  return { username };
}

async function login(username, password) {
  username = String(username || '').trim();
  password = String(password || '');
  const users = await loadUsers();
  const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) throw new Error('Wrong username or password');
  const ok = await bcrypt.compare(password, user.hash);
  if (!ok) throw new Error('Wrong username or password');
  return { username: user.username };
}

module.exports = { status, register, login, getSessionSecret, syncCloud };
