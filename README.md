# Lead Manager Website (Google Sheet Connected — READ-ONLY)

Ye website aapki **scraper wali Google Sheet** se data parhti hai aur team ka LinkedIn work track karti hai.

## Sab se zaroori baat: Sheet 100% SAFE hai

- Website sheet ka data **sirf PARHTI hai** (read-only). Kuch bhi delete, edit ya overwrite nahi karti.
- Aapka scraper apne kaam me kisi tarah disturb nahi hoga.
- LinkedIn Tracker ki manual entries ek **alag naye tab** ("LinkedIn Tracker") me save hoti hain jo sirf website use karti hai.

---

## Pages

| Page | Kaam |
|---|---|
| **Overview** | Total leads, unique emails, duplicate rows, Day/Night shift counts, Top Categories, duplicate emails ki list, **scraped date range** (kis date se kis date tak scrape hua) |
| **Leads** | Saari leads ka table — search + status filter + **shift filter (Day/Night)** + pagination. Sirf dekhne ke liye |
| **LinkedIn** | Manual entries: naam, LinkedIn URL, **SCR score**, followed/emailed, notes. Save se pehle "Are you sure?" confirm aata hai |
| **Report** | **"Weekly Report — Nexe Agent"** style report: Total Leads, Total Sent Mails, Duplicate Emails, LinkedIn + kitni sent / kitni pending. Print/PDF perfect layout me aata hai |

## Weekly Reports (Auto)

- Har week apni **scraped date** ke hisaab se khud ban jata hai (Monday – Sunday).
- Week khatam hone par uski report **khud archive** ho jati hai (`data/weekly-reports.json`).
- Report page pe **Weekly Breakdown** table me har week dikhta hai: total, sent, pending, duplicates, LinkedIn added.
- Har week ke sath **Print** button hai — print me sirf saaf saaf ye likha aata hai:
  `WEEKLY REPORT` → `NEXE AGENT` → dates → Total Leads / Sent / Duplicates / LinkedIn → summary.

Login: limited seats (default **12**, `.env`/ENV me `MAX_USERS` se control hota hai). Pehle aane wale apna account khud bana lete hain, seats full hone par registration band.

---

## 🚀 FREE VERCEL DEPLOYMENT (10–12 log ke liye)

Website **Node.js** me hi Vercel par free chalti hai — Python ki zaroorat nahi.
Data kahin local file me nahi rehta: users, tracker aur weekly archive sab
**Google Sheet ke hidden tabs** (`_Users`, `_WeeklyReports`, `LinkedIn Tracker`)
me save hote hain, is liye serverless par bhi sab safe rehta hai.

### Step 1 — Code GitHub par dalein
```
git add .
git commit -m "Vercel deploy"
git push
```
(`.env`, `credentials/`, `data/` folder push na karein — ye secrets hain.)

### Step 2 — Vercel par import karein
1. https://vercel.com → GitHub se login → **Add New → Project**
2. Ye repository import karein (framework: **Other**)
3. **Environment Variables** me ye add karein:

| Key | Value |
|---|---|
| `SHEET_ID` | Apni sheet ki ID (URL wali) |
| `SCRAPE_TABS` | `nexe-agent day time august,nexe-agent night time august` |
| `TRACKER_TAB` | `LinkedIn Tracker` |
| `MAX_USERS` | `12` |
| `GOOGLE_CREDENTIALS_B64` | Service-account JSON ka base64 (`credentials/env-values.txt` me ready hai) |
| `SESSION_SECRET` | Koi lamba random text (e.g. 40+ characters) |

4. **Deploy** dabayein — 1-2 minute me website live: `https://aapka-project.vercel.app`

### Notes
- Local jaisa hi chalta rahega: `START WEBSITE.bat` / `node server.js`.
- Vercel par har naya scrape tab `.env` ki tarah **Vercel env** me `SCRAPE_TABS` update kar ke **Redeploy** karna hota hai (server restart ki zaroorat nahi).
- Free tier (Hobby) 10–12 users ke liye kaafi hai; limits me rehne ke liye live-sync 30 sec par hai.

---

## Chalane Ka Tareeqa

**Aasan tareeqa:** Project folder me **`START WEBSITE.bat`** double-click karein.
Ek black window khulegi (ye server hai — isay band na karein jab tak website use karni hai).

Browser: **http://localhost:3001**

Ya manually:
```
cd "D:\Website google sheets"
node server.js
```

Sheet connect na ho to bhi website chalti hai — tracker tab ka data local file
(`data/tracker.json`) me save hota hai, aur Overview/Leads khali aate hain.

---

## Google Sheet Connect Karna

Aapke paas scraper ke sath service account ka JSON already hai:

1. Wo JSON file copy kar ke is folder me rakhein:
   ```
   D:\Website google sheets\credentials\service-account.json
   ```
   (Agar naam alag hai to `.env` me `GOOGLE_CREDENTIALS=./credentials/uska-naam.json` kar dein)

2. Check karein ke us service account email ke paas sheet ka **Editor** access hai
   (scraper already likh raha hai to access hoga hi).

3. `.env` me ye already set hain:
   ```
   SHEET_ID=13FSqS4cLplGjg9qUNtQzVUodsfeH_LrGZ6r46QR4uhU
   SCRAPE_TABS=nexe-agent day time august,nexe-agent night time august
   TRACKER_TAB=LinkedIn Tracker
   ```
   - `SCRAPE_TABS` = comma-separated tabs jo website parhegi. Abhi sirf **day** aur
     **night wale august tabs** parhe rahe hain — Overview/Leads mein yehi data aata hai.
     Naya month aaye to yahan tab ka naam add kar dein aur server restart karein.
   - `TRACKER_TAB` = naya tab jisme sirf LinkedIn tracker ki entries jayengi

4. Server restart: `Ctrl+C` phir `node server.js` (ya `START WEBSITE.bat`)
   Console me ye lines aani chahiye:
   ```
   [sheets] READ-ONLY connect ✓  Tabs: "nexe-agent day time august", "nexe-agent night time august"
   [sheets] Tracker tab ready: "LinkedIn Tracker"
   ```

> Note: Pehli dafa connect hone par ek NAYA khali tab banega jiska naam
> "LinkedIn Tracker" hoga. Baqi tabs/data ko kuch nahi hota.

---

## Live Connection (Live Sync)

- Website sheet se **har 60 second** baad khud refresh karti hai (Google free quota ke andar rehne ke liye).
- Scraper sheet me naya lead dalta hai → thori dair me website pe nazar aa jata hai.
- Row delete hogi to website se bhi gayab ho jayegi.
- Upar right corner **"LIVE" badge** aur "Updated HH:MM:SS" time iska proof hai.
- Manual refresh ke liye har page pe Refresh button bhi hai.

---

## Zaroori Files

| File/Folder | Kaam |
|---|---|
| `server.js` + `core.js` | Website ka server (core = puri app, Vercel bhi yehi use karta hai) |
| `api/index.js` + `vercel.json` | Vercel serverless entry + config |
| `public/` | Design (HTML/CSS/JS) |
| `sheets.js` | Google Sheet connector (scraped = read-only, tracker = alag tab) |
| `data/users.json` | 4 logon ke usernames + encrypted passwords |
| `data/tracker.json` | Local mode me tracker ka data |
| `credentials/service-account.json` | Google key file (kisi ko na dein!) |
| `.env` | Settings |

---

## Common Problems

**"Port already in use" / "EADDRINUSE"** → `.env` me port badlein (`PORT=3002`).

**Overview/Leads khali aa rahe hain** → Sheet connect nahi hui. Upar wale steps check karein.
Yellow banner bhi website pe nazar aayega.

**"Google Sheets connect nahi hua"** →
1. JSON file `credentials` folder me sahi naam se hai?
2. Service account ko sheet ka Editor access hai?
3. `.env` ka SHEET_ID sahi hai?

**Tracker reset karna hai** → Local mode me: `data/tracker.json` delete karein.
Google mode me: "LinkedIn Tracker" tab ki rows delete karein (ye tab aapka hai, scraper ka nahi).

---

## Security Notes

- Passwords bcrypt se encrypted save hote hain.
- `service-account.json` aur `.env` kisi ke sath share na karein.
