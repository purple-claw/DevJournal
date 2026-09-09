/* ─────────────────────────────────────────────
   DevJavu — Server
   Pluggable storage: Google Drive OR local JSON
   Local dev (server.ts) and Vercel serverless (api/index.ts) compatible.
   ───────────────────────────────────────────── */

import express, { type Request, type Response } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import net from "node:net";
import { URL } from "node:url";
import { computeProductivityScore, TimeSeriesIndex } from "./algorithms/productivity.ts";

/* ── Config ───────────────────────────────── */

const PORT = parseInt(process.env.PORT || "3002", 10);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.VERCEL ? path.join("/tmp", ".devjavu") : path.join(process.cwd(), "data");
const LOCAL_FILE = path.join(DATA_DIR, "log.json");
const TOKENS_FILE = path.join(DATA_DIR, "tokens.json");

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  || (process.env.GOOGLE_SERVICE_ACCOUNT_JSON_FILE ? fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_FILE, "utf-8") : "");
const GOOGLE_DRIVE_SHARE_WITH = process.env.GOOGLE_DRIVE_SHARE_WITH || "";
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

interface Storage {
  list(): Promise<Entry[]>;
  save(entries: Entry[]): Promise<void>;
}

interface Tokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
}

/* ── Token store (env-first, file fallback) ── */

function tokensFromEnv(): Tokens | null {
  const access_token = process.env.GOOGLE_ACCESS_TOKEN || "";
  const refresh_token = process.env.GOOGLE_REFRESH_TOKEN || "";
  if (!access_token && !refresh_token) return null;
  return { access_token, refresh_token, expiry_date: 0 };
}

function tokensFromFile(): Tokens | null {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf-8")) as Tokens;
  } catch {
    return null;
  }
}

function saveTokensToFile(tokens: Tokens): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  } catch {
    // read-only FS (Vercel) — ignore; env tokens are the source of truth
  }
}

function hasTokens(): boolean {
  if (GOOGLE_SERVICE_ACCOUNT_JSON) return true;
  const t = tokensFromEnv() || tokensFromFile();
  return !!(t?.access_token || t?.refresh_token);
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
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch {}
    fs.writeFileSync(LOCAL_FILE, JSON.stringify(entries, null, 2));
  },
};

/* ── Google Drive token handling ──────────── */

/* Service-account auth: no consent screen, no refresh tokens, no expiry pain.
   GOOGLE_SERVICE_ACCOUNT_JSON contains the full downloaded key JSON. */
let saCache: { token: string; expiry: number } | null = null;

async function serviceAccountAccessToken(): Promise<string> {
  if (saCache && saCache.expiry > Date.now() + 60_000) return saCache.token;
  const sa = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const claimSet = { iss: sa.client_email, scope: "https://www.googleapis.com/auth/drive", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 };
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claimSet)}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key.replace(/\\n/g, "\n"), "base64url");
  const assertion = `${unsigned}.${signature}`;
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString();
  const parsed = await new Promise<any>((resolve, reject) => {
    const req = https.request(
      { host: "oauth2.googleapis.com", path: "/token", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
  if (parsed.error || !parsed.access_token) throw new Error(`Service account auth failed: ${parsed.error_description || parsed.error}`);
  saCache = { token: parsed.access_token, expiry: Date.now() + (parsed.expires_in || 3600) * 1000 };
  return saCache.token;
}

async function resolveAccessToken(): Promise<string> {
  if (GOOGLE_SERVICE_ACCOUNT_JSON) return serviceAccountAccessToken();

  const envTokens = tokensFromEnv();
  const fileTokens = tokensFromFile();

  // Use an access token only when we know it is still fresh
  for (const t of [envTokens, fileTokens]) {
    if (t?.access_token && t.expiry_date && t.expiry_date > Date.now() + 60_000) {
      return t.access_token;
    }
  }

  const refreshToken = envTokens?.refresh_token || fileTokens?.refresh_token;
  if (!refreshToken) {
    // No refresh token — fall back to whatever access token exists (may fail)
    const fallback = envTokens?.access_token || fileTokens?.access_token;
    if (fallback) return fallback;
    throw new Error("No Drive tokens. Set GOOGLE_REFRESH_TOKEN (Vercel) or visit /auth/start locally.");
  }
  return refreshAccessToken(refreshToken);
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
            const tokens: Tokens = {
              access_token: parsed.access_token,
              refresh_token: refreshToken,
              expiry_date: Date.now() + (parsed.expires_in || 3600) * 1000,
            };
            saveTokensToFile(tokens);
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

/* ── Google Drive API helpers ─────────────── */

function driveApi(path: string, method: string, token: string, body?: any, query?: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    let url = `https://www.googleapis.com/drive/v3${path}`;
    if (query) url += "?" + new URLSearchParams(query).toString();
    const parsed = new URL(url);
    const req = https.request(
      { host: parsed.host, path: parsed.pathname + parsed.search, method, headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) return reject(new Error(`Drive ${res.statusCode}: ${data}`));
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function driveUpload(path: string, method: string, token: string, body: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(`https://www.googleapis.com${path}`);
    const req = https.request(
      { host: parsed.host, path: parsed.pathname + parsed.search, method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) return reject(new Error(`Drive ${res.statusCode}: ${data}`));
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        });
      }
    );
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
    return cachedFolderId;
  }
  const create = await driveApi("/files", "POST", token, { name: DRIVE_FOLDER, mimeType: "application/vnd.google-apps.folder" }, { fields: "id" });
  cachedFolderId = create.id;
  if (GOOGLE_DRIVE_SHARE_WITH) {
    // best-effort: make the journal visible in the owner's Drive under "Shared with me"
    driveApi(`/files/${create.id}/permissions`, "POST", token, { type: "user", role: "writer", emailAddress: GOOGLE_DRIVE_SHARE_WITH }, { fields: "id" }).catch(() => {});
  }
  return cachedFolderId;
}

let cachedFileId: string | null = null;
async function getOrCreateFile(token: string, folderId: string): Promise<string> {
  if (cachedFileId) return cachedFileId;
  const q = `'${folderId}' in parents and name='${DRIVE_FILE}' and trashed=false`;
  const res = await driveApi("/files", "GET", token, undefined, { q, fields: "files(id,name)" });
  if (res.files && res.files.length > 0) {
    cachedFileId = res.files[0].id;
    return cachedFileId;
  }
  const create = await driveApi("/files", "POST", token, { name: DRIVE_FILE, parents: [folderId], mimeType: "application/json" }, { fields: "id" });
  cachedFileId = create.id;
  return cachedFileId;
}

const driveStorage: Storage = {
  async list() {
    const token = await resolveAccessToken();
    const folderId = await getOrCreateFolder(token);
    const fileId = await getOrCreateFile(token, folderId);
    return new Promise((resolve, reject) => {
      https.get(
        { host: "www.googleapis.com", path: `/drive/v3/files/${fileId}?alt=media`, headers: { Authorization: `Bearer ${token}` } },
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
    const token = await resolveAccessToken();
    const folderId = await getOrCreateFolder(token);
    const fileId = await getOrCreateFile(token, folderId);
    await driveUpload(`/upload/drive/v3/files/${fileId}?uploadType=multipart`, "PATCH", token, JSON.stringify(entries, null, 2));
  },
};

const storage: Storage = STORAGE_MODE === "drive" ? driveStorage : localStorage;

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
}

export async function resolvePort(port: number): Promise<number> {
  for (let candidate = port; candidate < port + 25; candidate++) {
    const free = await new Promise<boolean>((resolve) => {
      const tester = net.createServer();
      tester.once("error", () => resolve(false));
      tester.once("listening", () => tester.close(() => resolve(true)));
      tester.listen(candidate, HOST);
    });
    if (free) return candidate;
  }
  return port;
}

export function validateEntryInput(payload: any): { ok: true; value: { title: string; body: string; tags: string[]; files: string[]; date: string; time: string }; } | { ok: false; error: string } {
  const title = String(payload?.title ?? "").trim();
  const body = String(payload?.body ?? "").trim();
  if (!title) return { ok: false, error: "title required" };
  if (!body) return { ok: false, error: "body required" };

  const tags = Array.isArray(payload?.tags) ? payload.tags.map((t: any) => String(t).trim()).filter(Boolean) : [];
  const files = Array.isArray(payload?.files) ? payload.files.map((f: any) => String(f).trim()).filter(Boolean) : [];
  const date = String(payload?.date || new Date().toISOString().slice(0, 10)).trim();
  const time = String(payload?.time || new Date().toTimeString().slice(0, 5)).trim();

  return {
    ok: true,
    value: { title, body, tags, files, date, time },
  };
}

/* ── App factory ──────────────────────────── */

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const publicDir = path.resolve(process.cwd(), "public");
  app.use(express.static(publicDir));
  app.get("/privacy", (_req, res) => res.sendFile(path.join(publicDir, "privacy.html")));

  function now() {
    const d = new Date();
    return { date: d.toISOString().slice(0, 10), time: d.toTimeString().slice(0, 5), createdAt: d.toISOString() };
  }

  app.get("/api/entries", async (_req: Request, res: Response) => {
    try {
      const entries = await storage.list();
      entries.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      res.json(entries);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/entries", async (req: Request, res: Response) => {
    try {
      const parsed = validateEntryInput(req.body || {});
      if (parsed.ok !== true) {
        return res.status(400).json({ error: parsed.error });
      }
      const { title, body, tags, files, date, time } = parsed.value;
      const t = now();
      const entry: Entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        title, body,
        tags,
        files,
        date: date || t.date,
        time: time || t.time,
        createdAt: t.createdAt,
      };
      const entries = await storage.list();
      entries.push(entry);
      await storage.save(entries);
      res.json(entry);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put("/api/entries/:id", async (req: Request, res: Response) => {
    try {
      const parsed = validateEntryInput(req.body || {});
      if (parsed.ok !== true) {
        return res.status(400).json({ error: parsed.error });
      }
      const entries = await storage.list();
      const i = entries.findIndex((e) => e.id === req.params.id);
      if (i === -1) return res.status(404).json({ error: "not found" });
      const { title, body, tags, files, date, time } = parsed.value;
      entries[i] = {
        ...entries[i],
        title,
        body,
        tags,
        files,
        date,
        time,
      };
      await storage.save(entries);
      res.json(entries[i]);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/entries/:id", async (req: Request, res: Response) => {
    try {
      const entries = (await storage.list()).filter((e) => e.id !== req.params.id);
      await storage.save(entries);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/search", async (req: Request, res: Response) => {
    try {
      const q = (req.query.q as string) || "";
      if (!q.trim()) return res.json({ query: q, results: [] });
      const entries = await storage.list();
      const index = new TimeSeriesIndex();
      index.build(entries);
      const results = index.search(q);
      res.json({ query: q, results: results.slice(0, 20) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/score", async (_req: Request, res: Response) => {
    try {
      const log = await storage.list();
      const today = new Date().toISOString().slice(0, 10);
      const todayEntries = log.filter((e) => e.date === today);
      if (todayEntries.length === 0) return res.json({ score: 0, reason: "No entries today.", count: 0 });

      const hours = todayEntries.map((e) => { const [h, m] = e.time.split(":").map(Number); return h + m / 60; });
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
      else reason = "Add another entry.";

      res.json({ score, reason, count: todayEntries.length, chars: totalChars, tags: uniqueTags, span: Math.round(span * 10) / 10 });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "devjavu-journal", timestamp: new Date().toISOString(), storage: STORAGE_MODE });
  });

  app.get("/api/status", (_req: Request, res: Response) => {
    res.json({ mode: STORAGE_MODE, hasTokens: hasTokens(), ok: true });
  });

  /* ── OAuth flow (local dev convenience) ── */
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
      if (!code) return res.status(400).send("No code. Visit /auth/start.");
      const error = req.query.error as string;
      if (error) return res.status(400).send(`Google error: ${escapeHtml(error)}`);
      const body = new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
      }).toString();
      const req2 = https.request(
        { host: "oauth2.googleapis.com", path: "/token", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } },
        (r) => {
          let data = "";
          r.on("data", (c) => (data += c));
          r.on("end", () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) return res.status(500).send(`Auth error: ${parsed.error_description || parsed.error}`);
              const tokens: Tokens = { access_token: parsed.access_token, refresh_token: parsed.refresh_token, expiry_date: Date.now() + (parsed.expires_in || 3600) * 1000 };
              saveTokensToFile(tokens);
              res.send(`<h1>Authorized</h1><p>DevJavu can now use your Google Drive. <a href="/">Go to journal</a></p>`);
            } catch (e: any) {
              res.status(500).send(`Parse error: ${e.message}`);
            }
          });
        }
      );
      req2.on("error", (e) => res.status(500).send(e.message));
      req2.setTimeout(15000, () => req2.destroy(new Error("timeout")));
      req2.write(body);
      req2.end();
    }

    app.get("/auth/callback", handleCallback);
    app.get("/oauth/callback", handleCallback);
    app.get("/callback", handleCallback);
  }

  return app;
}

/* ── Local dev entry (not used by Vercel) ─── */

const isMain = process.argv[1] && (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js"));
if (isMain) {
  const app = createApp();
  void resolvePort(PORT).then((actualPort) => {
    app.listen(actualPort, HOST, () => {
      console.log(`DevJavu on http://${HOST}:${actualPort} (storage: ${STORAGE_MODE})`);
      if (actualPort !== PORT) {
        console.log(`Port ${PORT} was busy; using ${actualPort} instead.`);
      }
      if (STORAGE_MODE === "drive" && !hasTokens()) {
        console.log(`Visit http://${HOST}:${actualPort}/auth/start to authorize Google Drive`);
      }
    });
  });
}