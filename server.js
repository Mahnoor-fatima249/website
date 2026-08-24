/* LOCAL DEV RUNNER — puri app core.js me hai.
   Vercel ke liye api/index.js use hota hai (listen wahan Vercel khud karta hai). */
const os = require('os');
const { app, readyPromise, maybeArchive } = require('./core');
const users = require('./users');
const cloudstore = require('./cloudstore');

const PORT = process.env.PORT || 3001;

async function start() {
  const maxSeats = parseInt(process.env.MAX_USERS, 10) || 12;
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

  try { await readyPromise; } catch {}

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

  maybeArchive(true).catch(() => {});
  setInterval(() => maybeArchive(true).catch(() => {}), 60 * 60 * 1000); // har ghantay check
}

start();
