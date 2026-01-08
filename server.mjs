cd ~/cashbackcompass-backend
cat > server.mjs << 'EOF'
import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import OpenAI from "openai";
import { OAuth2Client } from "google-auth-library";

const app = express();

// --- basic routes (Render health checks)
app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/healthz", (req, res) => res.status(200).json({ ok: true }));

// --- middleware
app.use(express.json({ limit: "200kb" }));
app.use(helmet());
app.use(cors({ origin: "*" }));

// --- env
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

// --- clients
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const oauthClient = new OAuth2Client();

// --- helpers
function getBearerToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer (.+)$/i);
  return m ? m[1] : null;
}

async function verifyGoogleIdToken(idToken) {
  if (!GOOGLE_CLIENT_ID) {
    const err = new Error("Missing GOOGLE_CLIENT_ID on server");
    // @ts-ignore
    err.statusCode = 500;
    throw err;
  }
  const ticket = await oauthClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });
  return ticket.getPayload();
}

function safeTrim(s, max = 800) {
  if (!s) return "";
  const t = String(s).trim();
  return t.length > max ? t.slice(0, max) : t;
}

// --- endpoint: classify subscription
app.post("/v1/classifySubscription", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY on server" });

    const idToken = getBearerToken(req);
    if (!idToken) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    const payload = await verifyGoogleIdToken(idToken);
    const userEmail = payload?.email || null;

    const { from = "", subject = "", snippet = "", body = "" } = req.body || {};
    const emailText = safeTrim(`${from}\n${subject}\n${snippet}\n${body}`, 6000);

    const prompt = `
You are classifying whether an email is a subscription billing/renewal email.

Return ONLY valid JSON with these keys:
{
  "is_subscription": boolean,
  "subscription_name": string|null,
  "merchant_name": string|null,
  "price": number|null,
  "currency": string|null,
  "billing_period": "weekly"|"monthly"|"yearly"|"one_time"|"unknown"|null,
  "billing_email": string|null,
  "is_apple_subscription": boolean|null
}

Rules:
- is_subscription true ONLY for recurring subscription services (streaming, apps, memberships, SaaS).
- If it looks like a one-time store receipt (Amazon order, restaurant, etc) -> is_subscription false.
- Extract price if clearly present (numbers like 9.99).
- currency: "USD","CAD","EUR","GBP" if detectable else null.
- billing_period: infer from text (month/year/week/renewal) else "unknown".
- subscription_name: the product/service name (e.g. Netflix, Spotify, iCloud, Apple Arcade).
- merchant_name: company charging (often same).
- is_apple_subscription true if Apple billing / App Store / iTunes / Apple.com/bill appears.
- billing_email should be the user email if known: ${userEmail || "null"}.

Email:
"""${emailText}"""
`.trim();

    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input: prompt,
    });

    const text = response.output_text || "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) {
      return res.status(502).json({ error: "AI did not return JSON", raw: safeTrim(text, 400) });
    }

    const obj = JSON.parse(text.slice(start, end + 1));

    res.json({
      is_subscription: !!obj.is_subscription,
      subscription_name: obj.subscription_name ?? null,
      merchant_name: obj.merchant_name ?? null,
      price: typeof obj.price === "number" ? obj.price : null,
      currency: obj.currency ?? null,
      billing_period: obj.billing_period ?? null,
      billing_email: obj.billing_email ?? userEmail ?? null,
      is_apple_subscription: typeof obj.is_apple_subscription === "boolean" ? obj.is_apple_subscription : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error", message: String(err?.message || err) });
  }
});

// --- endpoint: delete my data (stub)
app.post("/v1/deleteMyData", async (req, res) => {
  try {
    const idToken = getBearerToken(req);
    if (!idToken) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    await verifyGoogleIdToken(idToken);
    res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error", message: String(err?.message || err) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));
EOF

