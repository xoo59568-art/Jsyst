"use strict";

// ═══════════════════════════════════════════════════════════════
//  NeuroBot Web — Express API + Baileys
//  
//  Endpoints:
//    POST /api/pair      { phone, imageBase64 }  → { pair_code }
//    GET  /api/status/:phone                     → { status, connected }
//    POST /api/cancel    { phone }               → { ok }
//    GET  /              → website
// ═══════════════════════════════════════════════════════════════

const express  = require("express");
const multer   = require("multer");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} = require("@whiskeysockets/baileys");
const { Jimp } = require("jimp");
const pino     = require("pino");
const path     = require("path");
const fs       = require("fs");
const https    = require("https");
const http     = require("http");

const app          = express();
const PORT         = process.env.PORT || 3000;
const SESSIONS_DIR = path.join(__dirname, "sessions");
const TEMP_DIR     = path.join(__dirname, "temp");
const PUBLIC_DIR   = path.join(__dirname, "public");

[SESSIONS_DIR, TEMP_DIR, PUBLIC_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

app.use(express.json({ limit: "20mb" }));
app.use(express.static(PUBLIC_DIR));

// multer for multipart uploads (optional)
const upload = multer({ dest: TEMP_DIR, limits: { fileSize: 10 * 1024 * 1024 } });

const sessions   = new Map(); // phone → shared
const inProgress = new Set();
const sleep      = ms => new Promise(r => setTimeout(r, ms));

// ─── helpers ──────────────────────────────────────────────────
function cleanDir(phone) {
  try {
    const d = path.join(SESSIONS_DIR, phone);
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  } catch (_) {}
}

function cleanTemp(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
}

// ─────────────────────────────────────────────────────────────
//  connectWA  — exact NeuroBot v7 logic
//  515 → new socket, SAME session dir (creds intact)
//  Only cleanDir at finish or fatal error
// ─────────────────────────────────────────────────────────────
async function connectWA(phone, photoPath, shared) {
  if (shared.connected || shared.finished) return;

  const dir = path.join(SESSIONS_DIR, phone);
  fs.mkdirSync(dir, { recursive: true });

  let authState, saveCreds;
  try {
    const a  = await useMultiFileAuthState(dir);
    authState = a.state;
    saveCreds = a.saveCreds;
  } catch (e) {
    console.error(`[${phone}] authState err: ${e.message}`);
    if (!shared._authRetried) {
      shared._authRetried = true;
      cleanDir(phone);
      fs.mkdirSync(dir, { recursive: true });
      await sleep(1000);
      return connectWA(phone, photoPath, shared);
    }
    return fatalErr(phone, shared, "Auth state load failed: " + e.message);
  }

  let version = [2, 3000, 1021022925];
  try {
    const v = await fetchLatestBaileysVersion();
    if (v && v.version) version = v.version;
  } catch (_) {}

  const logger = pino({ level: "silent" });

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds : authState.creds,
      keys  : makeCacheableSignalKeyStore(authState.keys, logger),
    },
    browser             : ["Windows", "Chrome", "121.0.6167.160"],
    printQRInTerminal   : false,
    syncFullHistory     : false,
    markOnlineOnConnect : false,
    connectTimeoutMs    : 60_000,
    keepAliveIntervalMs : 25_000,
  });

  shared.sock = sock;
  sock.ev.on("creds.update", saveCreds);

  let pairRequested = false;

  sock.ev.on("connection.update", async update => {
    const { connection, lastDisconnect } = update;
    const errCode = lastDisconnect?.error?.output?.statusCode;

    console.log(`[${phone}] ${connection || "?"} | errCode=${errCode || "-"} | connected=${shared.connected} | codeSent=${shared.codeSent}`);

    // ── connecting → pair code ─────────────────────────────────
    if (connection === "connecting" && !pairRequested && !shared.codeSent && !shared.connected && !shared.finished) {
      pairRequested = true;
      await sleep(4000);
      if (shared.connected || shared.finished || shared.codeSent) return;
      try {
        const raw  = await sock.requestPairingCode(phone);
        const code = raw.match(/.{1,4}/g).join("-");
        console.log(`[${phone}] PAIR CODE: ${code}`);
        if (!shared.codeSent) {
          shared.codeSent  = true;
          shared.pairCode  = code;
          shared.status    = "waiting_user";
          shared.resolve && shared.resolve(code);
        }
      } catch (e) {
        console.error(`[${phone}] pairCode err: ${e.message}`);
        pairRequested = false;
      }
    }

    // ── open → post connect ────────────────────────────────────
    if (connection === "open") {
      if (shared.connected || shared.finished) return;
      shared.connected = true;
      shared.status    = "connected";
      try { await saveCreds(); } catch (_) {}
      console.log(`[${phone}] OPEN — linked!`);
      runPostConnect(phone, photoPath, sock, shared).catch(e =>
        console.error(`[${phone}] postConnect err: ${e.message}`)
      );
    }

    // ── close ──────────────────────────────────────────────────
    if (connection === "close") {
      if (shared.finished) return;
      if (shared.connected) return;

      if (errCode === 515) {
        console.log(`[${phone}] 515 → new socket (dir kept)`);
        await sleep(1500);
        connectWA(phone, photoPath, shared);
        return;
      }
      if (errCode === 401 && !shared._401retried) {
        shared._401retried = true;
        console.log(`[${phone}] 401 → wipe + retry`);
        cleanDir(phone);
        await sleep(3000);
        connectWA(phone, photoPath, shared);
        return;
      }
      if (errCode === 401 || errCode === 403) {
        return fatalErr(phone, shared, `WA auth error (${errCode}) — Linked Devices me sab logout karo`);
      }
      console.log(`[${phone}] close ${errCode} → retry`);
      await sleep(2000);
      connectWA(phone, photoPath, shared);
    }
  });
}

// ─────────────────────────────────────────────────────────────
//  POST CONNECT — DP set
// ─────────────────────────────────────────────────────────────
async function runPostConnect(phone, photoPath, sock, shared) {
  const self = jidNormalizedUser(sock.user.id);
  shared.status = "setting_dp";
  console.log(`[${phone}] setting DP...`);
  await sleep(3000);

  let dpOk = false;

  // Method 1: Jimp + IQ query
  try {
    const image = await Jimp.read(photoPath);
    const buf   = await image.scaleToFit({ w: 720, h: 720 }).getBuffer("image/jpeg");
    await sock.query({
      tag    : "iq",
      attrs  : { to: "@s.whatsapp.net", type: "set", xmlns: "w:profile:picture" },
      content: [{ tag: "picture", attrs: { type: "image" }, content: buf }],
    });
    console.log(`[${phone}] DP Method 1 OK`);
    dpOk = true;
  } catch (e) {
    console.log(`[${phone}] DP Method 1 fail: ${e.message}`);
  }

  // Method 2: updateProfilePicture
  if (!dpOk) {
    try {
      await sock.updateProfilePicture(self, fs.readFileSync(photoPath));
      console.log(`[${phone}] DP Method 2 OK`);
      dpOk = true;
    } catch (e) {
      console.log(`[${phone}] DP Method 2 fail: ${e.message}`);
    }
  }

  shared.dpDone = dpOk;
  if (!dpOk) console.error(`[${phone}] DP FAILED both methods`);

  await sleep(2000);
  await doFinish(phone, sock, photoPath, shared);
}

// ─────────────────────────────────────────────────────────────
//  FINISH — logout + cleanup
// ─────────────────────────────────────────────────────────────
async function doFinish(phone, sock, photoPath, shared) {
  shared.finished = true;
  shared.status   = "done";
  sessions.delete(phone);

  console.log(`[${phone}] logging out...`);
  try {
    await Promise.race([sock.logout(), sleep(6000)]);
    console.log(`[${phone}] logged out`);
  } catch (e) {
    console.log(`[${phone}] logout err: ${e.message}`);
    try { sock.end(); } catch (_) {}
  }

  await sleep(500);
  cleanDir(phone);
  cleanTemp(photoPath);
  console.log(`[${phone}] === ALL DONE ===`);
}

function fatalErr(phone, shared, msg) {
  shared.finished = true;
  shared.status   = "error";
  shared.error    = msg;
  sessions.delete(phone);
  cleanDir(phone);
  if (!shared.codeSent) shared.reject && shared.reject(new Error(msg));
}

// ═══════════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════════

// POST /api/pair  — { phone, imageBase64 }
app.post("/api/pair", async (req, res) => {
  const { phone: rawPhone, imageBase64 } = req.body;

  if (!rawPhone || !imageBase64)
    return res.status(400).json({ success: false, error: "phone aur imageBase64 chahiye" });

  const phone = String(rawPhone).replace(/\D/g, "");
  if (phone.length < 7 || phone.length > 15)
    return res.status(400).json({ success: false, error: "Invalid phone number" });

  if (inProgress.has(phone))
    return res.status(429).json({ success: false, error: "Already processing — thoda ruko" });

  inProgress.add(phone);

  // Save base64 image to temp
  const photoPath = path.join(TEMP_DIR, phone + "_upload.jpg");
  try {
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    fs.writeFileSync(photoPath, Buffer.from(base64Data, "base64"));
  } catch (e) {
    inProgress.delete(phone);
    return res.status(400).json({ success: false, error: "Image save failed: " + e.message });
  }

  // Kill old session
  const old = sessions.get(phone);
  if (old) {
    old.finished = true;
    try { old.sock && old.sock.end(); } catch (_) {}
    sessions.delete(phone);
  }
  cleanDir(phone);
  fs.mkdirSync(path.join(SESSIONS_DIR, phone), { recursive: true });

  const shared = {
    sock         : null,
    codeSent     : false,
    pairCode     : null,
    connected    : false,
    finished     : false,
    dpDone       : false,
    status       : "connecting",  // connecting → waiting_user → connected → setting_dp → done/error
    error        : null,
    _authRetried : false,
    _401retried  : false,
    resolve      : null,
    reject       : null,
  };
  sessions.set(phone, shared);

  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!shared.connected) {
          shared.finished = true;
          shared.status   = "error";
          shared.error    = "Timeout";
          sessions.delete(phone);
          cleanDir(phone);
          reject(new Error("Timeout: 35s me pair code nahi mila"));
        }
      }, 35000);
      shared.resolve = code => { clearTimeout(timer); resolve(code); };
      shared.reject  = err  => { clearTimeout(timer); reject(err);  };
      connectWA(phone, photoPath, shared);
    });

    inProgress.delete(phone);
    return res.json({ success: true, pair_code: code, phone: "+" + phone });

  } catch (e) {
    inProgress.delete(phone);
    cleanTemp(photoPath);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/status/:phone
app.get("/api/status/:phone", (req, res) => {
  const phone  = String(req.params.phone).replace(/\D/g, "");
  const shared = sessions.get(phone);
  if (!shared) return res.json({ status: "idle", phone });
  return res.json({
    status    : shared.status,
    connected : shared.connected,
    finished  : shared.finished,
    dpDone    : shared.dpDone,
    error     : shared.error,
    phone,
  });
});

// POST /api/cancel
app.post("/api/cancel", (req, res) => {
  const phone  = String(req.body.phone || "").replace(/\D/g, "");
  const shared = sessions.get(phone);
  if (shared) {
    shared.finished = true;
    shared.status   = "cancelled";
    try { shared.sock && shared.sock.end(); } catch (_) {}
    sessions.delete(phone);
    cleanDir(phone);
    inProgress.delete(phone);
  }
  res.json({ ok: true });
});

// ─── start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 NeuroBot Web on port ${PORT}`);
  console.log(`🌐 http://localhost:${PORT}\n`);
});

process.on("uncaughtException",  e => console.error("[uncaughtException]",  e?.message ?? e));
process.on("unhandledRejection", e => console.error("[unhandledRejection]", e?.message ?? e));
