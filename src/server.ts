/* ─────────────────────────────────────────────
   DevJavu — Server
   Pluggable storage: Google Drive OR local JSON
   Designed for cloud deploy (Render/Railway/Fly)
   ───────────────────────────────────────────── */

import express, { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { URL } from "node:url";

/* ── Config ───────────────────────────────── */

const PORT = parseInt(process.env.PORT || "3002", 10);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = path.join(process.cwd(), "data");
const LOCAL_FILE = path.join(DATA_DIR, "log.json");
const TOKENS_FILE = path.join(DATA_DIR, "tokens.json");

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
const STORAGE_MODE = (process.env.STORAGE_MODE || "local") as "local" | "drive";
const DRIVE_FOLDER = "DevJavu";
const DRIVE_FILE = "log.json";

/* ── Types ────────────────────────────────── */

interface Entry {
  id: string;
  date: string;
  time: string;
  title: string;
  body: string;
  tags: string[];
  files: string[];
  createdAt: string;
}

/* ── Storage interface ────────────────────── */

interface Storage {
  list(): Promise<Entry[]>;
  save(entries: Entry[]): Promise<void>;
}

/* ── Local JSON storage ───────────────────── */

const localStorage: Storage = {
  async list() {
    try {
      return JSON.parse(fs.readFileSync(LOCAL_FILE, "utf-8"));
    } catch {
      return [];
    }
  },
  async save(entries: Entry[]) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LOCAL_FILE, JSON.stringify(entries, null, 2));
  },
};

/* ── Google Drive storage ─────────────────── */

interface Tokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
}

async function getValidAccessToken(): Promise<string> {
  let tokens: Tokens;
  try {
    tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf-8"));
  } catch {
    throw new Error("No tokens. Visit /auth/start to authorize Google Drive.");
  }
  if (tokens.expiry_date && tokens.expiry_date > Date.now() + 60_000) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) throw new Error("No refresh token. Re-authorize.");
  return refreshAccessToken(tokens.refresh_token);
}

function refreshAccessToken(refreshToken: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString();
    const req = https.request(
      {
        host: "oauth2.googleapis.com",
        path: "/token",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(parsed.error_description || parsed.error));
            const existing = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf-8"));
            existing.access_token = parsed.access_token;
            existing.expiry_date = Date.now() + (parsed.expires_in || 3600) * 1000;
            fs.writeFileSync(TOKENS_FILE, JSON.stringify(existing, null, 2));
            resolve(parsed.access_token);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function driveApi(path: string, method: string, token: string, body?: any, query?: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    let url = `https://www.googleapis.com/drive/v3${path}`;
    if (query) url += "?" + new URLSearchParams(query).toString();
    const parsed = new URL(url);
    const opts: any = {
      host: parsed.host,
      path: parsed.pathname + parsed.search,
      method,
      headers: { Authorization: `Bearer ${token}` },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) return reject(new Error(`Drive ${res.statusCode}: ${data}`));
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function driveUpload(path: string, method: string, token: string, contentType: string, body: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(`https://www.googleapis.com${path}`);
    const opts: any = {
      host: parsed.host,
      path: parsed.pathname + parsed.search,
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) return reject(new Error(`Drive ${res.statusCode}: ${data}`));
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

let cachedFolderId: string | null = null;
async function getOrCreateFolder(token: string): Promise<string> {
  if (cachedFolderId) return cachedFolderId;
  const q = `name='${DRIVE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await driveApi("/files", "GET", token, undefined, { q, fields: "files(id,name)" });
  if (res.files && res.files.length > 0) {
    cachedFolderId = res.files[0].id;
    return cachedFolderId!;
  }
  const create = await driveApi("/files", "POST", token, {
    name: DRIVE_FOLDER,
    mimeType: "application/vnd.google-apps.folder",
  }, { fields: "id" });
  cachedFolderId = create.id;
  return cachedFolderId!;
}

let cachedFileId: string | null = null;
async function getOrCreateFile(token: string, folderId: string): Promise<string> {
  if (cachedFileId) return cachedFileId;
  const q = `'${folderId}' in parents and name='${DRIVE_FILE}' and trashed=false`;
  const res = await driveApi("/files", "GET", token, undefined, { q, fields: "files(id,name)" });
  if (res.files && res.files.length > 0) {
    cachedFileId = res.files[0].id;
    return cachedFileId!;
  }
  const create = await driveApi("/files", "POST", token, {
    name: DRIVE_FILE,
    parents: [folderId],
    mimeType: "application/json",
  }, { fields: "id" });
  cachedFileId = create.id;
  return cachedFileId!;
}

const driveStorage: Storage = {
  async list() {
    const token = await getValidAccessToken();
    const folderId = await getOrCreateFolder(token);
    const fileId = await getOrCreateFile(token, folderId);
    return new Promise((resolve, reject) => {
      https.get(
        {
          host: "www.googleapis.com",
          path: `/drive/v3/files/${fileId}?alt=media`,
          headers: { Authorization: `Bearer ${token}` },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 400) return reject(new Error(`Drive read ${res.statusCode}`));
            try { resolve(JSON.parse(data || "[]")); } catch { resolve([]); }
          });
        }
      ).on("error", reject);
    });
  },
  async save(entries: Entry[]) {
    const token = await getValidAccessToken();
    const folderId = await getOrCreateFolder(token);
    const fileId = await getOrCreateFile(token, folderId);
    await driveUpload(
      `/upload/drive/v3/files/${fileId}?uploadType=multipart`,
      "PATCH",
      token,
      "application/json",
      JSON.stringify(entries, null, 2)
    );
  },
};

const storage: Storage = STORAGE_MODE === "drive" ? driveStorage : localStorage;

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
}

/* ── App ──────────────────────────────────── */

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(process.cwd(), "public")));

function now() {
  const d = new Date();
  return {
    date: d.toISOString().slice(0, 10),
    time: d.toTimeString().slice(0, 5),
    createdAt: d.toISOString(),
  };
}

app.get("/api/entries", async (_req: Request, res: Response) => {
  const entries = await storage.list();
  entries.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  res.json(entries);
});

app.post("/api/entries", async (req: Request, res: Response) => {
  const { title, body, tags, files, date, time } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: "title and body required" });
  const t = now();
  const entry: Entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title, body,
    tags: Array.isArray(tags) ? tags : [],
    files: Array.isArray(files) ? files : [],
    date: date || t.date,
    time: time || t.time,
    createdAt: t.createdAt,
  };
  const entries = await storage.list();
  entries.push(entry);
  await storage.save(entries);
  res.json(entry);
});

app.put("/api/entries/:id", async (req: Request, res: Response) => {
  const entries = await storage.list();
  const i = entries.findIndex((e) => e.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "not found" });
  const { title, body, tags, files, date, time } = req.body || {};
  entries[i] = {
    ...entries[i],
    ...(title && { title }),
    ...(body && { body }),
    ...(tags && { tags }),
    ...(files && { files }),
    ...(date && { date }),
    ...(time && { time }),
  };
  await storage.save(entries);
  res.json(entries[i]);
});

app.delete("/api/entries/:id", async (req: Request, res: Response) => {
  const entries = (await storage.list()).filter((e) => e.id !== req.params.id);
  await storage.save(entries);
  res.json({ ok: true });
});

app.get("/api/score", async (_req: Request, res: Response) => {
  const log = await storage.list();
  const today = new Date().toISOString().slice(0, 10);
  const todayEntries = log.filter((e) => e.date === today);
  if (todayEntries.length === 0) return res.json({ score: 0, reason: "No entries today.", count: 0 });

  const hours = todayEntries.map((e) => {
    const [h, m] = e.time.split(":").map(Number);
    return h + m / 60;
  });
  const span = Math.max(...hours) - Math.min(...hours);
  const totalChars = todayEntries.reduce((s, e) => s + e.body.length, 0);
  const uniqueTags = new Set(todayEntries.flatMap((e) => e.tags)).size;
  const density = Math.min(1, todayEntries.length / 8);
  const depth = Math.min(1, totalChars / 2000);
  const variety = Math.min(1, uniqueTags / 4);
  const focus = Math.min(1, span / 8);
  const score = Math.round((density * 0.35 + depth * 0.35 + variety * 0.15 + focus * 0.15) * 100);

  let reason = "";
  if (score >= 80) reason = "Deep, varied, sustained work.";
  else if (score >= 60) reason = "Solid day of focused output.";
  else if (score >= 40) reason = "Decent activity, room for more depth.";
  else if (score >= 20) reason = "Light day — got something done.";
  else reason = "Barely started — add another entry.";

  res.json({ score, reason, count: todayEntries.length, chars: totalChars, tags: uniqueTags, span: Math.round(span * 10) / 10 });
});

app.get("/api/status", (_req: Request, res: Response) => {
  res.json({ mode: STORAGE_MODE, hasTokens: fs.existsSync(TOKENS_FILE), ok: true });
});

/* ── OAuth flow (only when STORAGE_MODE=drive) ── */

if (STORAGE_MODE === "drive") {
  app.get("/auth/start", (_req, res) => {
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: GOOGLE_REDIRECT_URI,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/drive.file",
      access_type: "offline",
      prompt: "consent",
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  function handleCallback(req: any, res: any) {
    const code = req.query.code as string;
    if (!code) {
      return res.status(400).send(`<h1>No auth code</h1><p>Visit <a href="/auth/start">/auth/start</a> to begin authorization.</p>`);
    }
    const error = req.query.error as string;
    if (error) {
      return res.status(400).send(`<h1>Google returned an error</h1><p><b>${escapeHtml(error)}</b>: ${escapeHtml(req.query.error_description || "No description")}</p><p>The redirect URI used was: <code>${escapeHtml(GOOGLE_REDIRECT_URI)}</code></p><p>This must be registered in your Google Cloud Console OAuth client.</p><a href="/auth/start">Try again</a>`);
    }
    const body = new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    }).toString();
    const req2 = https.request(
      { host: "oauth2.googleapis.com", path: "/token", method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } },
      (r) => {
        let data = "";
        r.on("data", (c) => (data += c));
        r.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return res.status(500).send(`<h1>Token exchange failed</h1><p><b>${parsed.error}</b>: ${escapeHtml(parsed.error_description || "")}</p><a href="/auth/start">Try again</a>`);
            fs.mkdirSync(DATA_DIR, { recursive: true });
            const tokens: Tokens = {
              access_token: parsed.access_token,
              refresh_token: parsed.refresh_token,
              expiry_date: Date.now() + (parsed.expires_in || 3600) * 1000,
            };
            fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
            res.send(`<h1>Authorized!</h1><p>DevJavu can now use your Google Drive. You can close this tab.</p><a href="/">Go to journal</a>`);
          } catch (e: any) {
            res.status(500).send(`Parse error: ${e.message}`);
          }
        });
      }
    );
    req2.on("error", (e) => res.status(500).send(`Network error: ${e.message}`));
    req2.setTimeout(15000, () => { req2.destroy(new Error("timeout")); });
    req2.write(body);
    req2.end();
  }

  // Multiple callback paths to handle different registered redirect URIs
  app.get("/auth/callback", handleCallback);
  app.get("/oauth/callback", handleCallback);
  app.get("/callback", handleCallback);
}

app.get("/", (_req, res) => res.sendFile(path.join(process.cwd(), "public", "index.html")));

app.listen(PORT, HOST, () => {
  console.log(`DevJavu on http://${HOST}:${PORT} (storage: ${STORAGE_MODE})`);
  if (STORAGE_MODE === "drive" && !fs.existsSync(TOKENS_FILE)) {
    console.log(`Visit http://${HOST}:${PORT}/auth/start to authorize Google Drive`);
  }
});
