// api/index.ts — Vercel serverless entry point
// Exports the Express app so Vercel's @vercel/node runtime can handle requests.

import { createApp } from "../src/server.js";

export default createApp();