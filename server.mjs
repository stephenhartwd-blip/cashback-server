import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import OpenAI from "openai";

const app = express();
app.set("trust proxy", 1);

/**
 * ---- Request logging
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
app.use(express.json({ limit: "500kb" }));
app.use(helmet());
app.use(cors({ origin: "*" }));

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
 * ---- OpenAI client
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
function safeTrim(s, n = 1200) {
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
 * ---- Simple in-memory cache (24h)
 */
const PRICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const priceCache = new Map();

/**
 * POST /api/price-suggest
 */
app.post("/api/price-suggest", async (req, res) => {
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
 * ✅ NEW: POST /api/cancel-contact
 * Best-effort lookup for non-Apple subscriptions.
 * IMPORTANT: Always returns 200 so iOS never throws.
 *
 * Returns ONLY:
 * {
 *   email: string|null,
 *   cancelURL: string|null,
 *   confidence: number,
 *   notes: string
 * }
 */
app.post("/api/cancel-contact", async (req, res) => {
  // Always 200 response (never fail the app flow)
  try {
    const subscriptionName = String(req.body?.subscriptionName || "").trim();
    const countryCode = normCountryCode(req.body?.countryCode);

    if (!subscriptionName) {
      return res.status(200).json({
        email: null,
        cancelURL: null,
        confidence: 0.0,
        notes: "subscriptionName is required",
      });
    }

    const prompt = `
You help users cancel subscriptions.

Return ONLY JSON:
{
  "email": string|null,
  "cancelURL": string|null,
  "confidence": number,
  "notes": string
}

Rules:
- If uncertain, set fields to null and confidence <= 0.30.
- email must be a plausible support/billing/cancellations email for this company (only if confident).
- cancelURL must be the official cancellation / subscription management page URL (only if confident).
- Do NOT invent if unsure; use null.
- confidence must be 0.0 to 1.0.

subscriptionName: ${JSON.stringify(subscriptionName)}
countryCode: ${JSON.stringify(countryCode)}
`.trim();

    const openai = getOpenAIClient();

    const resp = await openai.responses.create({
      model: OPENAI_MODEL,
      input: prompt,
    });

    const raw = resp.output_text || "";
    const obj = parseModelJSON(raw);

    const email =
      typeof obj.email === "string" && obj.email.trim()
        ? safeTrim(obj.email.trim(), 200)
        : null;

    const cancelURL =
      typeof obj.cancelURL === "string" && obj.cancelURL.trim()
        ? safeTrim(obj.cancelURL.trim(), 500)
        : null;

    const confidence = clamp01(toNumberOrNull(obj.confidence));
    const notes = typeof obj.notes === "string" ? safeTrim(obj.notes, 240) : "";

    return res.status(200).json({ email, cancelURL, confidence, notes });
  } catch (err) {
    console.error("cancel-contact error:", err);
    // Never non-2xx
    return res.status(200).json({
      email: null,
      cancelURL: null,
      confidence: 0.0,
      notes: "Lookup unavailable right now — generating a cancel email draft instead.",
    });
  }
});

/**
 * POST /api/draft-cancel-email
 * ✅ Updated: Always returns 200 with a usable draft (never fails iOS flow)
 */
app.post("/api/draft-cancel-email", async (req, res) => {
  // Build a safe fallback draft first
  const subscriptionName = String(req.body?.subscriptionName || "").trim();
  const userName = String(req.body?.userName || "").trim();
  const accountEmail = String(req.body?.accountEmail || "").trim();
  const reason = String(req.body?.reason || "").trim();

  const fallbackSubject = subscriptionName
    ? `Request to cancel ${subscriptionName}`
    : "Request to cancel subscription";

  const fallbackBody = (() => {
    const sign = userName ? userName : "Customer";
    const lines = [];

    lines.push(`Hello Support,`);
    lines.push("");
    if (subscriptionName) {
      lines.push(`Please cancel my ${subscriptionName} subscription effective immediately and stop all future charges.`);
    } else {
      lines.push("Please cancel my subscription effective immediately and stop all future charges.");
    }

    if (accountEmail) {
      lines.push("");
      lines.push(`Account email: ${accountEmail}`);
    }

    if (reason) {
      lines.push("");
      lines.push(`Reason: ${reason}`);
    }

    lines.push("");
    lines.push("Please confirm cancellation in writing.");
    lines.push("");
    lines.push("Thank you,");
    lines.push(sign);

    return lines.join("\n");
  })();

  try {
    if (!subscriptionName) {
      // Still return 200 (so client doesn't throw)
      return res.status(200).json({ subject: fallbackSubject, body: fallbackBody });
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
        : fallbackSubject;

    const body =
      typeof obj.body === "string" && obj.body.trim()
        ? safeTrim(obj.body.trim(), 2200)
        : fallbackBody;

    // Always 200
    return res.status(200).json({ subject, body });
  } catch (err) {
    console.error("draft-cancel-email error:", err);
    // Always 200 with fallback draft
    return res.status(200).json({ subject: fallbackSubject, body: fallbackBody });
  }
});

/**
 * POST /api/cancel-assist
 * Returns:
 * - suggested support email + cancellation URL (best-effort)
 * - AND a drafted cancel email (subject/body)
 *
 * This endpoint is intentionally "suggestion-only" because models can be wrong.
 * The iOS app should let the user edit before sending.
 */
app.post("/api/cancel-assist", async (req, res) => {
  try {
    const subscriptionName = String(req.body?.subscriptionName || "").trim();
    const countryCode = normCountryCode(req.body?.countryCode);
    const userName = String(req.body?.userName || "").trim();
    const accountEmail = String(req.body?.accountEmail || "").trim();

    if (!subscriptionName) {
      return res.status(400).json({ error: "subscriptionName is required" });
    }

    const lookupPrompt = `
You help users cancel subscriptions.

Return ONLY JSON:
{
  "supportEmail": string|null,
  "cancelURL": string|null,
  "confidence": number,
  "notes": string
}

Rules:
- If uncertain, set fields to null and confidence <= 0.30.
- supportEmail must be a plausible support/billing email for this company.
- cancelURL must be the official cancellation / subscription management page URL.
- Do NOT invent if unsure; use null.
- confidence must be 0.0 to 1.0.

subscriptionName: ${JSON.stringify(subscriptionName)}
countryCode: ${JSON.stringify(countryCode)}
`.trim();

    const openai = getOpenAIClient();

    const lookupResp = await openai.responses.create({
      model: OPENAI_MODEL,
      input: lookupPrompt,
    });

    const lookupRaw = lookupResp.output_text || "";
    const lookupObj = parseModelJSON(lookupRaw);

    const supportEmail =
      typeof lookupObj.supportEmail === "string" && lookupObj.supportEmail.trim()
        ? lookupObj.supportEmail.trim()
        : null;

    const cancelURL =
      typeof lookupObj.cancelURL === "string" && lookupObj.cancelURL.trim()
        ? lookupObj.cancelURL.trim()
        : null;

    const confidence = clamp01(toNumberOrNull(lookupObj.confidence));
    const notes = typeof lookupObj.notes === "string" ? safeTrim(lookupObj.notes, 240) : "";

    // Draft email (reuse the same style you already had)
    const draftPrompt = `
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
- countryCode: ${JSON.stringify(countryCode)}
- supportEmail (if known): ${JSON.stringify(supportEmail || "")}

Requirements:
- Be polite, direct, and request confirmation in writing.
- If accountEmail is provided, include it in the body.
- If userName is provided, sign with it; otherwise sign "Customer".
- If cancelURL is present, include it as a helpful reference.
`.trim();

    const draftResp = await openai.responses.create({
      model: OPENAI_MODEL,
      input: draftPrompt,
    });

    const draftRaw = draftResp.output_text || "";
    const draftObj = parseModelJSON(draftRaw);

    const emailSubject =
      typeof draftObj.subject === "string" && draftObj.subject.trim()
        ? safeTrim(draftObj.subject.trim(), 120)
        : `Request to cancel ${subscriptionName}`;

    const emailBody =
      typeof draftObj.body === "string" && draftObj.body.trim()
        ? safeTrim(draftObj.body.trim(), 2400)
        : `Hello ${subscriptionName} Support,\n\nPlease cancel my subscription effective immediately and stop all future charges.\n\nPlease confirm cancellation in writing.\n\nThank you,\nCustomer`;

    return res.json({
      subscriptionName,
      countryCode,
      supportEmail,
      cancelURL,
      confidence,
      notes,
      emailSubject,
      emailBody,
    });
  } catch (err) {
    const status = err?.statusCode || 500;
    console.error("cancel-assist error:", err);
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
