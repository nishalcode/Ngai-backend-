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

// In-memory session store
const sessions = {};

// SSE helpers
function initSSE(res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(`: ping\n\n`);
}

function sendSSE(res, event, payload) {
  if (event) res.write(`event: ${event}\n`);
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  res.write(`data: ${data}\n\n`);
}

// Clean session
function cleanSession(id) {
  if (sessions[id]) delete sessions[id];
}

// ----------------- ROUTES -----------------

// Root status page
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>NGAI Backend Status</title>
      <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
        h1 { color: #333; }
        .status { color: green; font-size: 1.2em; margin: 20px; }
        .endpoints { text-align: left; display: inline-block; margin-top: 30px; }
      </style>
    </head>
    <body>
      <h1>🚀 NGAI Chatbot Backend</h1>
      <div class="status">✅ Server is running and healthy</div>
      <div class="endpoints">
        <h3>Available Endpoints:</h3>
        <ul>
          <li><strong>POST /prepare</strong> - Create chat session</li>
          <li><strong>GET /stream/:sessionId</strong> - SSE stream</li>
          <li><strong>GET /models</strong> - List AI models</li>
        </ul>
        <p><em>Use the test HTML file to interact with the API</em></p>
      </div>
    </body>
    </html>
  `);
});

// Prepare session
app.post("/prepare", (req, res) => {
  const { model, messages } = req.body;
  if (!model || !messages) return res.status(400).json({ error: "model & messages required" });

  const sessionId = crypto.randomUUID();
  sessions[sessionId] = { model, messages, createdAt: Date.now() };
  return res.json({ sessionId });
});

// SSE stream route
app.get("/stream/:sessionId", async (req, res) => {
  initSSE(res);

  const sessionId = req.params.sessionId;
  const session = sessions[sessionId];
  if (!session) {
    sendSSE(res, "error", { message: "Invalid sessionId" });
    res.end();
    return;
  }

  const refererValue = process.env.REFERER || req.headers.origin || "https://your-domain.com";
  const xTitleValue = process.env.X_TITLE || "NGAI Chatbot Backend";

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${OPENROUTER_KEY}`,
    Referer: refererValue,
    "X-Title": xTitleValue,
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
      headers,
      body: JSON.stringify(body),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      sendSSE(res, "error", { message: "OpenRouter error", status: upstream.status, body: text });
      cleanSession(sessionId);
      res.end();
      return;
    }

    reader = upstream.body.getReader();
  } catch (err) {
    sendSSE(res, "error", { message: "Failed to connect to OpenRouter", detail: err.message });
    cleanSession(sessionId);
    res.end();
    return;
  }

  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  // Cleanup only on client disconnect
  req.on("close", () => {
    try { reader?.cancel(); } catch {}
    cleanSession(sessionId);
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop();

      for (let block of blocks) {
        if (!block.trim()) continue;

        const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;

          const payloadRaw = line.replace(/^data:\s*/, "");

          if (payloadRaw === "[DONE]" || payloadRaw === '"[DONE]"') {
            sendSSE(res, "done", "[DONE]");
            try { reader.cancel(); } catch {}
            cleanSession(sessionId);
            res.end();
            return;
          }

          try {
            const data = JSON.parse(payloadRaw);
            let content = "";
            let shouldEnd = false;

            if (data.choices?.[0]?.delta?.content !== undefined) {
              content = (data.choices[0].delta.content || "").trim();
            }
            if (data.choices?.[0]?.message?.content !== undefined) {
              content = (data.choices[0].message.content || "").trim();
            }
            if (data.choices?.[0]?.text !== undefined) {
              content = (data.choices[0].text || "").trim();
            }

            if (data.choices?.[0]?.finish_reason) {
              shouldEnd = true;
            }

            if (content.length > 0) {
              sendSSE(res, "chunk", { content });
            }

            if (shouldEnd) {
              sendSSE(res, "done", "[DONE]");
              try { reader.cancel(); } catch {}
              cleanSession(sessionId);
              res.end();
              return;
            }

          } catch {
            sendSSE(res, "chunk", payloadRaw);
          }
        }
      }
    }

    sendSSE(res, "done", "[DONE]");

  } catch (err) {
    sendSSE(res, "error", { message: "Stream error", detail: err.message });
  } finally {
    cleanSession(sessionId);
    try { res.end(); } catch {}
  }
});

// List models
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

// Optional session sweeper
setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(sessions)) {
    if (now - sessions[id].createdAt > 1000 * 60 * 10) {
      delete sessions[id];
    }
  }
}, 1000 * 60 * 5);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 NGAI SSE backend running on port ${PORT}`));
