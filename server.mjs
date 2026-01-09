import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";
import { OAuth2Client } from "google-auth-library";

const app = express();

/**
 * ---- Request logging (shows up in Render Logs)
 */
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

/**
 * ---- Middleware
 */
app.set("trust proxy", 1); // Render runs behind a proxy

app.use(express.json({ limit: "200kb" }));
app.use(helmet());

app.use(
  cors({
    origin: "*", // tighten later if you want
  })
);

/**
 * ---- Basic rate limiting (protects OpenAI + your service)
 */
app.use(
  rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 120, // 120 req/min per IP (safe default)
    standardHeaders: true,
    legacyHeaders: false,
  })
);

/**
 * ---- Health
 */
app.get("/", (req, res) => res.status(200).send("ok"));

app.get("/healthz", (req, res) => {
  console.log("✅ HIT /healthz");
  res.status(200).json({ ok: true });
});

/**
 * ---- Env
 */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

/**
 * ---- Clients
 */
const oauthClient = new OAuth2Client();

function getOpenAIClient() {
  if (!OPENAI_API_KEY) {
    const err = new Error("Missing OPENAI_API_KEY on server (.env or Render env var).");
    err.statusCode = 500;
    throw err;
  }
  return new OpenAI({ apiKey: OPENAI_API_KEY });
}

/**
 * ---- Helpers
 */
function safeTrim(s, n = 400) {
  if (typeof s !== "string") return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function getBearerToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

async function verifyGoogleIdToken(idToken) {
  if (!GOOGLE_CLIENT_ID) {
    const err = new Error("Missing GOOGLE_CLIENT_ID on server (.env or Render env var).");
    err.statusCode = 500;
    throw err;
  }

  const ticket = await oauthClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  return payload || null;
}

function parseModelJSON(rawText) {
  const text = rawText || "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    const err = new Error("AI did not return JSON");
    err.statusCode = 502;
    err.raw = safeTrim(text, 400);
    throw err;
  }
  const jsonStr = text.slice(start, end + 1);

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    const err = new Error("AI returned invalid JSON");
    err.statusCode = 502;
    err.raw = safeTrim(jsonStr, 400);
    throw err;
  }
}

function toNumberOrNull(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const x = Number(v.replace(/[^0-9.]/g, ""));
    return Number.isFinite(x) ? x : null;
  }
  return null;
}

function normalizeBillingPeriod(v) {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (!s) return null;
  return s;
}

/**
 * ---- Routes
 * POST /v1/classifySubscription
 * Auth: Bearer <Google ID token>
 * Body: { subject, from, excerpt }
 */
app.post("/v1/classifySubscription", async (req, res) => {
  try {
    const idToken = getBearerToken(req);
    if (!idToken) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    const payload = await verifyGoogleIdToken(idToken);
    const userEmail = payload?.email || null;

    const subject = String(req.body?.subject || "").trim();
    const from = String(req.body?.from || "").trim();
    const excerpt = String(req.body?.excerpt || "").trim();

    if (!subject || !from || !excerpt) {
      return res.status(400).json({
        error: "Missing required fields",
        required: ["subject", "from", "excerpt"],
      });
    }

    // Keep excerpt small / minimal (CASA-friendly)
    const clippedExcerpt = excerpt.length > 800 ? excerpt.slice(0, 800) : excerpt;

    const prompt = `
You are extracting subscription details from an email.
Return ONLY a single JSON object (no markdown, no extra text).

Email fields:
- subject: ${JSON.stringify(subject)}
- from: ${JSON.stringify(from)}
- excerpt: ${JSON.stringify(clippedExcerpt)}

Decide if this email indicates an active paid subscription or recurring billing.

Return JSON with exactly these keys:
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

Rules:
- If NOT a subscription, set is_subscription=false and all others null.
- currency should be like "USD", "CAD", "EUR" when possible.
- billing_period should be like "monthly", "yearly", "weekly", "quarterly" if you can infer it.
- is_apple_subscription true if it clearly looks like Apple/App Store billing, else false if clearly not, else null if unknown.
- price should be the recurring amount, not a one-time purchase.
`.trim();

    const openai = getOpenAIClient();

    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input: prompt,
    });

    const raw = response.output_text || "";
    const obj = parseModelJSON(raw);

    res.json({
      is_subscription: !!obj.is_subscription,
      subscription_name: typeof obj.subscription_name === "string" ? obj.subscription_name : null,
      merchant_name: typeof obj.merchant_name === "string" ? obj.merchant_name : null,
      price: toNumberOrNull(obj.price),
      currency: typeof obj.currency === "string" ? obj.currency : null,
      billing_period: normalizeBillingPeriod(obj.billing_period),
      billing_email:
        typeof obj.billing_email === "string" && obj.billing_email.trim()
          ? obj.billing_email.trim()
          : userEmail || null,
      is_apple_subscription:
        typeof obj.is_apple_subscription === "boolean" ? obj.is_apple_subscription : null,
    });
  } catch (err) {
    const status = err?.statusCode || 500;
    const message = String(err?.message || err);
    const raw = err?.raw;

    console.error("classifySubscription error:", err);

    res.status(status).json({
      error: status === 500 ? "Server error" : message,
      message: status === 500 ? message : undefined,
      raw: raw || undefined,
    });
  }
});

/**
 * POST /v1/deleteMyData
 * Auth: Bearer <Google ID token>
 * (You currently don’t store user data server-side, so this is just a verified ack.)
 */
app.post("/v1/deleteMyData", async (req, res) => {
  try {
    const idToken = getBearerToken(req);
    if (!idToken) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    await verifyGoogleIdToken(idToken);

    // If you later store derived subscription records, delete them here.
    res.json({ ok: true, deleted: true });
  } catch (err) {
    const status = err?.statusCode || 500;
    console.error("deleteMyData error:", err);
    res.status(status).json({ error: "Server error", message: String(err?.message || err) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));
