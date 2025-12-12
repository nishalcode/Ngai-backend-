// server.js
// NGAI-ready SSE backend — fixes:
// 1) Use standard "Referer" header for OpenRouter
// 2) Clean up sessions after use (no memory leak)
// 3) Robust JSON parsing for malformed chunks
// 4) Proper SSE formatting for [DONE] (always `data:` lines)
//
// Requirements: Node 18+ (global fetch), npm install express cors dotenv
// .env: OPENROUTER_API_KEY, OPTIONAL: REFERER (defaults to client's origin or fallback)

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
dotenv.config();

const app = express();
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "1mb" }));

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_KEY) {
  console.error("❌ Missing OPENROUTER_API_KEY in .env");
  process.exit(1);
}

// In-memory sessions (small, ephemeral). Swap to Redis for production.
const sessions = {};

// SSE helpers — ALWAYS use `data:` lines
function initSSE(res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
  res.flushHeaders();
  // send a comment to prime the connection (keeps some proxies awake)
  res.write(`: ping\n\n`);
}

function sendSSE(res, event, payload) {
  if (event) res.write(`event: ${event}\n`);
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  // ensure newline-safe data lines
  res.write(`data: ${data}\n\n`);
}

// ------------- Step 1: create session -------------
app.post("/prepare", (req, res) => {
  const { model, messages } = req.body;
  if (!model || !messages) return res.status(400).json({ error: "model & messages required" });

  const sessionId = crypto.randomUUID();
  sessions[sessionId] = { model, messages, createdAt: Date.now() };
  return res.json({ sessionId });
});

// ------------- Step 2: SSE stream for session -------------
app.get("/stream/:sessionId", async (req, res) => {
  initSSE(res);

  const sessionId = req.params.sessionId;
  const session = sessions[sessionId];
  if (!session) {
    sendSSE(res, "error", { message: "invalid sessionId" });
    res.end();
    return;
  }

  // derive a Referer header: env override -> client's origin header -> fallback
  const refererValue = process.env.REFERER || req.headers.origin || "https://your-domain.com";

  const upstreamHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${OPENROUTER_KEY}`,
    // Standard header name is "Referer"
    Referer: refererValue,
    // OpenRouter also expects an X-Title meta header (kept as-is)
    "X-Title": process.env.X_TITLE || "NGAI Chatbot Backend",
  };

  const body = {
    model: session.model,
    messages: session.messages,
    stream: true,
  };

  let reader;
  try {
    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      sendSSE(res, "error", { message: "openrouter error", status: upstream.status, body: text });
      cleanSession(sessionId);
      res.end();
      return;
    }

    reader = upstream.body.getReader();
  } catch (err) {
    sendSSE(res, "error", { message: "failed to connect to OpenRouter", detail: err.message });
    cleanSession(sessionId);
    res.end();
    return;
  }

  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  // Ensure we cancel reader & cleanup if client disconnects
  const onClientClose = () => {
    try { reader?.cancel(); } catch (e) {}
    cleanSession(sessionId);
  };
  req.on("close", onClientClose);
  req.on("end", onClientClose);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // OpenRouter streaming often sends multiple data blocks separated by \n\n
      // We parse all complete blocks; leave remainder in buffer
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop();

      for (let rawBlock of blocks) {
        if (!rawBlock) continue;

        // Normalize: any leading "data:" lines -> extract every data: line
        const lines = rawBlock.split("\n").map((l) => l.trim()).filter(Boolean);

        // iterate lines starting with "data:"
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payloadRaw = line.replace(/^data:\s*/, "");

          // EXACT SSE DONE handling: OpenRouter may send "[DONE]" as a data payload
          if (payloadRaw === "[DONE]" || payloadRaw === '"[DONE]"') {
            // send DONE as SSE data line (and a done event)
            sendSSE(res, "done", "[DONE]");
            // cleanup and close
            try { reader.cancel(); } catch {}
            cleanSession(sessionId);
            res.end();
            return;
          }

          // Attempt to parse JSON safely. If parsing fails, emit the raw string as chunk.
          try {
            const json = JSON.parse(payloadRaw);
            sendSSE(res, "chunk", json);
          } catch (parseErr) {
            // Malformed JSON chunk — don't crash; forward raw text for client debugging
            sendSSE(res, "chunk", { raw: payloadRaw, parseError: parseErr.message });
          }
        }
      }
    }

    // Stream naturally ended; signal DONE properly
    sendSSE(res, "done", "[DONE]");
  } catch (err) {
    // handle stream errors gracefully
    sendSSE(res, "error", { message: "stream error", detail: err.message });
  } finally {
    cleanSession(sessionId);
    try { res.end(); } catch (e) {}
  }
});

// Simple models endpoint that forwards OpenRouter model list (optional)
app.get("/models", async (req, res) => {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${OPENROUTER_KEY}` },
    });
    const json = await r.json();
    res.json(json);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health
app.get("/", (req, res) => res.send("NGAI SSE backend alive"));

// Session cleanup helper
function cleanSession(sessionId) {
  if (sessionId && sessions[sessionId]) {
    delete sessions[sessionId];
  }
}

// Optional: periodic sweeper to remove old sessions (defensive)
setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(sessions)) {
    if (now - sessions[id].createdAt > 1000 * 60 * 10) { // 10 minutes
      delete sessions[id];
    }
  }
}, 1000 * 60 * 5); // run every 5 minutes

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 NGAI SSE backend running on ${PORT}`));
