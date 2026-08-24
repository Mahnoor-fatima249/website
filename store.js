const sheets = require('./sheets');
const localStore = require('./localstore');

let backend = localStore;
let modeName = 'local';

async function init() {
  try {
    const ok = await sheets.init();
    if (ok) {
      backend = sheets;
      modeName = 'google';
      console.log('[storage] Google Sheets connected — scraped data READ-ONLY hai, tracker alag tab me save hoga');
      return;
    }
    console.log('[storage] Google Sheets setup nahi hua — Local mode (tracker data data/tracker.json me)');
  } catch (err) {
    console.warn('[storage] Google Sheets connect nahi hua:', err.message);
    console.log('[storage] Local mode use ho raha hai. Tracker ka data local file me save hoga.');
  }
}

function mode() {
  return modeName;
}

module.exports = {
  init,
  mode,
  getInitError: () => (sheets.getInitError ? sheets.getInitError() : null),
  getTabs: () => (backend.getTabs ? backend.getTabs() : []),
  listLeads: (...a) => backend.listLeads(...a),
  trackerList: (...a) => backend.trackerList(...a),
  trackerAdd: (...a) => backend.trackerAdd(...a),
  trackerUpdate: (...a) => backend.trackerUpdate(...a),
  trackerDelete: (...a) => backend.trackerDelete(...a),
  dailyList: (...a) => backend.dailyList ? backend.dailyList(...a) : [],
  dailyAdd: (...a) => backend.dailyAdd(...a),
  dailyUpdate: (...a) => backend.dailyUpdate ? backend.dailyUpdate(...a) : (() => { throw new Error('Not supported'); })(),
  dailyDelete: (...a) => backend.dailyDelete(...a)
};
