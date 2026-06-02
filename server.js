const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || 3000;

// ── MIME TYPES ──
const MIME = {
  ".html": "text/html",
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".json": "application/json",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon"
};

// ── GEMINI API ──
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
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });

  const data = JSON.parse(result.body);
  if (result.status !== 200) {
    throw new Error(data.error?.message || "Gemini API error " + result.status);
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return text;
}

// ── STRIPE CHECKOUT ──
async function createStripeCheckout(body) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY not configured.");

  const lang = body.lang || "en";
  const formData = body.formData || {};
  const origin = body.origin || "https://growthauditai.onrender.com";

  const metadata = {
    lang,
    name:      (formData.name      || "").substring(0, 100),
    email:     (formData.email     || "").substring(0, 100),
    bizName:   (formData.bizName   || "").substring(0, 100),
    bizType:   (formData.bizType   || "").substring(0, 100),
    country:   (formData.country   || "").substring(0, 100),
    customers: (formData.customers || "").substring(0, 50),
    channel:   (formData.channel   || "").substring(0, 100),
    ads:       (formData.ads       || "").substring(0, 100),
    social:    (formData.social    || "").substring(0, 100),
    objective: (formData.objective || "").substring(0, 100),
    challenge: (formData.challenge || "").substring(0, 480),
    sales:     (formData.sales     || "").substring(0, 480),
    followup:  (formData.followup  || "").substring(0, 480),
  };

  // Encode essential form data to pass back via URL
  const essentialData = {
    name: (formData.name||"").substring(0,50),
    email: (formData.email||"").substring(0,50),
    bizName: (formData.bizName||"").substring(0,50),
    bizType: (formData.bizType||"").substring(0,50),
    country: (formData.country||"").substring(0,50),
    customers: (formData.customers||""),
    channel: (formData.channel||"").substring(0,50),
    ads: (formData.ads||"").substring(0,50),
    social: (formData.social||"").substring(0,50),
    objective: (formData.objective||"").substring(0,50),
    challenge: (formData.challenge||"").substring(0,200),
    sales: (formData.sales||"").substring(0,100),
    followup: (formData.followup||"").substring(0,100),
  };
  const encodedData = Buffer.from(JSON.stringify(essentialData)).toString('base64');
  const successUrl = origin + "/?paid=true&session_id={CHECKOUT_SESSION_ID}&lang=" + lang + "&fd=" + encodeURIComponent(encodedData);
  const cancelUrl  = origin + "/?cancelled=true&lang=" + lang;

  const productName = lang === "pt" ? "Auditoria de Crescimento Completa" : "Full Growth Audit";
  const productDesc = lang === "pt"
    ? "Relatório de auditoria empresarial de 8 páginas personalizado"
    : "Personalised 8-page business audit report";

  const payload = new URLSearchParams({
    "mode": "payment",
    "success_url": successUrl,
    "cancel_url": cancelUrl,
    "line_items[0][price_data][currency]": "brl",
    "line_items[0][price_data][product_data][name]": productName,
    "line_items[0][price_data][product_data][description]": productDesc,
    "line_items[0][price_data][unit_amount]": "4990",
    "line_items[0][quantity]": "1",
    "customer_email": formData.email || "",
    "billing_address_collection": "auto",
    "payment_method_types[0]": "card",
  });

  Object.entries(metadata).forEach(([k, v]) => {
    if (v) payload.append("metadata[" + k + "]", v);
  });

  const postData = payload.toString();

  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.stripe.com",
      path: "/v1/checkout/sessions",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + secretKey,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });

  const session = JSON.parse(result.body);
  if (result.status !== 200) throw new Error(session.error?.message || "Stripe error");
  return { url: session.url, sessionId: session.id };
}

// ── HTTP SERVER ──
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(200); res.end(); return;
  }

  // ── API: Gemini ──
  if (pathname === "/api/claude" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const prompt = data.messages?.[0]?.content || "";
        const text = await callGemini(prompt);
        // Return in same format as Claude API
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          content: [{ type: "text", text }]
        }));
      } catch(e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
    });
    return;
  }

  // ── API: Stripe Checkout ──
  if (pathname === "/api/create-checkout" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        data.origin = req.headers.origin || "https://growthauditai.onrender.com";
        const result = await createStripeCheckout(data);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch(e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── STATIC FILES ──
  let filePath = path.join(__dirname, pathname === "/" ? "index.html" : pathname);

  // Handle SPA — serve index.html for unknown routes
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, "index.html");
  }

  const ext = path.extname(filePath);
  const mimeType = MIME[ext] || "text/plain";

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end("Not found"); return;
    }
    res.writeHead(200, { "Content-Type": mimeType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log("GrowthAudit AI running on port " + PORT);
});
