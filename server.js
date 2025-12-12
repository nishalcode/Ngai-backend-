import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(cors({ origin: "*", methods: ["GET","POST"], allowedHeaders: ["Content-Type","Authorization"] }));
app.use(express.json({ limit: "2mb" }));

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_KEY) {
  console.error("❌ Missing OPENROUTER_API_KEY in .env");
  process.exit(1);
}

const sessions = {};

// ----------- HELPERS ------------

function initSSE(res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // nginx fix
  res.flushHeaders();
  res.write(`: ping\n\n`);
}

function sendSSE(res, event, payload) {
  if (event) res.write(`event: ${event}\n`);
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  res.write(`data: ${data}\n\n`);
}

function cleanSession(id) {
  if (sessions[id]) delete sessions[id];
}

function standardizeMessages(messages) {
  if (!Array.isArray(messages)) messages = [];
  const hasSystem = messages.some(m => m.role === "system");
  const hasUser = messages.some(m => m.role === "user");
  if (!hasSystem) messages.unshift({ role: "system", content: "You are a helpful AI assistant." });
  if (!hasUser) messages.push({ role: "user", content: "Hello!" });
  return messages;
}

async function fetchOpenRouter(model, messages, stream = true) {
  const refererValue = process.env.REFERER || "https://ngai-backend.onrender.com";
  const xTitleValue = process.env.X_TITLE || "NGAI Chatbot Backend";

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${OPENROUTER_KEY}`,
    Referer: refererValue,
    "X-Title": xTitleValue
  };

  const body = { model, messages, stream };

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(`OpenRouter API error ${res.status}`);
  return res;
}

// ----------- ROUTES ------------

// Root
app.get("/", (req,res) => {
  res.send(`
  <!DOCTYPE html>
  <html>
  <head><title>NGAI Backend Status</title></head>
  <body>
  <h1>🚀 NGAI Chatbot Backend</h1>
  <p>✅ Server running</p>
  <ul>
    <li>POST /prepare - create session</li>
    <li>GET /stream/:sessionId - SSE streaming</li>
    <li>GET /models - list models</li>
  </ul>
  </body>
  </html>`);
});

// Prepare session
app.post("/prepare", (req,res) => {
  try {
    let { model, messages } = req.body;
    if (!model) model = "mistralai/mistral-7b-instruct:free";
    messages = standardizeMessages(messages);
    const sessionId = crypto.randomUUID();
    sessions[sessionId] = { model, messages, createdAt: Date.now() };
    res.json({ sessionId });
  } catch (err) {
    res.status(500).json({ error: "Failed to prepare session", detail: err.message });
  }
});

// SSE stream
app.get("/stream/:sessionId", async (req,res) => {
  initSSE(res);
  const sessionId = req.params.sessionId;
  const session = sessions[sessionId];
  if (!session) {
    sendSSE(res, "error", { message: "Invalid sessionId" });
    res.end();
    return;
  }

  const models = [
    session.model,
    "openchat/openchat-7b:free",
    "huggingfaceh4/zephyr-7b-beta:free",
    "google/gemma-7b-it:free"
  ];

  let streamed = false;

  for (let i=0; i<models.length && !streamed; i++) {
    const model = models[i];
    let reader = null;
    let timeoutHandle = null;

    try {
      const upstream = await fetchOpenRouter(model, session.messages, true);
      reader = upstream.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      // Timeout safeguard
      timeoutHandle = setTimeout(() => {
        console.warn(`⚠️ Stream timeout for session ${sessionId}`);
        sendSSE(res,"done","[DONE]");
        cleanSession(sessionId);
        try { reader?.cancel(); } catch {}
        res.end();
      }, 60000); // 60s

      req.on("close", () => {
        clearTimeout(timeoutHandle);
        try { reader?.cancel(); } catch {}
        cleanSession(sessionId);
      });

      streamed = true;

      while(true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value,{stream:true});
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop();

        for(const block of blocks) {
          if(!block.trim()) continue;
          const lines = block.split("\n").map(l=>l.trim()).filter(Boolean);
          for(const line of lines) {
            if(!line.startsWith("data:")) continue;
            const payloadRaw = line.replace(/^data:\s*/,"");

            if(payloadRaw === "[DONE]" || payloadRaw === '"[DONE]"') {
              clearTimeout(timeoutHandle);
              sendSSE(res,"done","[DONE]");
              try { reader.cancel(); } catch {}
              cleanSession(sessionId);
              res.end();
              return;
            }

            try {
              const data = JSON.parse(payloadRaw);
              let content="";
              let shouldEnd=false;

              if(data.choices?.[0]?.delta?.content !== undefined)
                content=(data.choices[0].delta.content || "").trim();
              if(data.choices?.[0]?.message?.content !== undefined)
                content=(data.choices[0].message.content || "").trim();
              if(data.choices?.[0]?.text !== undefined)
                content=(data.choices[0].text || "").trim();
              if(data.choices?.[0]?.finish_reason) shouldEnd=true;

              if(content) sendSSE(res,"chunk",{content});
              if(shouldEnd){
                clearTimeout(timeoutHandle);
                sendSSE(res,"done","[DONE]");
                try { reader.cancel(); } catch {}
                cleanSession(sessionId);
                res.end();
                return;
              }

            } catch(chunkErr){
              console.warn("Chunk parse error:",chunkErr.message);
            }
          }
        }
      }
    } catch(streamErr) {
      console.warn(`Model ${model} failed: ${streamErr.message}`);
      if(i === models.length-1){
        // fallback non-SSE
        try{
          const fallback = await fetchOpenRouter(session.model, session.messages,false);
          const json = await fallback.json();
          const text = json.choices?.[0]?.message?.content || json.choices?.[0]?.text || "No response";
          sendSSE(res,"chunk",{content:text});
          sendSSE(res,"done","[DONE]");
          cleanSession(sessionId);
          res.end();
          return;
        }catch(fallbackErr){
          sendSSE(res,"error",{message:"All models failed",detail:fallbackErr.message});
          cleanSession(sessionId);
          res.end();
          return;
        }
      }
    }
  }
});

// List models
app.get("/models",async (req,res)=>{
  try{
    const r = await fetch("https://openrouter.ai/api/v1/models",{headers:{Authorization:`Bearer ${OPENROUTER_KEY}`}});
    const json = await r.json();
    res.json(json);
  }catch(err){
    res.status(500).json({error:err.message});
  }
});

// Session sweeper
setInterval(()=>{
  const now = Date.now();
  Object.keys(sessions).forEach(id=>{
    if(now-sessions[id].createdAt > 1000*60*10) delete sessions[id];
  });
},1000*60*5);

// Global error handlers
process.on("unhandledRejection",err=>console.error("Unhandled Rejection:",err));
process.on("uncaughtException",err=>console.error("Uncaught Exception:",err));

const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log(`🚀 NGAI SSE backend running on port ${PORT}`));
