const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || 3000;

const MIME = {
  ".html": "text/html",
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".json": "application/json",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon"
};

// ── SESSION STORE (server memory) ──
const sessions = {};
function saveSession(tid, data) {
  sessions[tid] = { data, ts: Date.now() };
  const cutoff = Date.now() - 7200000;
  Object.keys(sessions).forEach(k => { if (sessions[k].ts < cutoff) delete sessions[k]; });
}
function getSession(tid) { return sessions[tid]?.data || null; }

// ── GEMINI ──
async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured.");
  const payload = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 2000 }
  });
  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "generativelanguage.googleapis.com",
      path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
    }, (res) => { let data = ""; res.on("data", c => data += c); res.on("end", () => resolve({ status: res.statusCode, body: data })); });
    req.on("error", reject); req.write(payload); req.end();
  });
  const data = JSON.parse(result.body);
  if (result.status !== 200) throw new Error(data.error?.message || "Gemini error " + result.status);
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// ── STRIPE ──
async function createStripeCheckout(body) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY not configured.");
  const lang = body.lang || "pt";
  const formData = body.formData || {};
  const origin = body.origin || "https://growthaudit-ai.onrender.com";
  const tid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  saveSession(tid, { ...formData, lang });
  const successUrl = origin + "/?paid=true&tid=" + tid + "&lang=" + lang;
  const cancelUrl  = origin + "/?cancelled=true&lang=" + lang;
  const payload = new URLSearchParams({
    "mode": "payment", "success_url": successUrl, "cancel_url": cancelUrl,
    "line_items[0][price_data][currency]": "brl",
    "line_items[0][price_data][product_data][name]": lang==="pt"?"Auditoria de Crescimento Completa":"Full Growth Audit",
    "line_items[0][price_data][product_data][description]": lang==="pt"?"Relatorio de auditoria de 8 paginas personalizado":"Personalised 8-page business audit report",
    "line_items[0][price_data][unit_amount]": "4990",
    "line_items[0][quantity]": "1",
    "customer_email": formData.email || "",
    "billing_address_collection": "auto",
    "payment_method_types[0]": "card",
  });
  const postData = payload.toString();
  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.stripe.com", path: "/v1/checkout/sessions", method: "POST",
      headers: { "Authorization": "Bearer " + secretKey, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(postData) }
    }, (res) => { let data = ""; res.on("data", c => data += c); res.on("end", () => resolve({ status: res.statusCode, body: data })); });
    req.on("error", reject); req.write(postData); req.end();
  });
  const session = JSON.parse(result.body);
  if (result.status !== 200) throw new Error(session.error?.message || "Stripe error");
  return { url: session.url, sessionId: session.id, tid };
}

// ── SERVER ──
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  if (pathname === "/api/get-session" && req.method === "GET") {
    const tid = parsed.query.tid;
    if (!tid) { res.writeHead(400, {"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}); res.end(JSON.stringify({error:"Missing tid"})); return; }
    const data = getSession(tid);
    if (!data) { res.writeHead(404, {"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}); res.end(JSON.stringify({error:"Session not found"})); return; }
    res.writeHead(200, {"Content-Type":"application/json","Access-Control-Allow-Origin":"*"});
    res.end(JSON.stringify({ data }));
    return;
  }

  if (pathname === "/api/claude" && req.method === "POST") {
    let body = ""; req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const text = await callGemini(data.messages?.[0]?.content || "");
        res.writeHead(200, {"Content-Type":"application/json","Access-Control-Allow-Origin":"*"});
        res.end(JSON.stringify({ content: [{ type: "text", text }] }));
      } catch(e) { res.writeHead(500, {"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}); res.end(JSON.stringify({error:{message:e.message}})); }
    }); return;
  }

  if (pathname === "/api/create-checkout" && req.method === "POST") {
    let body = ""; req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        data.origin = req.headers.origin || "https://growthaudit-ai.onrender.com";
        const result = await createStripeCheckout(data);
        res.writeHead(200, {"Content-Type":"application/json","Access-Control-Allow-Origin":"*"});
        res.end(JSON.stringify(result));
      } catch(e) { res.writeHead(500, {"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}); res.end(JSON.stringify({error:e.message})); }
    }); return;
  }

  let filePath = path.join(__dirname, pathname === "/" ? "index.html" : pathname);
  if (!fs.existsSync(filePath)) filePath = path.join(__dirname, "index.html");
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, {"Content-Type": MIME[ext] || "text/plain"});
    res.end(data);
  });
});

server.listen(PORT, () => { console.log("GrowthAudit AI running on port " + PORT); });
