import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import OpenAI from "openai";
import { OAuth2Client } from "google-auth-library";

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(helmet());
app.use(cors({ origin: "*" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const oauthClient = new OAuth2Client();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

function getBearerToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer (.+)$/i);
  return m ? m[1] : null;
}

async function verifyGoogleIdToken(idToken) {
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

app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

app.post("/v1/classifySubscription", async (req, res) => {
  try {
    const idToken = getBearerToken(req);
    if (!idToken) return res.status(401).json({ error: "Missing Authorization Bearer token" });
    if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: "Missing GOOGLE_CLIENT_ID on server" });

    const payload = await verifyGoogleIdToken(idToken);
    const userEmail = payload?.email || null;

    const subject = safeTrim(req.body?.subject, 200);
    const from = safeTrim(req.body?.from, 200);
    const excerpt = safeTrim(req.body?.excerpt, 1200);

    const input = `
Return ONLY valid JSON with keys:
{
  "is_subscription": boolean,
  "subscription_name": string|null,
  "merchant_name": string|null,
  "price": number|null,
  "currency": string|null,
  "billing_period": string|null,
  "billing_email": string|null,
  "is_apple_subscription": boolean|null
}

User email: ${userEmail ?? "null"}
Subject: ${subject}
From: ${from}
Excerpt: ${excerpt}
`;

    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input,
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

app.post("/v1/deleteMyData", async (req, res) => {
  try {
    const idToken = getBearerToken(req);
    if (!idToken) return res.status(401).json({ error: "Missing Authorization Bearer token" });
    if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: "Missing GOOGLE_CLIENT_ID on server" });

    await verifyGoogleIdToken(idToken);
    res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error", message: String(err?.message || err) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));
