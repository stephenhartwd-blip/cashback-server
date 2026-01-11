import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";

const app = express();
app.set("trust proxy", 1); // Render is behind a proxy

/**
 * ---- Request logging (shows in Render Logs)
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
app.use(express.json({ limit: "200kb" }));
app.use(helmet());
app.use(cors({ origin: "*" })); // tighten later if you want

/**
 * ---- Health
 */
app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/healthz", (req, res) => res.status(200).json({ ok: true }));

/**
 * ---- Env
 */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

/**
 * ---- Clients
 */
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
function safeTrim(s, n = 600) {
  if (typeof s !== "string") return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function parseModelJSON(rawText) {
  const text = rawText || "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    const err = new Error("AI did not return JSON");
    err.statusCode = 502;
    err.raw = safeTrim(text, 600);
    throw err;
  }
  const jsonStr = text.slice(start, end + 1);

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    const err = new Error("AI returned invalid JSON");
    err.statusCode = 502;
    err.raw = safeTrim(jsonStr, 600);
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

function clamp01(x) {
  if (typeof x !== "number" || !Number.isFinite(x)) return 0.2;
  return Math.max(0, Math.min(1, x));
}

function normCountryCode(v) {
  const cc = (v || "US").toString().trim().toUpperCase();
  return cc.slice(0, 2) || "US";
}

/**
 * ---- Rate limits
 */
const priceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // 60 req/min per IP
});

const draftLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
});

/**
 * ---- Simple in-memory cache (24h) to reduce OpenAI calls
 * Keyed by: subscriptionName|countryCode
 */
const PRICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const priceCache = new Map(); // key -> { expiresAt, value }

/**
 * POST /api/price-suggest
 * Body: { subscriptionName: string, countryCode?: string }
 * Response:
 * {
 *   subscriptionName, countryCode, monthly, currency, plan, confidence, notes, verifiedAt, cacheHit
 * }
 */
app.post("/api/price-suggest", priceLimiter, async (req, res) => {
  try {
    const subscriptionName = String(req.body?.subscriptionName || "").trim();
    const countryCode = normCountryCode(req.body?.countryCode);

    if (!subscriptionName) {
      return res.status(400).json({ error: "subscriptionName is required" });
    }

    const cacheKey = `${subscriptionName.toLowerCase()}|${countryCode}`;
    const cached = priceCache.get(cacheKey);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
      return res.json({ ...cached.value, cacheHit: true });
    }

    const prompt = `
You estimate consumer subscription MONTHLY pricing by country.

Return ONLY a single JSON object (no markdown, no extra text) with exactly these keys:
{
  "monthly": number|null,
  "currency": string|null,
  "plan": string|null,
  "confidence": number,
  "notes": string
}

Rules:
- If you are not confident, set monthly=null and confidence <= 0.30.
- Use the most common individual plan price for that service in the given country.
- If multiple tiers exist, pick the most popular tier and name it in "plan".
- currency should be an ISO code like "USD", "CAD", "EUR", "GBP".
- confidence must be 0.0 to 1.0.

subscriptionName: ${JSON.stringify(subscriptionName)}
countryCode: ${JSON.stringify(countryCode)}
`.trim();

    const openai = getOpenAIClient();
    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input: prompt,
    });

    const raw = response.output_text || "";
    const obj = parseModelJSON(raw);

    const monthly = toNumberOrNull(obj.monthly);
    const currency = typeof obj.currency === "string" ? obj.currency.trim().toUpperCase() : null;
    const plan = typeof obj.plan === "string" ? obj.plan.trim() : null;
    const confidence = clamp01(toNumberOrNull(obj.confidence));
    const notes = typeof obj.notes === "string" ? safeTrim(obj.notes, 240) : "";

    const payload = {
      subscriptionName,
      countryCode,
      monthly: monthly != null && monthly >= 0 ? monthly : null,
      currency: currency || null,
      plan: plan || null,
      confidence,
      notes,
      verifiedAt: new Date().toISOString(),
      cacheHit: false,
    };

    priceCache.set(cacheKey, { expiresAt: now + PRICE_CACHE_TTL_MS, value: payload });

    return res.json(payload);
  } catch (err) {
    const status = err?.statusCode || 500;
    console.error("price-suggest error:", err);
    return res.status(status).json({
      error: status === 500 ? "Server error" : String(err?.message || err),
      raw: err?.raw || undefined,
    });
  }
});

/**
 * POST /api/draft-cancel-email
 * Body: { subscriptionName: string, userName?: string, accountEmail?: string, reason?: string }
 * Response: { subject, body }
 */
app.post("/api/draft-cancel-email", draftLimiter, async (req, res) => {
  try {
    const subscriptionName = String(req.body?.subscriptionName || "").trim();
    const userName = String(req.body?.userName || "").trim();
    const accountEmail = String(req.body?.accountEmail || "").trim();
    const reason = String(req.body?.reason || "").trim();

    if (!subscriptionName) {
      return res.status(400).json({ error: "subscriptionName is required" });
    }

    const prompt = `
You write short, clear cancellation emails.

Return ONLY JSON:
{
  "subject": string,
  "body": string
}

Context:
- subscriptionName: ${JSON.stringify(subscriptionName)}
- userName: ${JSON.stringify(userName || "")}
- accountEmail: ${JSON.stringify(accountEmail || "")}
- reason: ${JSON.stringify(reason || "")}

Requirements:
- Be polite, direct, and request confirmation in writing.
- If accountEmail is provided, include it in the body.
- If userName is provided, sign with it; otherwise sign "Customer".
`.trim();

    const openai = getOpenAIClient();
    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input: prompt,
    });

    const raw = response.output_text || "";
    const obj = parseModelJSON(raw);

    const subject =
      typeof obj.subject === "string" && obj.subject.trim()
        ? safeTrim(obj.subject.trim(), 120)
        : `Request to cancel ${subscriptionName}`;

    const body =
      typeof obj.body === "string" && obj.body.trim()
        ? safeTrim(obj.body.trim(), 2200)
        : `Hello ${subscriptionName} Support,\n\nPlease cancel my subscription effective immediately and stop all future charges.\n\nPlease confirm cancellation in writing.\n\nThank you,\nCustomer`;

    return res.json({ subject, body });
  } catch (err) {
    const status = err?.statusCode || 500;
    console.error("draft-cancel-email error:", err);
    return res.status(status).json({
      error: status === 500 ? "Server error" : String(err?.message || err),
      raw: err?.raw || undefined,
    });
  }
});

/**
 * ---- 404
 */
app.use((req, res) => res.status(404).json({ error: "Not found" }));

/**
 * ---- Start
 */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Cancel Compass server listening on port ${PORT}`));
