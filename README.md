# NeuroBot Web — WhatsApp Pairing Tool

## Local Setup

```bash
npm install
npm start
# → http://localhost:3000
```

---

## Hosting Guide

### Render (Free — Recommended)
1. GitHub pe push karo
2. [render.com](https://render.com) → New → Web Service
3. Repo connect karo
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Environment:** Node
5. Deploy → URL milega

### Railway
1. [railway.app](https://railway.app) → New Project → Deploy from GitHub
2. Repo select karo
3. Auto detect Node.js — deploy hoga
4. Settings → Domain generate karo

### Koyeb
1. [koyeb.com](https://koyeb.com) → Create App → GitHub
2. Repo + branch select
3. **Run command:** `node server.js`
4. **Port:** 3000
5. Deploy

### Heroku
```bash
# Heroku CLI install karo
heroku login
heroku create your-app-name
git push heroku main
heroku open
```

### VPS / Panel (cPanel, DirectAdmin, Plesk)
```bash
# SSH se connect karo
git clone https://github.com/youruser/neurobot-web
cd neurobot-web
npm install

# PM2 se run karo (forever running)
npm install -g pm2
pm2 start server.js --name neurobot
pm2 save
pm2 startup
```

### Termux (Android)
```bash
pkg install nodejs git
git clone https://github.com/youruser/neurobot-web
cd neurobot-web
npm install
node server.js
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | Server port |

---

## API Endpoints

| Method | URL | Body | Response |
|--------|-----|------|----------|
| POST | `/api/pair` | `{ phone, imageBase64 }` | `{ success, pair_code }` |
| GET  | `/api/status/:phone` | — | `{ status, connected, dpDone }` |
| POST | `/api/cancel` | `{ phone }` | `{ ok }` |

### Status values
- `connecting` — socket ban raha hai
- `waiting_user` — pair code mila, user ka wait
- `connected` — device linked
- `setting_dp` — DP set ho rahi hai
- `done` — sab complete, logout + cleanup
- `error` — error hua
- `cancelled` — user ne cancel kiya

---

## Flow

```
User → Photo upload + Number enter
  ↓
POST /api/pair → Baileys socket → pair code
  ↓
Website pe code show hota hai
  ↓
User WhatsApp me code enter karta hai → device link
  ↓
/api/status poll → connected → setting_dp → done
  ↓
DP change → Logout → Session delete → Temp image delete
```
