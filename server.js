// HestiaFlow — penulisan ulang dari nol (v1 bersih).
// Stack: Node 22+, Express 4, node:sqlite, undici (proxy saja).
// Satu file backend, ditulis rapi per bagian. Tanpa secret, tanpa base URL
// upstream di-hardcode, tanpa nama asli provider (codename saja).
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { DatabaseSync } = require("node:sqlite");
const { ProxyAgent } = require("undici");

// ---------------- env ----------------
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || "http://localhost:" + PORT).replace(/\/$/, "");
const SESSION_SECRET = process.env.SESSION_SECRET || "";
if (!SESSION_SECRET) {
  console.error("[hestiaflow] SESSION_SECRET kosong — server gagal start. Set SESSION_SECRET di env.");
  process.exit(1);
}
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || (BASE_URL + "/auth/google/callback");
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const TEST_SECRET = process.env.TEST_SECRET || "";
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, "data", "hestiaflow.db");
const DB_IMPORT_TOKEN = process.env.DB_IMPORT_TOKEN || "";
const BANSOS_ENABLED = process.env.BANSOS_ENABLED !== "0";
const PRO_ENABLED = process.env.PRO_ENABLED === "1";
const BANSOS_KEYS = (process.env.BANSOS_UPSTREAM_KEYS || "").split(/[\s,]+/).filter(Boolean);
const MEDIA_ENV_KEYS = (process.env.RENDERFUL_API_KEYS || "").split(/[\s,]+/).filter(Boolean);
const GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL || "";

// Base upstream per brand — SELALU dari env, tidak pernah di-hardcode.
// Provider yang env-nya kosong gagal dengan pesan konfigurasi yang jelas.
function providerBase(brand) {
  const key = "PROVIDER_" + String(brand).toUpperCase() + "_UPSTREAM_URL";
  return (process.env[key] || "").replace(/\/$/, "");
}
// Turunan site dari base API (aturan generik, didokumentasikan di NOTES.md):
// hapus akhiran /v1 atau /api/v1, lalu ubah subdomain api. menjadi host biasa.
function siteBase(apiBase) {
  let b = String(apiBase || "").replace(/\/$/, "");
  b = b.replace(/\/api\/v1$/, "").replace(/\/v1$/, "");
  b = b.replace(/^https:\/\/api\./, "https://");
  return b;
}

// ---------------- konstanta ----------------
const TIER_RANK = { gratis: 0, plus: 1, pro: 2, premium: 3 };
const TIER_HARVEST_LIMIT = { gratis: 100, plus: 500, pro: 1500, premium: 5000, media: 500 };
const VOUCHER_DAYS = { plus: 3, pro: 7, premium: 14, media: 7 };
const BANSOS_MODELS = ["codestral-latest", "qwen3.6-27b", "gpt-oss-20b", "mistral-large-latest"];
const BANSOS_NOTES = {
  "codestral-latest": "Jago coding.",
  "qwen3.6-27b": "Jago coding.",
  "gpt-oss-20b": "Paling cepat.",
  "mistral-large-latest": "Paling jago untuk semua.",
};
// Nama model publik Bansos -> ID upstream (server-side saja, tidak diekspos publik).
const BANSOS_MODEL_MAP = {
  "codestral-latest": "codestral/codestral-latest",
  "qwen3.6-27b": "groq/qwen/qwen3.6-27b",
  "gpt-oss-20b": "groq/openai/gpt-oss-20b",
  "mistral-large-latest": "mistral/mistral-large-latest",
};
const BANSOS_DAILY_TOKENS = 500000;
const BANSOS_KEY_LIMIT = 2;
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
];
const FIRST_NAMES = ["Budi", "Sari", "Dewi", "Andi", "Rina", "Joko", "Maya", "Rizki", "Putri", "Adi", "Ayu", "Fajar", "Nadia", "Dimas", "Intan"];
const LAST_NAMES = ["Santoso", "Wijaya", "Pratama", "Lestari", "Nugraha", "Hidayat", "Kusuma", "Rahma", "Saputra", "Anggraini", "Susanto", "Permata"];
const PROXY_SOURCES = [
  "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all",
  "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&proxy_format=ipport&format=text",
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
];

// ---------------- util ----------------
function randHex(n) { return crypto.randomBytes(n).toString("hex"); }
function randUA() { return UA_POOL[Math.floor(Math.random() * UA_POOL.length)]; }
function randName() {
  return FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)] + " " +
    LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
}
function nowISO() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
// Fetch dengan timeout wajib — tidak ada fetch tanpa timeout di jalur panen/gateway.
async function fetchTimeout(url, opts, ms) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms || 15000) });
}
async function fetchJson(url, opts, ms) {
  const r = await fetchTimeout(url, opts, ms);
  const text = await r.text().catch(() => "");
  let json = null;
  try { json = JSON.parse(text); } catch { /* bukan JSON */ }
  return { ok: r.ok, status: r.status, json, text };
}
function safeJson(str, fallback) {
  try { const v = JSON.parse(str || ""); return v === null || v === undefined ? fallback : v; }
  catch { return fallback; }
}
function effectiveTierSlug(u) {
  if (!u) return "gratis";
  if (u.tier_expires_at && new Date(u.tier_expires_at) < new Date()) return "gratis";
  return u.tier_slug || "gratis";
}
function proEnabled() { return PRO_ENABLED; }
function bansosEnabled() { return BANSOS_ENABLED; }
function bansosDay() { return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); }

// ---------------- database ----------------
if (fs.existsSync(DB_PATH + ".imported")) {
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.renameSync(DB_PATH + ".imported", DB_PATH);
    console.log("[db-import] database hasil impor terpasang");
  } catch (e) { console.log("[db-import] swap gagal:", e.message); }
}
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, google_id TEXT UNIQUE, email TEXT UNIQUE, name TEXT, avatar TEXT, is_admin INTEGER DEFAULT 0, created_at TEXT, tier_slug TEXT DEFAULT 'gratis', tier_expires_at TEXT, suspended INTEGER DEFAULT 0, last_ip TEXT, last_ua TEXT, last_login_at TEXT, gratis_started_at TEXT);
CREATE TABLE IF NOT EXISTS tiers (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE, name TEXT, audience_label TEXT, badge TEXT, max_models INTEGER, sort_order INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS providers (id INTEGER PRIMARY KEY AUTOINCREMENT, tier_id INTEGER, brand_name TEXT, tagline TEXT, model_count INTEGER DEFAULT 0, model_list_json TEXT DEFAULT '[]', model_notes_json TEXT DEFAULT '{}', credit_note TEXT, default_credit INTEGER, sort_order INTEGER DEFAULT 0, upstream_name TEXT, upstream_url TEXT, upstream_api_key TEXT, FOREIGN KEY(tier_id) REFERENCES tiers(id));
CREATE TABLE IF NOT EXISTS workers (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER, name TEXT, credit INTEGER DEFAULT 0, status TEXT DEFAULT 'active', upstream_api_key TEXT, created_at TEXT, FOREIGN KEY(provider_id) REFERENCES providers(id));
CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, provider_id INTEGER, tier_id INTEGER, key_value TEXT, key_prefix TEXT, credit INTEGER, models_json TEXT DEFAULT '[]', model_source TEXT DEFAULT 'none', model_count INTEGER DEFAULT 0, status TEXT DEFAULT 'active', created_at TEXT, expires_at TEXT, anon_id TEXT, FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(provider_id) REFERENCES providers(id), FOREIGN KEY(tier_id) REFERENCES tiers(id));
CREATE TABLE IF NOT EXISTS harvested_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, api_key_id INTEGER, user_id INTEGER, provider_id INTEGER, tier_id INTEGER, temp_email TEXT, temp_password TEXT, upstream_api_key TEXT, upstream_base_url TEXT, created_at TEXT, fail_count INTEGER DEFAULT 0, cooldown_until TEXT, expires_at TEXT, FOREIGN KEY(api_key_id) REFERENCES api_keys(id));
CREATE TABLE IF NOT EXISTS harvest_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, provider_id INTEGER, message TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS harvest_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, provider_id INTEGER, count INTEGER, status TEXT DEFAULT 'pending', done_count INTEGER DEFAULT 0, live_count INTEGER DEFAULT 0, proxy_total INTEGER DEFAULT 0, api_key_id INTEGER, error TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS vouchers (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, tier_slug TEXT, duration_days INTEGER, used INTEGER DEFAULT 0, used_by INTEGER, used_at TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS bansos_usage (day TEXT, worker_id INTEGER, tokens INTEGER DEFAULT 0, requests INTEGER DEFAULT 0, PRIMARY KEY(day, worker_id));
CREATE TABLE IF NOT EXISTS media_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, api_key_id INTEGER, user_id INTEGER, media_type TEXT, model TEXT, prompt TEXT, cost_usd REAL, gen_id TEXT, source_url TEXT, drive_path TEXT, copy_status TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS proxy_pool (host TEXT, target TEXT, last_ok TEXT DEFAULT (datetime('now')), fails INTEGER DEFAULT 0, PRIMARY KEY(host, target));
`);

// ---------------- seed (SATU blok eksplisit) ----------------
const SEED_TIERS = [
  { slug: "gratis", name: "Gratis", audience: "KHUSUS PENGGUNA GRATIS", badge: "TIER GRATIS", maxModels: 8, sort: 1 },
  { slug: "plus", name: "Plus", audience: "UNTUK PENGGUNA PLUS / BERBAYAR", badge: "TIER PLUS", maxModels: null, sort: 2 },
  { slug: "pro", name: "Pro", audience: "UNTUK PENGGUNA PRO", badge: "TIER PRO", maxModels: null, sort: 3 },
  { slug: "premium", name: "Premium", audience: "PALING MAHAL", badge: "★ TIER PREMIUM", maxModels: null, sort: 4 },
  { slug: "media", name: "Media", audience: "UNTUK PENGGUNA MEDIA", badge: "TIER MEDIA", maxModels: null, sort: 5 },
];
const SEED_PROVIDERS = [
  { tier: "gratis", brand: "Luna", tagline: "8 model gratis untuk semua.", models: ["auto", "minimax/minimax-m3.1-flash:free", "google/gemma-4-31b-it:free", "google/gemma-4-26b-a4b-it:free", "xingchen-agi/xing4.0-29b-a4b:free", "cohere/north-mini-code:free", "recursive/flint-v1.0:free", "dots-studio/dots-3-note-preview:free"], notes: {}, creditNote: "Always-free BETA", credit: null, sort: 1 },
  { tier: "plus", brand: "Aurora", tagline: "Cahaya pertama di gerbang kecerdasan.", models: ["deepseek-v3.1", "deepseek-v3.2", "deepseek-v4-flash", "gemma-4-31B-it", "google/gemini-3-flash-preview", "google/gemini-3.1-flash-lite", "gpt-4o-mini", "gpt-oss-120b", "minimax-m2.7", "moonshotai.kimi-k2.5"], notes: {}, creditNote: "$0.20 per akun terverifikasi.", credit: 200000, sort: 1 },
  { tier: "pro", brand: "Nova", tagline: "Bintang baru yang bersinar terang.", models: ["claude-haiku-4.5", "claude-opus-4", "claude-opus-4.6", "claude-sonnet-4", "claude-sonnet-4-20250514", "claude-sonnet-4.6", "command-a", "command-r", "command-r-plus", "deepseek-chat", "deepseek-coder", "deepseek-reasoner", "gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-2.5-flash", "gemini-2.5-flash-preview", "gemini-2.5-pro", "gemini-3-flash", "minimax-text-01", "codestral", "mistral-large", "mistral-small", "dall-e-2", "dall-e-3", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4.5-preview", "gpt-4o", "gpt-4o-mini", "gpt-5-mini", "gpt-5.1", "gpt-image-1", "o3", "o3-mini", "o4-mini", "text-embedding-3-large", "text-embedding-3-small", "text-embedding-ada-002", "qwen-max", "qwen-plus", "qwen-turbo", "qwen-vl-max", "qwen-vl-plus", "qwen3-max", "qwen3.5-plus", "grok-3", "grok-3-mini", "grok-4"], notes: {}, creditNote: "283 ribu token per akun (saldo $0.1)", credit: 283000, sort: 1 },
  { tier: "pro", brand: "Vega", tagline: "Bintang penuntun untuk para profesional.", models: ["gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o-mini", "gpt-5-mini", "gpt-5-nano", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.6-luna", "gpt-6-luna", "gpt-oss-120b", "claude-haiku-4-5", "claude-haiku-5-5", "cf.gemma-4-26b-a4b-it", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-3.1-flash-lite-preview", "gemini-3.5-flash-lite", "gemini-3.7-flash", "gemini-3.8-flash", "cf.deepseek-r1-distill-qwen-32b", "deepseek-chat", "deepseek-v3.2", "deepseek-v3.2-speciale", "deepseek-v4-pro", "grok-4-fast-non-reasoning", "grok-4-fast-reasoning", "grok-4.20-beta-0309-non-reasoning", "grok-4.20-beta-0309-reasoning", "grok-4.20-non-reasoning", "grok-4.20-reasoning", "grok-4.3", "grok-4.5", "grok-4.7", "grok-code-fast-1", "cf.glm-5.2", "glm-5.1", "glm-5.2", "glm-5.3-flash", "cf.qwen2.5-coder-32b-instruct", "cf.qwq-32b", "qwen-flash-2025-07-28", "qwen-mt-flash", "qwen-plus-2025-12-01", "qwen-plus-character", "qwen3-coder-flash", "qwen3-vl-plus", "qwen3.5-122b-a10b", "qwen3.5-27b", "qwen3.5-35b-a3b", "qwen3.5-flash", "qwen3.5-plus", "qwen3.6-27b", "qwen3.6-35b-a3b", "qwen3.6-flash", "qwen3.6-plus", "qwen3.7-plus", "qwen3.8-27b", "qwen3.8-flash", "cf.kimi-k2.7-code", "kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "cf.llama-3.1-8b-instruct-fast", "cf.llama-3.2-1b-instruct", "cf.llama-3.2-3b-instruct", "cf.llama-3.3-70b-instruct-fp8-fast", "cf.llama-4-scout-17b-16e-instruct", "cf.mistral-small-3.1-24b-instruct", "mistral-large-3", "mistral-small-2503", "minimax-m2.5", "minimax-m2.5-lightning", "minimax-m2.7", "minimax-m2.7-highspeed", "cf.granite-4.0-h-micro", "nemotron-3-ultra", "nemotron-3.5-lightning"], notes: {}, creditNote: "25 ribu kredit per akun (±7 hari).", credit: 25000, sort: 1 },
  { tier: "premium", brand: "Stella", tagline: "190 model premium! $0.25 per akun.", models: ["openai/gpt-3.5-turbo-0613", "openai/gpt-3.5-turbo-16k", "openai/gpt-4", "openai/gpt-4.1", "openai/gpt-4.1-mini", "openai/gpt-4.1-nano", "openai/gpt-4o", "openai/gpt-4o-2024-05-13", "openai/gpt-4o-2024-08-06", "openai/gpt-4o-2024-11-20", "openai/gpt-4o-mini", "openai/gpt-4o-mini-2024-07-18", "openai/gpt-5.1", "openai/gpt-5.1-codex", "openai/gpt-5.1-codex-mini", "openai/gpt-5.2", "openai/gpt-5.2-codex", "openai/gpt-5.2-pro", "openai/gpt-5.3-codex", "openai/gpt-5.4", "openai/gpt-5.4-image-2", "openai/gpt-5.4-mini", "openai/gpt-5.4-nano", "openai/gpt-5.5", "openai/gpt-5.5-pro", "openai/gpt-5.6-luna", "openai/gpt-5.6-luna-pro", "openai/gpt-5.6-sol", "openai/gpt-5.6-sol-pro", "openai/gpt-5.6-terra", "openai/gpt-5.6-terra-pro", "openai/gpt-6-astra", "openai/gpt-6-astra-pro", "openai/gpt-6-luna", "openai/gpt-6-luna-pro", "openai/gpt-6-sol", "openai/gpt-6-sol-pro", "openai/gpt-6.1-sol", "openai/gpt-6.1-sol-pro", "anthropic/claude-fable-5", "anthropic/claude-fable-5.1", "anthropic/claude-haiku-4.5", "anthropic/claude-haiku-5.5", "anthropic/claude-opus-4.1", "anthropic/claude-opus-4.5", "anthropic/claude-opus-4.6", "anthropic/claude-opus-4.7", "anthropic/claude-opus-4.8", "anthropic/claude-sonnet-4.5", "anthropic/claude-sonnet-4.6", "anthropic/claude-sonnet-5", "anthropic/claude-sonnet-5.5", "google/gemini-2.5-flash", "google/gemini-2.5-flash-image", "google/gemini-2.5-flash-lite", "google/gemini-2.5-pro", "google/gemini-2.5-pro-preview", "google/gemini-3-flash-preview", "google/gemini-3.1-flash-image", "google/gemini-3.1-flash-image-preview", "google/gemini-3.1-flash-lite", "google/gemini-3.1-flash-lite-image", "google/gemini-3.1-flash-lite-preview", "google/gemini-3.5-flash", "google/gemini-3.5-flash-lite", "google/gemini-3.7-flash", "google/gemini-3.8-flash", "google/gemini-4-argon", "google/gemma-2-27b-it", "google/gemma-3-12b-it", "google/gemma-3-27b-it", "google/gemma-3-4b-it", "google/gemma-4-26b-a4b-it", "google/gemma-4-31b-it", "deepseek/deepseek-chat", "deepseek/deepseek-chat-v3-0324", "deepseek/deepseek-chat-v3.1", "deepseek/deepseek-r1-0528", "deepseek/deepseek-v3.1-terminus", "deepseek/deepseek-v3.2", "deepseek/deepseek-v3.2-exp", "deepseek/deepseek-v4-flash-0731", "deepseek/deepseek-v4-pro-0813", "x-ai/grok-4.20", "x-ai/grok-4.20-multi-agent", "x-ai/grok-4.3", "x-ai/grok-4.5", "x-ai/grok-4.6", "x-ai/grok-4.7", "x-ai/grok-build-0.1", "z-ai/glm-4.5-air", "z-ai/glm-5.3-prime", "qwen/qwen-2.5-72b-instruct", "qwen/qwen-2.5-7b-instruct", "qwen/qwen-2.5-coder-32b-instruct", "qwen/qwen-plus", "qwen/qwen2.5-vl-72b-instruct", "qwen/qwen3-235b-a22b-2507", "qwen/qwen3-30b-a3b-instruct-2507", "qwen/qwen3-coder", "qwen/qwen3-coder-30b-a3b-instruct", "qwen/qwen3-coder-flash", "qwen/qwen3-coder-next", "qwen/qwen3-next-80b-a3b-instruct", "qwen/qwen3-vl-235b-a22b-instruct", "qwen/qwen3-vl-30b-a3b-instruct", "qwen/qwen3-vl-30b-a3b-thinking", "qwen/qwen3-vl-8b-instruct", "qwen/qwen3.5-122b-a10b", "qwen/qwen3.5-27b", "qwen/qwen3.5-flash-02-23", "qwen/qwen3.6-27b", "qwen/qwen3.8-omni-flash", "moonshotai/kimi-k2-0905", "moonshotai/kimi-k2-thinking", "moonshotai/kimi-k3", "meta-llama/llama-3.1-70b-instruct", "meta-llama/llama-3.1-8b-instruct", "meta-llama/llama-3.2-1b-instruct", "meta-llama/llama-3.2-3b-instruct", "meta-llama/llama-3.3-70b-instruct", "meta-llama/llama-4-maverick", "meta-llama/llama-4-scout", "meta-llama/llama-guard-4-12b", "mistralai/codestral-2508", "mistralai/devstral-2512", "mistralai/ministral-14b-2512", "mistralai/ministral-3b-2512", "mistralai/ministral-8b-2512", "mistralai/mistral-large", "mistralai/mistral-large-2407", "mistralai/mistral-medium-3", "mistralai/mistral-medium-3-5", "mistralai/mistral-medium-3.1", "mistralai/mistral-nemo", "mistralai/mistral-saba", "mistralai/mistral-small-24b-instruct-2501", "mistralai/mistral-small-2603", "mistralai/mistral-small-3.1-24b-instruct", "mistralai/mistral-small-3.2-24b-instruct", "mistralai/mixtral-8x22b-instruct", "mistralai/voxtral-small-24b-2507", "minimax/minimax-01", "minimax/minimax-m2-her", "minimax/minimax-m3", "amazon/nova-2-lite-v1", "amazon/nova-lite-v1", "amazon/nova-micro-v1", "amazon/nova-pro-v1", "bytedance/ui-tars-1.5-7b", "cohere/command-a", "cohere/command-r-08-2024", "cohere/command-r-plus-08-2024", "cohere/command-r7b-12-2024", "ibm-granite/granite-4.0-h-micro", "inception/mercury-3", "inference-net/schematron-v2-small", "inference-net/schematron-v2-turbo", "microsoft/phi-4", "moondream/moondream3-preview", "moondream/moondream3.1-9b-a2b", "morph/morph-v3-fast", "morph/morph-v3-large", "nex-agi/nex-n2.5-mini", "nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-3.5-lightning", "perceptron/perceptron-mk1", "perceptron/perceptron-mk1.5", "perplexity/sonar", "perplexity/sonar-pro", "poolside/laguna-s-2.1", "rekaai/reka-edge", "relace/relace-search", "sakana/fugu-max", "sakana/fugu-ultra-v2", "scaledown/summarize", "stepfun/step-3.5-flash", "tencent/hunyuan-a13b-instruct", "tencent/hy-mt2-1.8b", "tencent/hy-mt2-30b-a3b", "tencent/hy-mt2-7b", "upstage/solar-mini4", "upstage/solar-pro-3", "upstage/solar-pro4", "writer/palmyra-x5", "xiaomi/mimo-v2.5", "xiaomi/mimo-v2.5-pro", "xiaomi/mimo-v2.6-flash", "xiaomi/mimo-v2.6-pro", "xiaomi/mimo-v2.6-pro-ultraspeed"], notes: {}, creditNote: "$0.25 per akun.", credit: 250000, sort: 1 },
  { tier: null, brand: "Bansos", tagline: "Token gratis untuk semua pengguna.", models: BANSOS_MODELS, notes: BANSOS_NOTES, creditNote: "4.5 juta token per hari untuk semua pengguna.", credit: null, sort: 99 },
  { tier: "media", brand: "Media", tagline: "Gambar & video dalam satu tier.", models: ["flux-schnell", "z-image", "grok-imagine-image", "wan-2.2", "flux-dev", "gpt-image-2", "seedream-5.0-lite", "seededit-3.0-i2i", "grok-imagine-image-i2i", "seedream-4-i2i", "flux-kontext-pro-i2i", "flux-2-i2i", "nano-banana-pro-i2i", "gpt-image-2-i2i", "seedance-1.5-pro", "seedance-1.0-pro-fast", "bytedance-video-upscaler", "lucy-restyle", "lucy-edit", "wan-2.7-videoedit", "seedance-2.0-video-edit", "happyhorse-1.0-video-edit"], notes: {}, creditNote: "Saldo per akun, tanpa kuota key.", credit: null, sort: 1 },
];
const MEDIA_IMAGE = ["flux-schnell", "z-image", "grok-imagine-image", "wan-2.2", "flux-dev", "gpt-image-2", "seedream-5.0-lite"];
const MEDIA_I2I = ["seededit-3.0-i2i", "grok-imagine-image-i2i", "seedream-4-i2i", "flux-kontext-pro-i2i", "flux-2-i2i", "nano-banana-pro-i2i", "gpt-image-2-i2i"];
const MEDIA_VIDEO = ["seedance-1.5-pro", "seedance-1.0-pro-fast"];
const MEDIA_V2V = ["bytedance-video-upscaler", "lucy-restyle", "lucy-edit", "wan-2.7-videoedit", "seedance-2.0-video-edit", "happyhorse-1.0-video-edit"];

function seed() {
  for (const t of SEED_TIERS) {
    db.prepare("INSERT OR IGNORE INTO tiers (slug,name,audience_label,badge,max_models,sort_order) VALUES (?,?,?,?,?,?)")
      .run(t.slug, t.name, t.audience, t.badge, t.maxModels, t.sort);
    db.prepare("UPDATE tiers SET name=?, audience_label=?, badge=?, max_models=?, sort_order=? WHERE slug=?")
      .run(t.name, t.audience, t.badge, t.maxModels, t.sort, t.slug);
  }
  for (const p of SEED_PROVIDERS) {
    const tierId = p.tier ? db.prepare("SELECT id FROM tiers WHERE slug=?").get(p.tier)?.id ?? null : null;
    const base = providerBase(p.brand);
    const existing = db.prepare("SELECT id, upstream_api_key FROM providers WHERE brand_name=?").get(p.brand);
    if (!existing) {
      db.prepare("INSERT INTO providers (tier_id,brand_name,tagline,model_count,model_list_json,model_notes_json,credit_note,default_credit,sort_order,upstream_url) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(tierId, p.brand, p.tagline, p.models.length, JSON.stringify(p.models), JSON.stringify(p.notes), p.creditNote, p.credit, p.sort, base || null);
    } else {
      // Seed memperbarui katalog/tagline/credit, tapi TIDAK pernah menimpa upstream_api_key.
      db.prepare("UPDATE providers SET tier_id=?, tagline=?, model_count=?, model_list_json=?, model_notes_json=?, credit_note=?, default_credit=?, sort_order=?, upstream_url=? WHERE id=?")
        .run(tierId, p.tagline, p.models.length, JSON.stringify(p.models), JSON.stringify(p.notes), p.creditNote, p.credit, p.sort, base || null, existing.id);
    }
  }
  // Worker Bansos dari env (satu worker per key, credit harian 500000).
  const bansos = db.prepare("SELECT id FROM providers WHERE brand_name='Bansos'").get();
  if (bansos) {
    for (const k of BANSOS_KEYS) {
      const w = db.prepare("SELECT id FROM workers WHERE provider_id=? AND upstream_api_key=?").get(bansos.id, k);
      if (!w) db.prepare("INSERT INTO workers (provider_id,name,credit,status,upstream_api_key,created_at) VALUES (?,?,?,?,?,?)")
        .run(bansos.id, "Bansos", BANSOS_DAILY_TOKENS, "active", k, nowISO());
    }
  }
  if (!db.prepare("SELECT value FROM settings WHERE key='gateway_name'").get())
    db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('gateway_name','HestiaFlow')").run();
  if (!db.prepare("SELECT value FROM settings WHERE key='base_url'").get())
    db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('base_url',?)").run(GATEWAY_BASE_URL || BASE_URL);
}
seed();
function setting(key) { return db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value ?? null; }
function providerById(id) { return db.prepare("SELECT * FROM providers WHERE id=?").get(id) || null; }
function providerByBrand(brand) { return db.prepare("SELECT * FROM providers WHERE brand_name=?").get(brand) || null; }
function tierById(id) { return id ? db.prepare("SELECT * FROM tiers WHERE id=?").get(id) || null : null; }
function tierBySlug(slug) { return db.prepare("SELECT * FROM tiers WHERE slug=?").get(slug) || null; }
function providerModels(p) { return safeJson(p.model_list_json, []); }

// ---------------- sesi & auth ----------------
function signSession(uid) {
  const exp = Date.now() + 30 * 24 * 3600 * 1000;
  const payload = uid + "." + exp;
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return payload + "." + sig;
}
function verifySession(cookieVal) {
  if (!cookieVal) return null;
  const parts = cookieVal.split(".");
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  if (Date.now() > Number(exp)) return null;
  const expect = crypto.createHmac("sha256", SESSION_SECRET).update(uid + "." + exp).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  return Number(uid);
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionUser(req) {
  const uid = verifySession(parseCookies(req).hestia_session);
  if (!uid) return null;
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(uid);
  return u || null;
}
function isAdminUser(u) {
  if (!u) return false;
  if (u.is_admin) return true;
  return ADMIN_EMAILS.includes(String(u.email).toLowerCase());
}
function requireAuth(req, res, next) {
  const u = sessionUser(req);
  if (!u) return res.status(401).json({ ok: false, error: "login_required" });
  if (u.suspended) return res.status(403).json({ ok: false, error: "suspended" });
  req.user = u;
  next();
}
function requireAdmin(req, res, next) {
  const u = sessionUser(req);
  if (!u || !isAdminUser(u)) return res.status(403).json({ ok: false, error: "admin_required" });
  req.user = u;
  next();
}
function trackLogin(req, userId) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
  db.prepare("UPDATE users SET last_ip=?, last_ua=?, last_login_at=? WHERE id=?")
    .run(ip, req.headers["user-agent"] || "", nowISO(), userId);
}
// Rate limit in-memory sederhana: {key: {n, resetAt}}.
const rateBuckets = new Map();
function rateLimit(maxPerMin) {
  return (req, res, next) => {
    const ip = req.socket.remoteAddress || "unknown";
    const key = req.path + "|" + ip;
    const now = Date.now();
    let b = rateBuckets.get(key);
    if (!b || now > b.resetAt) { b = { n: 0, resetAt: now + 60000 }; rateBuckets.set(key, b); }
    b.n++;
    if (b.n > maxPerMin) return res.status(429).json({ ok: false, error: "rate_limited" });
    next();
  };
}

// ---------------- proxy ----------------
let proxyCache = { list: [], at: 0 };
async function fetchProxyList() {
  if (Date.now() - proxyCache.at < 5 * 60 * 1000 && proxyCache.list.length) return proxyCache.list;
  const found = [];
  for (const src of PROXY_SOURCES) {
    try {
      const r = await fetchTimeout(src, { headers: { "User-Agent": randUA() } }, 15000);
      const text = await r.text().catch(() => "");
      const lines = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(s));
      for (const line of lines.slice(0, 100)) if (!found.includes(line)) found.push(line);
    } catch { /* sumber mati, lanjut ke sumber berikut */ }
    if (found.length >= 300) break;
  }
  proxyCache = { list: found.slice(0, 300), at: Date.now() };
  return proxyCache.list;
}
function proxyDispatcher(hostPort) {
  try { return new ProxyAgent("http://" + hostPort); } catch { return null; }
}
// Kumpul proxy SEKALI per panen: acak, batch 10 paralel, berhenti pada 30 lolos.
// Probe: GET probeUrl lewat proxy, lolos bila status > 0 (respons apa pun).
async function collectProxyPool(probeUrl, timeoutMs) {
  const cand = [...await fetchProxyList()].sort(() => Math.random() - 0.5);
  const ok = [];
  for (let i = 0; i < cand.length && ok.length < 30; i += 10) {
    const batch = cand.slice(i, i + 10);
    const checks = await Promise.all(batch.map(async (p) => {
      try {
        const d = proxyDispatcher(p);
        if (!d) return null;
        const r = await fetchTimeout(probeUrl, { dispatcher: d, headers: { "User-Agent": randUA() } }, timeoutMs);
        return r && r.status > 0 ? p : null;
      } catch { return null; }
    }));
    for (const p of checks) if (p) ok.push(p);
  }
  return ok;
}
function randTempEmail() {
  const name = (FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)]).toLowerCase();
  return name + Math.floor(10000 + Math.random() * 89999) + (Date.now() % 100000) + "@tempomail.id";
}
function randTempPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 12; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s + "1!";
}

// ---------------- mesin panen per brand ----------------
// Setiap mesin menerima pool proxy yang sudah dikumpulkan sekali per panen
// (kecuali Vega/Media yang punya mekanisme sendiri, sesuai SPEC).
// Kembalian: { upstreamApiKey, upstreamBaseUrl, tempEmail, tempPassword, live }
// atau null bila gagal. Semua fetch bertimeout. TIDAK ADA fallback ke direct.
function proxyFetch(hostPort, url, opts, ms) {
  const d = proxyDispatcher(hostPort);
  if (!d) return Promise.resolve(null);
  return fetchTimeout(url, { ...opts, dispatcher: d }, ms).catch(() => null);
}
async function pickProxy(pool, url, opts, ms) {
  // Coba pool satu per satu sampai ada yang merespons (maks 10 percobaan).
  for (const p of (pool || []).slice(0, 10)) {
    const r = await proxyFetch(p, url, opts, ms);
    if (r) return { proxy: p, res: r };
  }
  return null;
}
function cookieJar() {
  const jar = {};
  return {
    header() { return Object.entries(jar).map(([k, v]) => k + "=" + v).join("; "); },
    store(res) {
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of raw) {
        const m = c.match(/^([^=]+)=([^;]*)/);
        if (m) jar[m[1]] = m[2];
      }
    },
  };
}
async function jsonBody(res) {
  if (!res) return null;
  try { return await res.json(); } catch { return null; }
}

// Luna: register -> csrf -> login kredensial -> buat key -> verifikasi /models.
async function engineLuna(provider, pool) {
  const apiBase = providerBase("Luna");
  if (!apiBase) return null;
  const site = siteBase(apiBase);
  const email = randTempEmail();
  const password = randTempPassword();
  const name = randName();
  const jar = cookieJar();
  const reg = await pickProxy(pool, site + "/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": randUA() },
    body: JSON.stringify({ name, email, password }),
  }, 25000);
  if (!reg || reg.res.status !== 200) return null;
  jar.store(reg.res);
  const csrfRes = await proxyFetch(reg.proxy, site + "/api/auth/csrf", { headers: { "User-Agent": randUA(), Cookie: jar.header() } }, 15000);
  if (!csrfRes) return null;
  jar.store(csrfRes);
  const csrfJson = await jsonBody(csrfRes);
  const csrf = csrfJson && csrfJson.csrfToken;
  if (!csrf) return null;
  const form = new URLSearchParams({ csrfToken: csrf, email, password, json: "true" });
  const login = await proxyFetch(reg.proxy, site + "/api/auth/callback/credentials", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": randUA(), Cookie: jar.header() },
    body: form.toString(),
  }, 25000);
  if (!login || login.status !== 200) return null;
  jar.store(login);
  const keyRes = await proxyFetch(reg.proxy, site + "/api/keys", {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": randUA(), Cookie: jar.header() },
    body: JSON.stringify({ name: "key-1" }),
  }, 25000);
  if (!keyRes || (keyRes.status !== 200 && keyRes.status !== 201)) return null;
  const keyJson = await jsonBody(keyRes);
  const key = keyJson && (keyJson.key || keyJson.apiKey || (keyJson.data && keyJson.data.key));
  if (!key || typeof key !== "string") return null;
  const verify = await proxyFetch(reg.proxy, apiBase + "/models", { headers: { Authorization: "Bearer " + key, "User-Agent": randUA() } }, 20000);
  if (!verify || verify.status !== 200) return null;
  return { upstreamApiKey: key, upstreamBaseUrl: apiBase, tempEmail: email, tempPassword: password, live: true };
}

// Nova: mesin generik (register -> saldo -> key -> verifikasi).
async function engineNova(provider, pool) {
  const apiBase = providerBase("Nova");
  if (!apiBase) return null;
  const email = randTempEmail();
  const password = randTempPassword();
  const name = randName();
  const reg = await pickProxy(pool, apiBase + "/v1/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": randUA() },
    body: JSON.stringify({ email, password, name }),
  }, 25000);
  if (!reg || !reg.res.ok) return null;
  const regJson = await jsonBody(reg.res);
  const token = regJson && (regJson.token || regJson.access_token || (regJson.data && regJson.data.token));
  if (!token) return null;
  const keyRes = await proxyFetch(reg.proxy, apiBase + "/v1/keys", {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": randUA(), Authorization: "Bearer " + token },
    body: JSON.stringify({ name: "key-1" }),
  }, 25000);
  if (!keyRes || !keyRes.ok) return null;
  const keyJson = await jsonBody(keyRes);
  const key = keyJson && (keyJson.key || keyJson.apiKey || (keyJson.data && keyJson.data.key));
  if (!key || typeof key !== "string") return null;
  const verify = await proxyFetch(reg.proxy, apiBase + "/v1/models", { headers: { Authorization: "Bearer " + key, "User-Agent": randUA() } }, 20000);
  if (!verify || verify.status !== 200) return null;
  return { upstreamApiKey: key, upstreamBaseUrl: apiBase, tempEmail: email, tempPassword: password, live: true };
}

// Aurora: relay bila env tersedia, lalu jalur Supabase (auth host dari env
// ROOYAI_SUPABASE_URL, tanpa turunan hardcode). Verifikasi via {apiBase}/models.
async function engineAurora(provider, pool) {
  const apiBase = providerBase("Aurora");
  if (!apiBase) return null;
  const email = randTempEmail();
  const password = randTempPassword();
  const relay = (process.env.BESTLLM_RELAY_URL || "").replace(/\/$/, "");
  if (relay) {
    const r = await pickProxy(pool, relay + "/v1/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json", "User-Agent": randUA() },
      body: JSON.stringify({ email, password, name: randName() }),
    }, 25000);
    if (r && r.res.ok) {
      const j = await jsonBody(r.res);
      const key = j && (j.key || j.apiKey || (j.data && j.data.key));
      if (key) {
        const v = await proxyFetch(r.proxy, apiBase + "/models", { headers: { Authorization: "Bearer " + key, "User-Agent": randUA() } }, 20000);
        if (v && v.status === 200) return { upstreamApiKey: key, upstreamBaseUrl: apiBase, tempEmail: email, tempPassword: password, live: true };
      }
    }
  }
  const anon = process.env.ROOYAI_SUPABASE_ANON_KEY || "";
  const authHost = (process.env.ROOYAI_SUPABASE_URL || "").replace(/\/$/, "");
  if (!anon || !authHost) return null;
  const signup = await pickProxy(pool, authHost + "/auth/v1/signup", {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": randUA(), apikey: anon, Authorization: "Bearer " + anon },
    body: JSON.stringify({ email, password }),
  }, 25000);
  if (!signup || !signup.res.ok) return null;
  const sj = await jsonBody(signup.res);
  const token = sj && sj.access_token;
  if (!token) return null;
  const keyRes = await proxyFetch(signup.proxy, authHost + "/rest/v1/api_keys", {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": randUA(), apikey: anon, Authorization: "Bearer " + token },
    body: JSON.stringify({ name: "key-1" }),
  }, 25000);
  if (!keyRes || !keyRes.ok) return null;
  const kj = await jsonBody(keyRes);
  const key = kj && (kj.key || kj.apiKey || (Array.isArray(kj) && kj[0] && kj[0].key));
  if (!key || typeof key !== "string") return null;
  const verify = await proxyFetch(signup.proxy, apiBase + "/models", { headers: { Authorization: "Bearer " + key, "User-Agent": randUA() } }, 20000);
  if (!verify || verify.status !== 200) return null;
  return { upstreamApiKey: key, upstreamBaseUrl: apiBase, tempEmail: email, tempPassword: password, live: true };
}

// Stella: signup langsung -> verifikasi /models.
async function engineStella(provider, pool) {
  const apiBase = providerBase("Stella");
  if (!apiBase) return null;
  const site = siteBase(apiBase);
  const email = "near" + Date.now() + Math.floor(Math.random() * 10000) + "@tempomail.id";
  const password = "Near" + Math.floor(100000 + Math.random() * 900000) + "@#";
  const r = await pickProxy(pool, site + "/api/signup", {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": randUA() },
    body: JSON.stringify({ email, password }),
  }, 25000);
  if (!r || !r.res.ok) return null;
  const j = await jsonBody(r.res);
  const key = j && (j.key || j.apiKey || (j.data && j.data.key));
  if (!key || typeof key !== "string") return null;
  const verify = await proxyFetch(r.proxy, apiBase + "/models", { headers: { Authorization: "Bearer " + key, "User-Agent": randUA() } }, 20000);
  if (!verify || verify.status !== 200) return null;
  return { upstreamApiKey: key, upstreamBaseUrl: apiBase, tempEmail: email, tempPassword: password, live: true };
}

// Vega: pool proxy_pool + CSRF, lalu alur register/OTP/kunci platform.
// (Alur direkonstruksi dari jejak endpoint; wajib validasi staging — lihat NOTES.md.)
async function engineVega(provider) {
  const apiBase = providerBase("Vega");
  if (!apiBase) return null;
  const authBase = apiBase.replace("://api.", "://chat.").replace(/\/v1$/, "");
  const poolRows = db.prepare("SELECT host FROM proxy_pool WHERE target='vega' AND fails=0 ORDER BY last_ok DESC LIMIT 3").all();
  const email = randTempEmail();
  const password = randTempPassword();
  for (const row of poolRows) {
    const d = proxyDispatcher(row.host);
    if (!d) continue;
    let csrf = null;
    try {
      const cr = await fetchTimeout(authBase + "/api/auth/csrf/", { dispatcher: d, headers: { "User-Agent": randUA() } }, 8000);
      if (cr.status >= 500) continue;
      const cj = await cr.json().catch(() => null);
      csrf = cj && (cj.csrfToken || cj.csrf);
    } catch { continue; }
    // Inbox sementara (noopmail) untuk OTP.
    let inbox = null;
    try {
      const ib = await fetchTimeout(authBase + "/api/noopmail/create", { dispatcher: d, headers: { "User-Agent": randUA() } }, 15000);
      inbox = await ib.json().catch(() => null);
    } catch { /* lanjut tanpa inbox */ }
    const inboxEmail = (inbox && (inbox.email || inbox.address)) || email;
    let reg = null;
    try {
      reg = await fetchTimeout(authBase + "/api/auth/register", {
        method: "POST", dispatcher: d,
        headers: { "Content-Type": "application/json", "User-Agent": randUA() },
        body: JSON.stringify({ email: inboxEmail, password, csrfToken: csrf || undefined }),
      }, 25000);
    } catch { continue; }
    if (!reg || !reg.ok) continue;
    const rj = await reg.json().catch(() => null);
    const token = rj && (rj.token || rj.access_token || (rj.data && rj.data.token));
    const keyRes = token ? await fetchTimeout(authBase + "/api/platform/create-key/", {
      method: "POST", dispatcher: d,
      headers: { "Content-Type": "application/json", "User-Agent": randUA(), Authorization: "Bearer " + token },
      body: JSON.stringify({ name: "key-1" }),
    }, 25000).catch(() => null) : null;
    const kj = keyRes ? await keyRes.json().catch(() => null) : null;
    const key = kj && (kj.key || kj.apiKey || (kj.data && kj.data.key));
    if (key && typeof key === "string") {
      return { upstreamApiKey: key, upstreamBaseUrl: apiBase, tempEmail: inboxEmail, tempPassword: password, live: true };
    }
  }
  return null;
}

// Media: proxy segar per langkah (maks 3 percobaan per langkah), alur:
// kunci Firebase -> inbox -> magic link -> signin -> developer -> api key -> saldo.
async function mediaFreshProxy(site) {
  const cand = [...await fetchProxyList()].sort(() => Math.random() - 0.5).slice(0, 40);
  const checks = await Promise.all(cand.map(async (p) => {
    try {
      const d = proxyDispatcher(p);
      if (!d) return null;
      const r = await fetchTimeout(site + "/signup", { dispatcher: d, headers: { "User-Agent": randUA() } }, 7000);
      const b = await r.text().catch(() => "");
      return r.status === 200 && b.includes("/_next/static/chunks/") ? p : null;
    } catch { return null; }
  }));
  const ok = checks.filter(Boolean);
  return ok.length ? ok[0] : null;
}
async function mediaStep(name, ms, fn) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const site = siteBase(providerBase("Media"));
    const proxy = await mediaFreshProxy(site);
    if (!proxy) { if (attempt === 3) return { ok: false, reason: "no_proxy" }; continue; }
    const F = async (url, opts, timeoutMs) => {
      const d = proxyDispatcher(proxy);
      if (!d) return null;
      try { return await fetchTimeout(url, { ...opts, headers: { ...(opts.headers || {}), "User-Agent": randUA() }, dispatcher: d }, timeoutMs || ms); }
      catch { return null; }
    };
    try {
      const out = await fn(F);
      if (out && out.ok) return out;
      const reason = (out && out.reason) || "timeout";
      if (attempt === 3) return { ok: false, reason };
    } catch { if (attempt === 3) return { ok: false, reason: "timeout" }; }
  }
  return { ok: false, reason: "timeout" };
}
let mediaFirebaseKey = null;
async function engineMedia() {
  const apiBase = providerBase("Media");
  if (!apiBase) return null;
  const site = siteBase(apiBase);
  const balanceUrl = apiBase.replace(/\/v1$/, "") + "/api/v1/account/balance";
  const fb = await mediaStep("firebase", 30000, async (F) => {
    if (mediaFirebaseKey) return { ok: true, key: mediaFirebaseKey };
    const r = await F(site + "/signup", {}, 30000);
    if (!r || r.status !== 200) return { ok: false, reason: "status=" + (r ? r.status : "none") };
    const html = await r.text();
    const paths = [...new Set([...html.matchAll(/\/_next\/static\/chunks\/[^"' \s]+\.js/g)].map((m) => m[0]))];
    if (!paths.length) return { ok: false, reason: "no-chunks" };
    for (const p of paths) {
      const cr = await F(site + p, {}, 30000);
      if (!cr || cr.status !== 200) continue;
      const js = await cr.text();
      if (!js.includes("firebase")) continue;
      const m = js.match(/AIza[0-9A-Za-z_-]{35}/);
      if (m) { mediaFirebaseKey = m[0]; return { ok: true, key: m[0] }; }
    }
    return { ok: false, reason: "no-key" };
  });
  if (!fb.ok) return null;
  const fbKey = fb.key;
  const inbox = await mediaStep("inbox", 25000, async (F) => {
    const r = await F("https://api.tempmail.ing/api/generate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ duration: 60 }),
    }, 25000);
    if (!r || r.status !== 200) return { ok: false, reason: "status=" + (r ? r.status : "none") };
    const j = await jsonBody(r);
    const email = j && (j.email && j.email.address ? j.email.address : (j.address || j.email));
    if (!email || typeof email !== "string") return { ok: false, reason: "no-magic" };
    return { ok: true, email };
  });
  if (!inbox.ok) return null;
  const email = inbox.email;
  const magic = await mediaStep("magic", 25000, async (F) => {
    const r = await F("https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=" + fbKey, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestType: "EMAIL_SIGNIN", email, continueUrl: site + "/login", canHandleCodeInApp: true }),
    }, 25000);
    if (!r || r.status !== 200) return { ok: false, reason: "status=" + (r ? r.status : "none") };
    return { ok: true };
  });
  if (!magic.ok) return null;
  const oob = await mediaStep("oob", 25000, async (F) => {
    let code = null;
    for (let waited = 0; waited < 210000 && !code; waited += 8000) {
      await sleep(8000);
      let clean = "";
      try {
        const lr = await F("https://api.tempmail.ing/api/emails/" + encodeURIComponent(email), {}, 25000);
        clean = (await lr.text()).replace(/&amp;/g, "&");
      } catch { clean = ""; }
      const m = clean.match(/oobCode=([A-Za-z0-9_-]+)/);
      if (m) code = m[1];
    }
    if (!code) return { ok: false, reason: "no-magic" };
    return { ok: true, oobCode: code };
  });
  if (!oob.ok) return null;
  const signin = await mediaStep("signin", 25000, async (F) => {
    const r = await F("https://identitytoolkit.googleapis.com/v1/accounts:signInWithEmailLink?key=" + fbKey, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, oobCode: oob.oobCode }),
    }, 25000);
    if (!r) return { ok: false, reason: "timeout" };
    const j = await jsonBody(r);
    if (!j || !j.idToken) return { ok: false, reason: "status=" + r.status };
    return { ok: true, idToken: j.idToken };
  });
  if (!signin.ok) return null;
  const idToken = signin.idToken;
  const nama = randName();
  const dev = await mediaStep("developer", 25000, async (F) => {
    const r = await F(site + "/api/internal/create-developer", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + idToken },
      body: JSON.stringify({ displayName: nama, attribution: null, deviceFingerprint: randHex(16) }),
    }, 25000);
    if (!r || r.status !== 200) return { ok: false, reason: "status=" + (r ? r.status : "none") };
    return { ok: true };
  });
  if (!dev.ok) return null;
  const keyStep = await mediaStep("key", 25000, async (F) => {
    const r = await F(site + "/api/internal/api-keys", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + idToken },
      body: JSON.stringify({ name: nama }),
    }, 25000);
    if (!r || (r.status !== 200 && r.status !== 201)) return { ok: false, reason: "status=" + (r ? r.status : "none") };
    const j = await jsonBody(r);
    let apiKey = j && (j.key || j.apiKey || (j.data && j.data.key));
    if (!apiKey && j) { const m = JSON.stringify(j).match(/msk_[A-Za-z0-9_-]+/); if (m) apiKey = m[0]; }
    if (!apiKey || !apiKey.startsWith("msk_")) return { ok: false, reason: "format-key" };
    return { ok: true, apiKey };
  });
  if (!keyStep.ok) return null;
  const bal = await mediaStep("saldo", 25000, async (F) => {
    const r = await F(balanceUrl, { headers: { Authorization: "Bearer " + keyStep.apiKey } }, 25000);
    if (!r || r.status !== 200) return { ok: false, reason: "status=" + (r ? r.status : "none") };
    const j = await jsonBody(r);
    const balance = j ? Number(j.balance !== undefined ? j.balance : (j.data && j.data.balance)) : NaN;
    if (!Number.isFinite(balance)) return { ok: false, reason: "saldo-invalid" };
    return { ok: true, balance };
  });
  if (!bal.ok) return null;
  return { upstreamApiKey: keyStep.apiKey, upstreamBaseUrl: apiBase, tempEmail: email, tempPassword: "", live: true, balance: bal.balance };
}
async function tryAutoRegister(provider, tempEmail, tempPassword, sharedPool) {
  const brand = (provider.brand_name || "").toLowerCase();
  if (brand === "luna") return engineLuna(provider, sharedPool);
  if (brand === "nova") return engineNova(provider, sharedPool);
  if (brand === "aurora") return engineAurora(provider, sharedPool);
  if (brand === "stella") return engineStella(provider, sharedPool);
  if (brand === "vega") return engineVega(provider);
  if (brand === "media") return engineMedia();
  return null;
}

// ---------------- panen (doHarvest + runner) ----------------
function logHarvest(userId, providerId, message) {
  try { db.prepare("INSERT INTO harvest_logs (user_id, provider_id, message, created_at) VALUES (?,?,?,?)").run(userId, providerId, message, nowISO()); } catch { /* log gagal bukan fatal */ }
}
// Gate + loop panen. Melempar Error dengan pesan yang tampil ke user.
// `cancelled` dicek tiap iterasi agar timeout runner menghentikan loop.
async function doHarvest({ userId, providerId, count, onProgress, cancelled }) {
  const provider = providerById(providerId);
  if (!provider) throw new Error("provider_not_found");
  if (!Number.isInteger(count) || count < 1 || count > 5000) throw new Error("count_must_be_1_to_5000");
  const tier = tierById(provider.tier_id);
  if (tier && tier.slug === "pro" && !proEnabled()) throw new Error("Tier Pro sedang dikunci (Segera Hadir).");
  if (userId != null && tier && TIER_RANK[tier.slug] != null) {
    const u = db.prepare("SELECT tier_slug, tier_expires_at FROM users WHERE id=?").get(userId);
    const userRank = TIER_RANK[effectiveTierSlug(u)] ?? 0;
    if (TIER_RANK[tier.slug] > userRank) throw new Error("Kamu tidak Bisa Memilih Menu ini Segera Upgrade Paket kamu");
  }
  if (userId != null && tier && tier.slug === "media") {
    const um = db.prepare("SELECT tier_slug, tier_expires_at FROM users WHERE id=?").get(userId);
    if (effectiveTierSlug(um) !== "media") throw new Error("Tier Media hanya bisa dipanen pemegang voucher Media. Tukar voucher Media dulu.");
  }
  if (userId != null && tier && TIER_HARVEST_LIMIT[tier.slug] != null) {
    const limit = TIER_HARVEST_LIMIT[tier.slug];
    const existing = db.prepare("SELECT COUNT(*) c FROM harvested_accounts WHERE user_id=? AND tier_id=?").get(userId, tier.id).c;
    if (existing + count > limit) throw new Error("Limit Tier " + (tier.name || tier.slug) + ": maks " + limit + " akun. Kamu sudah punya " + existing + " akun.");
  }
  if (userId != null && tier && tier.slug === "gratis") {
    const u = db.prepare("SELECT gratis_started_at FROM users WHERE id=?").get(userId);
    if (u && u.gratis_started_at) {
      const started = new Date(u.gratis_started_at);
      if (Date.now() - started.getTime() > 2 * 24 * 3600 * 1000) throw new Error("Masa gratis 2 hari habis! Upgrade paket untuk lanjut.");
    } else {
      db.prepare("UPDATE users SET gratis_started_at=? WHERE id=?").run(nowISO(), userId);
    }
  }
  // Konfigurasi upstream wajib ada (kecuali Vega yang memakai pool + env-nya sendiri
  // dan Media yang memakai env-nya sendiri) — gagal jelas, bukan diam-diam.
  const brand = (provider.brand_name || "").toLowerCase();
  const apiBase = providerBase(provider.brand_name);
  if (!apiBase && brand !== "vega" && brand !== "media") throw new Error("Konfigurasi upstream " + provider.brand_name + " belum diset (env kosong).");
  if (brand === "vega" && !apiBase) throw new Error("Konfigurasi upstream Vega belum diset (env kosong).");
  if (brand === "media" && !apiBase) throw new Error("Konfigurasi upstream Media belum diset (env kosong).");

  // Buat key dulu (dihapus lagi bila panen gagal total tanpa proxy / dibatalkan).
  const keyValue = "hgw-" + randHex(16);
  const keyRow = db.prepare("INSERT INTO api_keys (user_id,provider_id,tier_id,key_value,key_prefix,credit,models_json,model_source,model_count,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(userId, provider.id, provider.tier_id, keyValue, keyValue.slice(0, 12),
      null, JSON.stringify(providerModels(provider)), "configured", provider.model_count, "active", nowISO(), null);
  const keyId = keyRow.lastInsertRowid;

  // Kumpul proxy SEKALI per panen (Vega/Media punya mekanisme sendiri).
  let sharedPool = null;
  let proxyTotal = 0;
  let noProxy = false;
  if (brand === "aurora") {
    sharedPool = await collectProxyPool(apiBase + "/models", 15000);
    proxyTotal = sharedPool.length;
    if (proxyTotal === 0) noProxy = true;
  } else if (brand === "luna" || brand === "stella" || brand === "nova") {
    const probe = brand === "luna" ? siteBase(apiBase) + "/" : brand === "stella" ? siteBase(apiBase) + "/" : apiBase + "/v1/models";
    sharedPool = await collectProxyPool(probe, 7000);
    proxyTotal = sharedPool.length;
    if (proxyTotal === 0) noProxy = true;
  }
  if (noProxy) {
    db.prepare("DELETE FROM harvested_accounts WHERE api_key_id=?").run(keyId);
    db.prepare("DELETE FROM api_keys WHERE id=?").run(keyId);
    throw new Error("Panen dibatalkan: tidak ada proxy OK yang terkumpul, jadi pendaftaran tidak dijalankan tanpa proxy.");
  }

  let liveCount = 0;
  for (let i = 1; i <= count; i++) {
    if (cancelled && cancelled()) break;
    const tempEmail = randTempEmail();
    const tempPassword = randTempPassword();
    let acc = null;
    try { acc = await tryAutoRegister(provider, tempEmail, tempPassword, sharedPool); } catch { acc = null; }
    if (acc && acc.live && acc.upstreamApiKey) {
      liveCount++;
      db.prepare("INSERT INTO harvested_accounts (api_key_id,user_id,provider_id,tier_id,temp_email,temp_password,upstream_api_key,upstream_base_url,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(keyId, userId, provider.id, provider.tier_id, acc.tempEmail || tempEmail, acc.tempPassword || tempPassword, acc.upstreamApiKey, acc.upstreamBaseUrl || apiBase, nowISO());
      logHarvest(userId, provider.id, "Panen Akun " + i + " Berhasil.");
    } else {
      logHarvest(userId, provider.id, "Panen Akun " + i + " Gagal.");
    }
    if (onProgress) onProgress({ done: i, live: liveCount, proxyTotal });
  }
  if (cancelled && cancelled()) {
    db.prepare("DELETE FROM harvested_accounts WHERE api_key_id=?").run(keyId);
    db.prepare("DELETE FROM api_keys WHERE id=?").run(keyId);
    throw new Error("Panen dibatalkan (timeout).");
  }
  const isGratis = tier && tier.slug === "gratis";
  let expiresAt = null;
  if (isGratis && userId != null) {
    const u = db.prepare("SELECT gratis_started_at FROM users WHERE id=?").get(userId);
    if (u && u.gratis_started_at) expiresAt = new Date(new Date(u.gratis_started_at).getTime() + 2 * 24 * 3600 * 1000).toISOString();
  }
  const credit = isGratis ? null : (provider.default_credit == null ? null : provider.default_credit * liveCount);
  db.prepare("UPDATE api_keys SET credit=?, expires_at=? WHERE id=?").run(credit, expiresAt, keyId);
  return { keyId, keyValue, liveCount, proxyTotal };
}
// Runner job: SELALU berakhir done/failed (timeout total + .then/.catch).
function runHarvestJob(jobId, args) {
  const perAccountMs = 4 * 60 * 1000;
  const totalMs = args.count * perAccountMs + 5 * 60 * 1000;
  let cancel = false;
  const work = doHarvest({ ...args, cancelled: () => cancel, onProgress: (p) => {
    try {
      db.prepare("UPDATE harvest_jobs SET done_count=?, live_count=?, proxy_total=?, updated_at=? WHERE id=?")
        .run(p.done, p.live, p.proxyTotal, nowISO(), jobId);
    } catch { /* abaikan */ }
  } });
  const timer = new Promise((_, reject) => setTimeout(() => { cancel = true; reject(new Error("Panen timeout: pekerjaan melebihi batas waktu.")); }, totalMs));
  Promise.race([work, timer]).then((out) => {
    db.prepare("UPDATE harvest_jobs SET status='done', done_count=?, live_count=?, proxy_total=?, api_key_id=?, updated_at=? WHERE id=?")
      .run(args.count, out.liveCount, out.proxyTotal, out.keyId, nowISO(), jobId);
  }).catch((e) => {
    db.prepare("UPDATE harvest_jobs SET status='failed', error=?, updated_at=? WHERE id=?")
      .run(String((e && e.message) || e).slice(0, 500), nowISO(), jobId);
  });
}
function jobView(job, keys) {
  return {
    id: job.id, status: job.status, count: job.count,
    doneCount: job.done_count, liveCount: job.live_count, proxyTotal: job.proxy_total,
    apiKeyId: job.api_key_id, error: job.error, keys: keys || [],
  };
}
function keyCardRow(k) {
  const live = db.prepare("SELECT COUNT(*) c FROM harvested_accounts WHERE api_key_id=?").get(k.id).c > 0;
  return {
    id: k.id, providerId: k.provider_id, tierId: k.tier_id,
    key: live ? k.key_value : null, keyPrefix: k.key_prefix, live,
    credit: k.credit, models: safeJson(k.models_json, []), modelSource: k.model_source,
    modelCount: k.model_count, createdAt: k.created_at, expiresAt: k.expires_at,
  };
}

// ---------------- gateway helpers ----------------
function gatewayKeyModels(key) {
  const fromKey = safeJson(key.models_json, []);
  if (fromKey.length) return fromKey;
  if (key.provider_id) {
    const p = providerById(key.provider_id);
    if (p) return providerModels(p);
  }
  return [];
}
function gatewayAuth(req) {
  const m = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  return db.prepare("SELECT * FROM api_keys WHERE key_value=? AND status='active'").get(m[1]) || null;
}
function openaiError(res, status, code, message) {
  return res.status(status).json({ error: { message, type: code, code } });
}
function bansosProvider() { return providerByBrand("Bansos"); }
function bansosPool() {
  const p = bansosProvider();
  if (!p) return { enabled: false, total: 0, used: 0, remaining: 0, accounts: 0 };
  const ws = db.prepare("SELECT id FROM workers WHERE provider_id=? AND status='active' AND upstream_api_key IS NOT NULL").all(p.id);
  const day = bansosDay();
  let used = 0;
  for (const w of ws) {
    const row = db.prepare("SELECT tokens FROM bansos_usage WHERE day=? AND worker_id=?").get(day, w.id);
    used += Math.min(row ? row.tokens : 0, BANSOS_DAILY_TOKENS);
  }
  const total = ws.length * BANSOS_DAILY_TOKENS;
  return { enabled: bansosEnabled(), total, used, remaining: Math.max(0, total - used), accounts: ws.length };
}
async function upstreamChat({ key, provider, tierSlug, model, body, isStream, res }) {
  const base = provider ? (provider.upstream_url || "") : "";
  const candidates = [];
  const accounts = db.prepare("SELECT * FROM harvested_accounts WHERE api_key_id=? AND (cooldown_until IS NULL OR cooldown_until <= datetime('now')) ORDER BY id ASC").all(key.id);
  for (const a of accounts) candidates.push({ kind: "account", row: a, base: a.upstream_base_url, token: a.upstream_api_key });
  if (accounts.length === 0 && provider && provider.upstream_api_key) {
    candidates.push({ kind: "provider", base, token: provider.upstream_api_key });
  }
  if (provider) {
    const w = db.prepare("SELECT * FROM workers WHERE provider_id=? AND status='active' AND upstream_api_key IS NOT NULL ORDER BY id ASC LIMIT 1").get(provider.id);
    if (w) candidates.push({ kind: "worker", base, token: w.upstream_api_key });
  }
  let lastErr = null;
  for (const c of candidates) {
    if (!c.base || !c.token) continue;
    const url = c.base.replace(/\/$/, "") + "/chat/completions";
    try {
      const upstream = await fetchTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + c.token, "User-Agent": "HestiaFlow/1.0" },
        body: JSON.stringify({ ...body, model, stream: isStream, ...(isStream ? { stream_options: { include_usage: true } } : {}) }),
      }, 120000);
      if (upstream.status === 401 || upstream.status === 402 || upstream.status === 403) {
        if (c.kind === "account") db.prepare("DELETE FROM harvested_accounts WHERE id=?").run(c.row.id);
        lastErr = upstream.status;
        continue;
      }
      if (upstream.status === 429 && c.kind === "account") {
        db.prepare("UPDATE harvested_accounts SET cooldown_until=? WHERE id=?")
          .run(new Date(Date.now() + 6 * 3600 * 1000).toISOString(), c.row.id);
        lastErr = 429;
        continue;
      }
      if (!upstream.ok) { lastErr = upstream.status; continue; }
      if (isStream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        let tail = "";
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let totalTokens = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            tail += chunk;
            res.write(chunk);
          }
        } finally { try { res.end(); } catch { /* sudah tertutup */ } }
        const usageMatch = tail.match(/"usage"\s*:\s*\{[^}]*"total_tokens"\s*:\s*(\d+)/);
        if (usageMatch) totalTokens = Number(usageMatch[1]);
        if (totalTokens > 0) deductCredit(key, tierSlug, totalTokens);
        return true;
      }
      const data = await upstream.json().catch(() => null);
      if (!data) { lastErr = "bad_upstream"; continue; }
      const totalTokens = data.usage && Number(data.usage.total_tokens);
      if (totalTokens > 0) deductCredit(key, tierSlug, totalTokens);
      res.json(data);
      return true;
    } catch (e) { lastErr = "network"; continue; }
  }
  return { error: lastErr };
}
function deductCredit(key, tierSlug, totalTokens) {
  if (tierSlug !== "premium" && tierSlug !== "pro") return;
  if (key.credit == null) return;
  db.prepare("UPDATE api_keys SET credit = MAX(0, credit - ?) WHERE id=?").run(totalTokens, key.id);
}

// ---------------- media gateway ----------------
async function driveCopy(keyPrefix, fileName, sourceUrl) {
  // Salinan ke Drive pantauan; gagal salin TIDAK menggagalkan request.
  try {
    const cid = process.env.PANTAU_CLIENT_ID || "";
    const csec = process.env.PANTAU_CLIENT_SECRET || "";
    const refresh = process.env.PANTAU_REFRESH_TOKEN || "";
    if (!cid || !csec || !refresh) return "skipped";
    const tok = await fetchJson("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: refresh, grant_type: "refresh_token" }),
    }, 30000);
    const access = tok.json && tok.json.access_token;
    if (!access) return "token_failed";
    const findFolder = async (name, parent) => {
      const q = "name='" + name.replace(/'/g, "") + "' and mimeType='application/vnd.google-apps.folder' and trashed=false" + (parent ? " and '" + parent + "' in parents" : "");
      const r = await fetchJson("https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(q), { headers: { Authorization: "Bearer " + access } }, 30000);
      const files = r.json && r.json.files;
      return files && files[0] ? files[0].id : null;
    };
    const makeFolder = async (name, parent) => {
      const r = await fetchJson("https://www.googleapis.com/drive/v3/files", {
        method: "POST", headers: { Authorization: "Bearer " + access, "Content-Type": "application/json" },
        body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: parent ? [parent] : [] }),
      }, 30000);
      return r.json && r.json.id;
    };
    let root = await findFolder("hestiaflow-pantau", null);
    if (!root) root = await makeFolder("hestiaflow-pantau", null);
    let sub = root ? await findFolder(keyPrefix, root) : null;
    if (root && !sub) sub = await makeFolder(keyPrefix, root);
    const media = await fetchTimeout(sourceUrl, {}, 60000);
    if (!media.ok) return "fetch_failed";
    const buf = Buffer.from(await media.arrayBuffer());
    const boundary = "hestiaflow-" + randHex(8);
    const meta = JSON.stringify({ name: fileName, parents: sub ? [sub] : [] });
    const bodyStr = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + meta +
      "\r\n--" + boundary + "\r\nContent-Type: application/octet-stream\r\n\r\n";
    const bodyEnd = "\r\n--" + boundary + "--";
    const full = Buffer.concat([Buffer.from(bodyStr), buf, Buffer.from(bodyEnd)]);
    const up = await fetchJson("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
      method: "POST", headers: { Authorization: "Bearer " + access, "Content-Type": "multipart/related; boundary=" + boundary },
      body: full,
    }, 120000);
    return up.json && up.json.id ? "ok" : "upload_failed";
  } catch { return "error"; }
}
async function mediaGenerate(apiKey, mediaType, model, prompt, extra) {
  const base = providerBase("Media");
  if (!base) return { error: "upstream_not_configured", status: 502 };
  const isVideo = mediaType === "video" || MEDIA_VIDEO.includes(model) || MEDIA_V2V.includes(model);
  const create = await fetchJson(base.replace(/\/$/, "") + "/generations", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify({ model, prompt, type: mediaType, ...(extra.image_url ? { image_url: extra.image_url } : {}), ...(extra.video_url ? { video_url: extra.video_url } : {}) }),
  }, 30000);
  const genId = create.json && (create.json.id || create.json.generation_id || (create.json.data && create.json.data.id));
  if (!create.ok || !genId) return { error: "upstream_error", status: create.status || 502, detail: create.json };
  const deadline = isVideo ? 300000 : 180000;
  const started = Date.now();
  while (Date.now() - started < deadline) {
    await sleep(5000);
    const poll = await fetchJson(base.replace(/\/$/, "") + "/generations/" + genId, { headers: { Authorization: "Bearer " + apiKey } }, 30000);
    const d = poll.json || {};
    const status = d.status || (d.data && d.data.status);
    if (status === "completed" || status === "succeeded" || status === "done") {
      const url = d.url || d.result_url || (d.data && (d.data.url || d.data.result_url)) || (d.output && d.output.url);
      if (url) return { url, genId };
      return { error: "no_url", status: 502 };
    }
    if (status === "failed" || status === "error") return { error: "generation_failed", status: 502 };
  }
  return { error: "generation_timeout", status: 504 };
}
async function handleMedia(req, res, mediaType, key) {
  const user = key.user_id ? db.prepare("SELECT * FROM users WHERE id=?").get(key.user_id) : null;
  if (user && user.suspended) return openaiError(res, 403, "suspended", "Akun ditangguhkan.");
  const provider = providerById(key.provider_id);
  const tier = tierById(key.tier_id);
  if (tier && tier.slug === "pro" && !proEnabled()) return openaiError(res, 401, "pro_locked", "Tier Pro sedang dikunci.");
  if (key.expires_at && new Date(key.expires_at) < new Date()) return openaiError(res, 401, "key_expired", "Key kedaluwarsa.");
  if (!key.user_id) return openaiError(res, 403, "media_login_required", "Generate media memerlukan key dari akun login.");
  if (!tier || tier.slug !== "media") return openaiError(res, 403, "media_tier_only", "Generate media hanya untuk tier Media.");
  const body = req.body || {};
  const prompt = body.prompt || body.input;
  if (!prompt) return openaiError(res, 400, "prompt_required", "Prompt wajib diisi.");
  const model = body.model || "";
  const allMedia = [...MEDIA_IMAGE, ...MEDIA_I2I, ...MEDIA_VIDEO, ...MEDIA_V2V];
  if (!allMedia.includes(model)) return res.status(404).json({ error: { message: "Model tidak dikenal.", choices: allMedia } });
  if (MEDIA_I2I.includes(model) && !body.image_url) return openaiError(res, 400, "image_url_required", "Model ini wajib image_url.");
  if (MEDIA_V2V.includes(model) && !body.video_url) return openaiError(res, 400, "video_url_required", "Model ini wajib video_url.");
  // Kandidat key: (1) harvested terbaru dulu, (2) provider upstream, (3) worker, (4) env.
  const candidates = [];
  const accs = db.prepare("SELECT * FROM harvested_accounts WHERE api_key_id=? ORDER BY id DESC").all(key.id);
  for (const a of accs) candidates.push(a.upstream_api_key);
  if (provider && provider.upstream_api_key) candidates.push(provider.upstream_api_key);
  if (provider) {
    const w = db.prepare("SELECT * FROM workers WHERE provider_id=? AND status='active' AND upstream_api_key IS NOT NULL ORDER BY id ASC LIMIT 1").get(provider.id);
    if (w) candidates.push(w.upstream_api_key);
  }
  for (const k of MEDIA_ENV_KEYS) candidates.push(k);
  const uniq = [...new Set(candidates.filter(Boolean))];
  if (!uniq.length) return openaiError(res, 502, "upstream_not_configured", "Upstream media belum dikonfigurasi.");
  let lastErr = null;
  for (const apiKey of uniq) {
    const out = await mediaGenerate(apiKey, mediaType, model, prompt, body);
    if (out.url) {
      const copyStatus = await driveCopy(key.key_prefix, "media-" + Date.now() + ".bin", out.url);
      db.prepare("INSERT INTO media_logs (api_key_id,user_id,media_type,model,prompt,cost_usd,gen_id,source_url,drive_path,copy_status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(key.id, key.user_id, mediaType, model, prompt, null, out.genId, out.url, null, copyStatus, nowISO());
      return res.json({ created: Math.floor(Date.now() / 1000), data: [{ url: out.url }] });
    }
    lastErr = out;
  }
  return openaiError(res, lastErr && lastErr.status ? lastErr.status : 502, "upstream_error", "Generate media gagal.");
}

// ---------------- aplikasi express ----------------
const app = express();
app.use(express.static(path.join(__dirname, "public")));
// Impor DB: body mentah (SQLite), sebelum parser JSON.
app.post("/api/db-import", express.raw({ type: "*/*", limit: "200mb" }), (req, res) => {
  if (!DB_IMPORT_TOKEN || req.get("x-import-token") !== DB_IMPORT_TOKEN) return res.status(403).json({ ok: false });
  try {
    const buf = req.body;
    if (!buf || buf.length < 100 || buf.subarray(0, 15).toString("latin1") !== "SQLite format 3") {
      return res.status(400).json({ ok: false, error: "bukan file sqlite" });
    }
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH + ".imported", buf);
    res.json({ ok: true, bytes: buf.length });
    setTimeout(() => process.exit(0), 600);
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
app.use(express.json({ limit: "5mb" }));
app.use("/api", rateLimit(600));

// ---------- auth ----------
app.get("/auth/google", (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.redirect("/?oauth=missing");
  const state = randHex(16);
  res.cookie("oauth_state", state, { httpOnly: true, sameSite: "lax", path: "/" });
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);
  res.redirect(u.toString());
});
app.get("/auth/google/callback", async (req, res) => {
  try {
    const stateCookie = parseCookies(req).oauth_state;
    if (!req.query.code || !req.query.state || req.query.state !== stateCookie) return res.redirect("/?oauth=error");
    const tokenRes = await fetchJson("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: req.query.code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: GOOGLE_REDIRECT_URI, grant_type: "authorization_code" }),
    }, 30000);
    const tokens = tokenRes.json || {};
    if (!tokens.access_token) return res.redirect("/?oauth=error");
    const meRes = await fetchJson("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: "Bearer " + tokens.access_token } }, 30000);
    const me = meRes.json || {};
    if (!me.email) return res.redirect("/?oauth=error");
    const email = String(me.email).toLowerCase();
    const adminFlag = ADMIN_EMAILS.includes(email) ? 1 : 0;
    let user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
    if (!user) {
      const r = db.prepare("INSERT INTO users (google_id,email,name,avatar,is_admin,created_at) VALUES (?,?,?,?,?,?)")
        .run(me.sub || "", email, me.name || email, me.picture || "", adminFlag, nowISO());
      user = db.prepare("SELECT * FROM users WHERE id=?").get(r.lastInsertRowid);
    } else if (adminFlag && !user.is_admin) {
      db.prepare("UPDATE users SET is_admin=1 WHERE id=?").run(user.id);
      user.is_admin = 1;
    }
    trackLogin(req, user.id);
    res.cookie("hestia_session", signSession(user.id), { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 * 1000 });
    res.redirect("/");
  } catch { res.redirect("/?oauth=error"); }
});
app.post("/api/logout", (req, res) => {
  res.clearCookie("hestia_session", { path: "/" });
  res.json({ ok: true });
});
app.post("/api/test-login", rateLimit(30), (req, res) => {
  if (!TEST_SECRET || req.body.secret !== TEST_SECRET) return res.status(404).json({ ok: false });
  const { email, name, isAdmin } = req.body;
  if (!email) return res.status(400).json({ ok: false, error: "email_required" });
  const em = String(email).toLowerCase();
  let user = db.prepare("SELECT * FROM users WHERE email=?").get(em);
  if (!user) {
    const r = db.prepare("INSERT INTO users (google_id,email,name,avatar,is_admin,created_at) VALUES (?,?,?,?,?,?)")
      .run("test-" + randHex(6), em, name || em, "", isAdmin ? 1 : 0, nowISO());
    user = db.prepare("SELECT * FROM users WHERE id=?").get(r.lastInsertRowid);
  }
  trackLogin(req, user.id);
  res.cookie("hestia_session", signSession(user.id), { httpOnly: true, sameSite: "lax", path: "/" });
  res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, is_admin: user.is_admin } });
});

// ---------- publik ----------
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, name: u.name, avatar: u.avatar, is_admin: isAdminUser(u) ? 1 : 0,
    tierSlug: effectiveTierSlug(u), tierExpiresAt: u.tier_expires_at, suspended: u.suspended ? 1 : 0,
    createdAt: u.created_at, gratisStartedAt: u.gratis_started_at,
  };
}
function publicProvider(p) {
  const tier = tierById(p.tier_id);
  return {
    id: p.id, tierId: p.tier_id, tierSlug: tier ? tier.slug : null, brand: p.brand_name,
    tagline: p.tagline, modelCount: p.model_count, models: providerModels(p),
    notes: safeJson(p.model_notes_json, {}), creditNote: p.credit_note,
    defaultCredit: p.default_credit, sortOrder: p.sort_order,
  };
}
app.get("/api/me", (req, res) => {
  res.json({ ok: true, user: publicUser(sessionUser(req)), oauthConfigured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) });
});
app.get("/api/public/providers", (req, res) => {
  const rows = db.prepare("SELECT * FROM providers ORDER BY tier_id, sort_order").all();
  res.json({ ok: true, providers: rows.map(publicProvider) });
});
app.get("/api/public/providers/:id/models", (req, res) => {
  const p = providerById(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: "provider_not_found" });
  res.json({ ok: true, brand: p.brand_name, models: providerModels(p), notes: safeJson(p.model_notes_json, {}) });
});
app.get("/api/public/tiers", (req, res) => {
  const tiers = db.prepare("SELECT * FROM tiers ORDER BY sort_order").all();
  const providers = db.prepare("SELECT * FROM providers ORDER BY tier_id, sort_order").all();
  res.json({
    ok: true,
    tiers: tiers.map((t) => ({
      id: t.id, slug: t.slug, name: t.name, audienceLabel: t.audience_label, badge: t.badge,
      maxModels: t.max_models, locked: t.slug === "pro" && !proEnabled(),
      providers: providers.filter((p) => p.tier_id === t.id).map(publicProvider),
    })),
  });
});
app.get("/api/public/settings", (req, res) => {
  res.json({ ok: true, gateway_name: setting("gateway_name") || "HestiaFlow", base_url: setting("base_url") || GATEWAY_BASE_URL || BASE_URL });
});
app.get("/api/public/pool", (req, res) => res.json({ ok: true, ...bansosPool() }));
app.get("/api/bansos/pool", (req, res) => res.json({ ok: true, ...bansosPool() }));
app.get("/api/bansos/my-keys", (req, res) => {
  const anon = parseCookies(req).bansos_anon;
  if (!anon) return res.json({ ok: true, keys: [] });
  const rows = db.prepare("SELECT * FROM api_keys WHERE anon_id=? ORDER BY id DESC").all(anon);
  res.json({ ok: true, keys: rows.map((k) => ({ id: k.id, key: k.key_value, keyPrefix: k.key_prefix, createdAt: k.created_at })) });
});
app.post("/api/bansos/keys", (req, res) => {
  if (!bansosEnabled()) return res.status(403).json({ ok: false, error: "bansos_disabled" });
  let anon = parseCookies(req).bansos_anon;
  if (!anon) { anon = "anon-" + randHex(12); res.cookie("bansos_anon", anon, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 365 * 24 * 3600 * 1000 }); }
  const n = db.prepare("SELECT COUNT(*) c FROM api_keys WHERE anon_id=?").get(anon).c;
  if (n >= BANSOS_KEY_LIMIT) return res.status(403).json({ ok: false, error: "bansos_key_limit" });
  const p = bansosProvider();
  if (!p) return res.status(502).json({ ok: false, error: "bansos_not_configured" });
  const keyValue = "hgw-" + randHex(16);
  const r = db.prepare("INSERT INTO api_keys (user_id,provider_id,tier_id,key_value,key_prefix,credit,models_json,model_source,model_count,status,created_at,expires_at,anon_id) VALUES (NULL,?,NULL,?,?,NULL,?,'bansos',?,'active',?,NULL,?)")
    .run(p.id, keyValue, keyValue.slice(0, 12), JSON.stringify(BANSOS_MODELS), BANSOS_MODELS.length, nowISO(), anon);
  res.json({ ok: true, key: keyValue, keyPrefix: keyValue.slice(0, 12), id: r.lastInsertRowid });
});
app.post("/api/voucher/redeem", rateLimit(30), requireAuth, (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();
  const v = db.prepare("SELECT * FROM vouchers WHERE code=?").get(code);
  if (!v) return res.status(400).json({ ok: false, error: "voucher_not_found" });
  if (v.used) return res.status(400).json({ ok: false, error: "Kode vocher sudah dipakai." });
  if (v.tier_slug === "pro" && !proEnabled()) return res.status(403).json({ ok: false, error: "pro_locked" });
  const days = VOUCHER_DAYS[v.tier_slug] || v.duration_days || 0;
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  db.prepare("UPDATE users SET tier_slug=?, tier_expires_at=? WHERE id=?").run(v.tier_slug, expires, req.user.id);
  db.prepare("UPDATE vouchers SET used=1, used_by=?, used_at=? WHERE id=?").run(req.user.id, nowISO(), v.id);
  const label = v.tier_slug.charAt(0).toUpperCase() + v.tier_slug.slice(1);
  res.json({
    ok: true, tierSlug: v.tier_slug, expiresAt: expires, mediaKey: null,
    message: "Vocher berhasil! Paket kamu jadi " + label + " sampai " +
      new Date(expires).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" }) + ".",
  });
});

// ---------- key & panen (login) ----------
function myKeyRow(k) {
  const provider = providerById(k.provider_id);
  const tier = tierById(k.tier_id);
  const n = db.prepare("SELECT COUNT(*) c FROM harvested_accounts WHERE api_key_id=?").get(k.id).c;
  return {
    ...keyCardRow(k), providerBrand: provider ? provider.brand_name : null, tierSlug: tier ? tier.slug : null,
    combinedAccounts: n, liveAccounts: n,
  };
}
app.get("/api/my-keys", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM api_keys WHERE user_id=? ORDER BY id DESC").all(req.user.id);
  res.json({ ok: true, keys: rows.map(myKeyRow) });
});
app.post("/api/my-keys", requireAuth, (req, res) => {
  const provider = providerById(req.body.providerId);
  if (!provider) return res.status(404).json({ ok: false, error: "provider_not_found" });
  const r = db.prepare("INSERT INTO harvest_jobs (user_id,provider_id,count,status,created_at,updated_at) VALUES (?,?,1,'pending',?,?)")
    .run(req.user.id, provider.id, nowISO(), nowISO());
  runHarvestJob(r.lastInsertRowid, { userId: req.user.id, providerId: provider.id, count: 1 });
  res.json({ ok: true, jobId: r.lastInsertRowid });
});
app.delete("/api/my-keys/:id", requireAuth, (req, res) => {
  const k = db.prepare("SELECT * FROM api_keys WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!k) return res.status(404).json({ ok: false, error: "key_not_found" });
  db.prepare("DELETE FROM harvested_accounts WHERE api_key_id=?").run(k.id);
  db.prepare("DELETE FROM api_keys WHERE id=?").run(k.id);
  res.json({ ok: true });
});
app.post("/api/harvest", requireAuth, (req, res) => {
  const provider = providerById(req.body.providerId);
  if (!provider) return res.status(404).json({ ok: false, error: "provider_not_found" });
  const count = Number(req.body.count);
  if (!Number.isInteger(count) || count < 1 || count > 50) return res.status(400).json({ ok: false, error: "count_must_be_1_to_50" });
  const r = db.prepare("INSERT INTO harvest_jobs (user_id,provider_id,count,status,created_at,updated_at) VALUES (?,?,?,'pending',?,?)")
    .run(req.user.id, provider.id, count, nowISO(), nowISO());
  runHarvestJob(r.lastInsertRowid, { userId: req.user.id, providerId: provider.id, count });
  res.json({ ok: true, jobId: r.lastInsertRowid });
});
app.get("/api/harvest/job/:id", requireAuth, (req, res) => {
  const job = db.prepare("SELECT * FROM harvest_jobs WHERE id=?").get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "job_not_found" });
  const admin = isAdminUser(req.user);
  if (job.user_id !== req.user.id && !(admin && job.user_id == null)) {
    return res.status(404).json({ ok: false, error: "job_not_found" });
  }
  let keys = [];
  if (job.status === "done" && job.api_key_id) {
    const k = db.prepare("SELECT * FROM api_keys WHERE id=?").get(job.api_key_id);
    if (k) keys = [myKeyRow(k)];
  }
  res.json({ ok: true, job: jobView(job, keys) });
});
app.get("/api/harvest/logs", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM harvest_logs WHERE user_id=? ORDER BY id DESC LIMIT 100").all(req.user.id);
  res.json({ ok: true, logs: rows.map((r) => ({ message: r.message, createdAt: r.created_at })) });
});

// ---------- admin ----------
function genVoucherCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 16; i++) s += chars[crypto.randomInt(chars.length)];
  return s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8, 12) + "-" + s.slice(12, 16);
}
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  res.json({
    ok: true,
    users: db.prepare("SELECT COUNT(*) c FROM users").get().c,
    keys: db.prepare("SELECT COUNT(*) c FROM api_keys").get().c,
    providers: db.prepare("SELECT COUNT(*) c FROM providers").get().c,
    workers: db.prepare("SELECT COUNT(*) c FROM workers").get().c,
    workersActive: db.prepare("SELECT COUNT(*) c FROM workers WHERE status='active'").get().c,
    tiers: db.prepare("SELECT COUNT(*) c FROM tiers").get().c,
  });
});
app.get("/api/admin/users", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM users ORDER BY id DESC").all();
  res.json({
    ok: true,
    users: rows.map((u) => ({
      id: u.id, email: u.email, name: u.name, tierSlug: effectiveTierSlug(u), tierExpiresAt: u.tier_expires_at,
      suspended: u.suspended ? 1 : 0, createdAt: u.created_at, lastLoginAt: u.last_login_at,
      lastIp: u.last_ip, lastUa: u.last_ua, isAdmin: u.is_admin ? 1 : 0,
      keyCount: db.prepare("SELECT COUNT(*) c FROM api_keys WHERE user_id=?").get(u.id).c,
    })),
  });
});
app.post("/api/admin/users/:id/tier", requireAdmin, (req, res) => {
  const tierSlug = String(req.body.tierSlug || "");
  if (!tierBySlug(tierSlug)) return res.status(400).json({ ok: false, error: "tier_not_found" });
  const days = VOUCHER_DAYS[tierSlug];
  const expires = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
  db.prepare("UPDATE users SET tier_slug=?, tier_expires_at=? WHERE id=?").run(tierSlug, expires, req.params.id);
  res.json({ ok: true });
});
app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  const id = req.params.id;
  db.prepare("DELETE FROM media_logs WHERE user_id=?").run(id);
  db.prepare("DELETE FROM harvested_accounts WHERE user_id=?").run(id);
  db.prepare("DELETE FROM harvest_logs WHERE user_id=?").run(id);
  db.prepare("DELETE FROM harvest_jobs WHERE user_id=?").run(id);
  db.prepare("DELETE FROM api_keys WHERE user_id=?").run(id);
  db.prepare("DELETE FROM users WHERE id=?").run(id);
  res.json({ ok: true });
});
app.post("/api/admin/users/:id/suspend", requireAdmin, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!u) return res.status(404).json({ ok: false, error: "user_not_found" });
  const next = req.body.suspended != null ? (req.body.suspended ? 1 : 0) : (u.suspended ? 0 : 1);
  db.prepare("UPDATE users SET suspended=? WHERE id=?").run(next, req.params.id);
  res.json({ ok: true, suspended: next });
});
app.get("/api/admin/keys", requireAdmin, (req, res) => {
  let rows = db.prepare("SELECT * FROM api_keys ORDER BY id DESC").all();
  if (req.query.userId) rows = rows.filter((k) => String(k.user_id) === String(req.query.userId));
  res.json({
    ok: true,
    keys: rows.map((k) => {
      const owner = k.user_id ? db.prepare("SELECT email, name FROM users WHERE id=?").get(k.user_id) : null;
      const provider = providerById(k.provider_id);
      const tier = tierById(k.tier_id);
      // Nilai penuh key_value TIDAK PERNAH dikembalikan di list ini.
      return {
        id: k.id, keyPrefix: k.key_prefix, ownerEmail: owner ? owner.email : null,
        ownerName: owner ? owner.name : null, providerBrand: provider ? provider.brand_name : null,
        tierSlug: tier ? tier.slug : null, credit: k.credit, models: safeJson(k.models_json, []),
        modelSource: k.model_source, modelCount: k.model_count, createdAt: k.created_at,
      };
    }),
  });
});
app.delete("/api/admin/keys/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM harvested_accounts WHERE api_key_id=?").run(req.params.id);
  db.prepare("DELETE FROM api_keys WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
app.get("/api/admin/vouchers", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM vouchers ORDER BY id DESC").all();
  res.json({
    ok: true,
    vouchers: rows.map((v) => ({
      id: v.id, code: v.code, tierSlug: v.tier_slug, durationDays: v.duration_days, used: v.used ? 1 : 0,
      usedBy: v.used_by ? (db.prepare("SELECT email FROM users WHERE id=?").get(v.used_by) || {}).email || null : null,
      usedAt: v.used_at, createdAt: v.created_at,
    })),
  });
});
app.post("/api/admin/vouchers", requireAdmin, (req, res) => {
  const tierSlug = String(req.body.tierSlug || "");
  if (!VOUCHER_DAYS[tierSlug]) return res.status(400).json({ ok: false, error: "tier_not_voucherable" });
  const code = genVoucherCode();
  const r = db.prepare("INSERT INTO vouchers (code,tier_slug,duration_days,used,created_at) VALUES (?,?,?,0,?)")
    .run(code, tierSlug, VOUCHER_DAYS[tierSlug], nowISO());
  res.json({ ok: true, id: r.lastInsertRowid, code, tierSlug, durationDays: VOUCHER_DAYS[tierSlug] });
});
app.delete("/api/admin/vouchers/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM vouchers WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
app.get("/api/admin/tiers", requireAdmin, (req, res) => {
  res.json({ ok: true, tiers: db.prepare("SELECT * FROM tiers ORDER BY sort_order").all() });
});
app.post("/api/admin/tiers", requireAdmin, (req, res) => {
  const b = req.body || {};
  const slug = String(b.slug || b.name || "").toLowerCase().replace(/[^a-z0-9-]/g, "") || ("tier-" + randHex(4));
  const r = db.prepare("INSERT INTO tiers (slug,name,audience_label,badge,max_models,sort_order) VALUES (?,?,?,?,?,99)")
    .run(slug, b.name || slug, b.audienceLabel || "", b.badge || "", b.maxModels != null ? Number(b.maxModels) : null);
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.get("/api/admin/tiers/:id", requireAdmin, (req, res) => {
  const t = tierById(req.params.id);
  if (!t) return res.status(404).json({ ok: false, error: "tier_not_found" });
  res.json({ ok: true, tier: t });
});
app.put("/api/admin/tiers/:id", requireAdmin, (req, res) => {
  const b = req.body || {};
  db.prepare("UPDATE tiers SET name=?, audience_label=?, badge=?, max_models=? WHERE id=?")
    .run(b.name || "", b.audienceLabel || "", b.badge || "", b.maxModels != null ? Number(b.maxModels) : null, req.params.id);
  res.json({ ok: true });
});
app.delete("/api/admin/tiers/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM tiers WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
app.get("/api/admin/providers", requireAdmin, (req, res) => {
  res.json({ ok: true, providers: db.prepare("SELECT * FROM providers ORDER BY tier_id, sort_order").all() });
});
app.post("/api/admin/providers", requireAdmin, (req, res) => {
  const b = req.body || {};
  const r = db.prepare("INSERT INTO providers (tier_id,brand_name,tagline,model_count,model_list_json,model_notes_json,credit_note,default_credit,sort_order,upstream_url) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(b.tierId || null, b.brand || "Baru", b.tagline || "", Array.isArray(b.models) ? b.models.length : 0,
      JSON.stringify(b.models || []), JSON.stringify(b.notes || {}), b.creditNote || null,
      b.defaultCredit != null ? Number(b.defaultCredit) : null, b.sortOrder || 99, b.upstreamUrl || null);
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.get("/api/admin/providers/:id", requireAdmin, (req, res) => {
  const p = providerById(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: "provider_not_found" });
  res.json({ ok: true, provider: p });
});
app.put("/api/admin/providers/:id", requireAdmin, (req, res) => {
  const cur = providerById(req.params.id);
  if (!cur) return res.status(404).json({ ok: false, error: "provider_not_found" });
  const b = req.body || {};
  // UI admin hanya mengirim upstreamApiKey lewat PUT ini; field lain ikut bila ada.
  db.prepare("UPDATE providers SET tier_id=?, brand_name=?, tagline=?, model_count=?, model_list_json=?, model_notes_json=?, credit_note=?, default_credit=?, upstream_name=?, upstream_url=?, upstream_api_key=? WHERE id=?")
    .run(b.tierId !== undefined ? b.tierId : cur.tier_id,
      b.brand !== undefined ? b.brand : cur.brand_name,
      b.tagline !== undefined ? b.tagline : cur.tagline,
      b.models !== undefined ? b.models.length : cur.model_count,
      b.models !== undefined ? JSON.stringify(b.models) : cur.model_list_json,
      b.notes !== undefined ? JSON.stringify(b.notes) : cur.model_notes_json,
      b.creditNote !== undefined ? b.creditNote : cur.credit_note,
      b.defaultCredit !== undefined ? Number(b.defaultCredit) : cur.default_credit,
      b.upstreamName !== undefined ? b.upstreamName : cur.upstream_name,
      b.upstreamUrl !== undefined ? b.upstreamUrl : cur.upstream_url,
      b.upstreamApiKey !== undefined ? b.upstreamApiKey : cur.upstream_api_key,
      req.params.id);
  res.json({ ok: true });
});
app.delete("/api/admin/providers/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM providers WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
app.post("/api/admin/harvest", requireAdmin, (req, res) => {
  const provider = providerById(req.body.providerId);
  if (!provider) return res.status(404).json({ ok: false, error: "provider_not_found" });
  const count = Number(req.body.count);
  if (!Number.isInteger(count) || count < 1 || count > 50) return res.status(400).json({ ok: false, error: "count_must_be_1_to_50" });
  const r = db.prepare("INSERT INTO harvest_jobs (user_id,provider_id,count,status,created_at,updated_at) VALUES (NULL,?,?,'pending',?,?)")
    .run(provider.id, count, nowISO(), nowISO());
  runHarvestJob(r.lastInsertRowid, { userId: null, providerId: provider.id, count });
  res.json({ ok: true, jobId: r.lastInsertRowid });
});
app.get("/api/admin/workers", requireAdmin, (req, res) => {
  res.json({ ok: true, workers: db.prepare("SELECT * FROM workers ORDER BY id DESC").all() });
});
app.post("/api/admin/workers", requireAdmin, (req, res) => {
  const b = req.body || {};
  const r = db.prepare("INSERT INTO workers (provider_id,name,credit,status,upstream_api_key,created_at) VALUES (?,?,?,?,?,?)")
    .run(b.providerId || null, b.name || "Worker", b.credit != null ? Number(b.credit) : 0, "active", b.upstreamApiKey || null, nowISO());
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.put("/api/admin/workers/:id", requireAdmin, (req, res) => {
  const b = req.body || {};
  const cur = db.prepare("SELECT * FROM workers WHERE id=?").get(req.params.id);
  if (!cur) return res.status(404).json({ ok: false, error: "worker_not_found" });
  db.prepare("UPDATE workers SET name=?, credit=?, status=? WHERE id=?")
    .run(b.name !== undefined ? b.name : cur.name,
      b.credit !== undefined ? Number(b.credit) : cur.credit,
      b.status !== undefined ? b.status : cur.status, req.params.id);
  res.json({ ok: true });
});
app.delete("/api/admin/workers/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM workers WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
app.get("/api/admin/settings", requireAdmin, (req, res) => {
  res.json({ ok: true, gateway_name: setting("gateway_name") || "HestiaFlow", base_url: setting("base_url") || BASE_URL });
});
app.put("/api/admin/settings", requireAdmin, (req, res) => {
  const b = req.body || {};
  if (b.gateway_name !== undefined) db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('gateway_name',?)").run(String(b.gateway_name));
  if (b.base_url !== undefined) db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('base_url',?)").run(String(b.base_url));
  res.json({ ok: true });
});
app.post("/api/admin/proxy-pool/import", requireAdmin, (req, res) => {
  const proxies = req.body && req.body.proxies;
  if (!Array.isArray(proxies)) return res.status(400).json({ ok: false, error: "proxies_required" });
  if (proxies.length > 500) return res.status(400).json({ ok: false, error: "too_many_proxies" });
  let skipped = 0;
  const seen = new Set();
  const valid = [];
  for (const item of proxies) {
    let s = typeof item === "string" ? item.trim() : "";
    s = s.replace(/^https?:\/\//i, "").trim();
    if (!/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) { skipped++; continue; }
    if (!seen.has(s)) { seen.add(s); valid.push(s); }
  }
  const stmt = db.prepare("INSERT OR REPLACE INTO proxy_pool (host, target, last_ok, fails) VALUES (?, 'vega', datetime('now'), 0)");
  for (const host of valid) stmt.run(host);
  res.json({ ok: true, inserted: valid.length, skipped, total: proxies.length });
});
app.get("/api/admin/harvest-logs", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM harvest_logs ORDER BY id DESC LIMIT 200").all();
  res.json({
    ok: true,
    logs: rows.map((r) => ({
      id: r.id, message: r.message, createdAt: r.created_at,
      userEmail: r.user_id ? (db.prepare("SELECT email FROM users WHERE id=?").get(r.user_id) || {}).email || null : null,
      providerBrand: r.provider_id ? (providerById(r.provider_id) || {}).brand_name || null : null,
    })),
  });
});

// ---------- gateway /v1 ----------
app.get("/v1/models", (req, res) => {
  const key = gatewayAuth(req);
  if (!key) return openaiError(res, 401, "invalid_api_key", "API key tidak dikenal.");
  const models = key.anon_id ? BANSOS_MODELS : gatewayKeyModels(key);
  res.json({ object: "list", data: models.map((id) => ({ id, object: "model" })) });
});
app.get("/v1/credit", (req, res) => {
  const key = gatewayAuth(req);
  if (!key) return openaiError(res, 401, "invalid_api_key", "API key tidak dikenal.");
  const provider = providerById(key.provider_id);
  if (key.anon_id) {
    const pool = bansosPool();
    return res.json({ ok: true, credit: pool.remaining, credit_note: provider ? provider.credit_note : null, tier: "bansos" });
  }
  res.json({ ok: true, credit: key.credit, credit_note: provider ? provider.credit_note : null });
});
app.post("/v1/chat/completions", async (req, res) => {
  const key = gatewayAuth(req);
  if (!key) return openaiError(res, 401, "invalid_api_key", "API key tidak dikenal.");
  const body = req.body || {};
  const model = body.model || "";
  if (key.anon_id) {
    if (!bansosEnabled()) return openaiError(res, 403, "bansos_disabled", "Bansos sedang dikunci.");
    if (!BANSOS_MODELS.includes(model)) return openaiError(res, 404, "model_not_found", "Model tidak ada di daftar key ini.");
    const pool = bansosPool();
    if (pool.remaining <= 0) return openaiError(res, 429, "bansos_pool_empty", "Pool Bansos hari ini habis.");
    const base = providerBase("Bansos");
    if (!base) return openaiError(res, 502, "upstream_not_configured", "Upstream Bansos belum dikonfigurasi.");
    const bansos = bansosProvider();
    const day = bansosDay();
    const ws = bansos ? db.prepare("SELECT * FROM workers WHERE provider_id=? AND status='active' AND upstream_api_key IS NOT NULL ORDER BY id ASC").all(bansos.id) : [];
    let worker = null;
    for (const w of ws) {
      const used = db.prepare("SELECT tokens FROM bansos_usage WHERE day=? AND worker_id=?").get(day, w.id);
      if (!used || used.tokens < BANSOS_DAILY_TOKENS) { worker = w; break; }
    }
    if (!worker) return openaiError(res, 429, "bansos_pool_empty", "Pool Bansos hari ini habis.");
    const fwdModel = BANSOS_MODEL_MAP[model] || model;
    const isStream = body.stream === true;
    try {
      const upstream = await fetchTimeout(base.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + worker.upstream_api_key, "User-Agent": "HestiaFlow/1.0" },
        body: JSON.stringify({ ...body, model: fwdModel, stream: isStream, ...(isStream ? { stream_options: { include_usage: true } } : {}) }),
      }, 120000);
      if (!upstream.ok) return openaiError(res, upstream.status, "upstream_error", "Upstream gagal.");
      const bump = (tokens) => {
        db.prepare("INSERT INTO bansos_usage (day,worker_id,tokens,requests) VALUES (?,?,?,1) ON CONFLICT(day,worker_id) DO UPDATE SET tokens=tokens+excluded.tokens, requests=requests+1")
          .run(day, worker.id, tokens);
      };
      if (isStream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        let tail = "";
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            tail += chunk;
            res.write(chunk);
          }
        } finally { try { res.end(); } catch { /* abaikan */ } }
        const m = tail.match(/"usage"\s*:\s*\{[^}]*"total_tokens"\s*:\s*(\d+)/);
        bump(m ? Number(m[1]) : 0);
        return;
      }
      const data = await upstream.json().catch(() => null);
      if (!data) return openaiError(res, 502, "upstream_error", "Upstream gagal.");
      bump(data.usage ? Number(data.usage.total_tokens || 0) : 0);
      return res.json(data);
    } catch { return openaiError(res, 502, "upstream_error", "Upstream tidak terjangkau."); }
  }
  const provider = providerById(key.provider_id);
  const tier = tierById(key.tier_id);
  const tierSlug = tier ? tier.slug : null;
  if (key.user_id) {
    const u = db.prepare("SELECT * FROM users WHERE id=?").get(key.user_id);
    if (u && u.suspended) return openaiError(res, 403, "suspended", "Akun ditangguhkan.");
  }
  if (key.expires_at && new Date(key.expires_at) < new Date()) return openaiError(res, 401, "key_expired", "Key kedaluwarsa.");
  if (tierSlug === "pro" && !proEnabled()) return openaiError(res, 403, "pro_locked", "Tier Pro sedang dikunci.");
  const models = gatewayKeyModels(key);
  if (!models.includes(model)) return openaiError(res, 404, "model_not_found", "Model tidak ada di daftar key ini.");
  const isStream = body.stream === true;
  const out = await upstreamChat({ key, provider, tierSlug, model, body, isStream, res });
  if (out === true) return;
  return openaiError(res, 502, "upstream_error", "Semua kandidat upstream gagal.");
});
app.post("/v1/images/generations", async (req, res) => {
  const key = gatewayAuth(req);
  if (!key) return openaiError(res, 401, "invalid_api_key", "API key tidak dikenal.");
  const tier = tierById(key.tier_id);
  const provider = providerById(key.provider_id);
  if (tier && tier.slug === "media") return handleMedia(req, res, "image", key);
  if (provider && provider.brand_name === "Stella") {
    const body = req.body || {};
    const base = provider.upstream_url || "";
    const token = provider.upstream_api_key;
    if (!base || !token) return openaiError(res, 502, "upstream_not_configured", "Upstream image belum dikonfigurasi.");
    try {
      const upstream = await fetchTimeout(base.replace(/\/$/, "") + "/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(body),
      }, 180000);
      const data = await upstream.json().catch(() => null);
      if (!upstream.ok || !data) return openaiError(res, upstream.status || 502, "upstream_error", "Upstream image gagal.");
      return res.json(data);
    } catch { return openaiError(res, 502, "upstream_error", "Upstream image tidak terjangkau."); }
  }
  return openaiError(res, 403, "image_premium_only", "Generate gambar hanya untuk pengguna Premium (Stella). Upgrade paket untuk memakai fitur ini.");
});
app.post("/v1/videos/generations", async (req, res) => {
  const key = gatewayAuth(req);
  if (!key) return openaiError(res, 401, "invalid_api_key", "API key tidak dikenal.");
  return handleMedia(req, res, "video", key);
});

// ---------- fallback ----------
app.use("/api", (req, res) => res.status(404).json({ ok: false, error: "not_found" }));
app.use("/v1", (req, res) => openaiError(res, 404, "not_found", "Route tidak dikenal."));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ---------- background ----------
function cleanupExpiredKeys() {
  try {
    const rows = db.prepare("SELECT id FROM api_keys WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')").all();
    for (const r of rows) {
      db.prepare("DELETE FROM harvested_accounts WHERE api_key_id=?").run(r.id);
      db.prepare("DELETE FROM api_keys WHERE id=?").run(r.id);
    }
  } catch { /* abaikan */ }
}
async function sweepVegaPool() {
  try {
    const list = await fetchProxyList();
    const apiBase = providerBase("Vega");
    if (!apiBase) return;
    const authBase = apiBase.replace("://api.", "://chat.").replace(/\/v1$/, "");
    const cand = [...list].sort(() => Math.random() - 0.5).slice(0, 300);
    const checks = await Promise.all(cand.map(async (px) => {
      const d = proxyDispatcher(px);
      if (!d) return null;
      try {
        const r = await fetchTimeout(authBase + "/api/auth/csrf/", { dispatcher: d, headers: { "User-Agent": randUA() } }, 8000);
        return r.status < 500 ? px : null;
      } catch { return null; }
    }));
    const okSet = new Set(checks.filter(Boolean));
    for (const px of okSet) db.prepare("INSERT OR REPLACE INTO proxy_pool (host, target, last_ok, fails) VALUES (?, 'vega', datetime('now'), 0)").run(px);
    for (const px of cand) if (!okSet.has(px)) db.prepare("UPDATE proxy_pool SET fails=fails+1 WHERE host=? AND target='vega'").run(px);
    db.prepare("DELETE FROM proxy_pool WHERE target='vega' AND fails>=3").run();
    const pool = db.prepare("SELECT COUNT(*) c FROM proxy_pool WHERE target='vega' AND fails=0").get().c;
    console.log("[proxy-pool] target=vega dicek=" + cand.length + " lolos=" + okSet.size + " pool=" + pool);
  } catch (e) { console.log("[proxy-pool] sweep gagal:", e.message); }
}
cleanupExpiredKeys();
const cleanupTimer = setInterval(cleanupExpiredKeys, 30 * 60 * 1000);
if (cleanupTimer.unref) cleanupTimer.unref();
sweepVegaPool();
const sweepTimer = setInterval(sweepVegaPool, 15 * 60 * 1000);
if (sweepTimer.unref) sweepTimer.unref();

app.listen(PORT, () => console.log("[hestiaflow] listening on port " + PORT));
