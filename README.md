# DevJavu — Development Journal

A minimal, terminal-inspired development journal with Google Drive storage, designed to be shared with your team.

## Features

- Time-stamped daily entries (when, what, how long)
- Markdown body with code blocks and inline code
- Tags for categorization
- Daily productivity score (0-100) with reasoning
- Google Drive storage (your data, your account)
- No auth walls — just the journal

## Stack

- Node.js + Express
- Vanilla TypeScript frontend
- Google Drive API (OAuth2) or local JSON fallback

## Local development

```bash
npm install
npm run dev
```

Server runs on `http://localhost:3002`.

## Google Drive setup

1. Set `STORAGE_MODE=drive` in environment
2. Visit `http://localhost:3002/auth/start`
3. Sign in with your Google account
4. Grant Drive access
5. Data writes to `DevJavu/log.json` in your Drive

## Deploy

See `render.yaml` for Render.com config. Set environment variables:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI` (must match your deploy URL)
- `STORAGE_MODE=drive` (for Drive) or leave unset (for local)
- `HOST=0.0.0.0`
