// HestiaFlow — frontend baru (satu-satunya app.js). Tampilan sama seperti produksi,
// code ditulis ulang sederhana. Semua gaya ada di styles.css, bukan disuntik dari JS.
"use strict";
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtID = (n) => (n == null ? "" : Number(n).toLocaleString("id-ID"));
async function api(path, opts) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...(opts || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
  return j;
}
function copyText(text, btn) {
  const done = () => { if (btn) { const old = btn.textContent; btn.textContent = "Tersalin!"; setTimeout(() => { btn.textContent = old; }, 1200); } };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(done);
  else { const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); } catch {} t.remove(); done(); }
}
function scrollToId(id) { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }

let ME = null, TIERS = [], SETTINGS = {}, POOL = {}, MYKEYS = [], LAST_HARVEST_KEYS = [];
let pickedProviderId = null, pickedTierSlug = null, harvestPollTimer = null, bansosTimer = null, fabOpen = true;
const TIER_RANK = { gratis: 0, plus: 1, pro: 2, premium: 3 };
const HARVEST_LIMIT = { gratis: 100, plus: 500, pro: 1500, premium: 5000, media: 500 };
const PRICES = { plus: "Rp 5.000/3 hari", pro: "Rp 8.000/1 minggu", premium: "Rp 15.000/2 minggu" };

async function load() {
  try { const m = await api("/api/me"); ME = m.user; } catch { ME = null; }
  try { const t = await api("/api/public/tiers"); TIERS = t.tiers || []; } catch { TIERS = []; }
  try { SETTINGS = await api("/api/public/settings"); } catch { SETTINGS = {}; }
  try { POOL = await api("/api/public/pool"); } catch { POOL = {}; }
  renderAuth();
  render();
  loadBansos();
  document.body.classList.add("loaded");
}
function renderAuth() {
  const area = $("#authArea");
  if (!area) return;
  if (ME) {
    area.innerHTML = '<span class="auth-name">' + esc(ME.name || ME.email) + "</span> " +
      '<button class="btn btn-ghost btn-sm" onclick="doLogout()">Keluar</button>';
  } else {
    area.innerHTML = '<a class="btn btn-gold btn-sm" href="/auth/google">Login Google</a>';
  }
}
async function doLogout() { try { await api("/api/logout", { method: "POST" }); } catch {} location.reload(); }

function shortTierName(t) { return (t.name || t.slug || "").split(" ")[0]; }
function tierProviders(t) { return t.providers || []; }
function allProviders() { const out = []; for (const t of TIERS) for (const p of tierProviders(t)) out.push({ tier: t, provider: p }); return out; }
function userRank() { if (!ME) return 0; return TIER_RANK[ME.tierSlug] ?? 0; }
function pickDefaultProvider() {
  const rank = userRank();
  for (const { tier, provider } of allProviders()) {
    if (tier.locked) continue;
    const r = tier.slug === "media" ? 0 : (TIER_RANK[tier.slug] ?? 0);
    if (r <= rank) { pickedProviderId = provider.id; pickedTierSlug = tier.slug; return; }
  }
  const first = allProviders()[0];
  if (first) { pickedProviderId = first.provider.id; pickedTierSlug = first.tier.slug; }
}
function harvestLimitFor(slug) { return HARVEST_LIMIT[slug] || 50; }

function render() {
  const app = $("#app");
  if (!app) return;
  if (pickedProviderId == null) pickDefaultProvider();
  const hero = '<section class="hero"><h1>Satu akun Google, semua API terbuka.</h1><div class="goldline"></div></section>';
  let cards = "";
  for (const t of TIERS) {
    const providers = tierProviders(t);
    const totalModels = providers.reduce((n, p) => n + (p.modelCount || 0), 0);
    const price = PRICES[t.slug] ? '<div class="price">' + PRICES[t.slug] + "</div>" : "";
    const lockedBadge = t.locked ? '<span class="badge locked-badge">🔒 Segera Hadir</span>' : "";
    let provHtml = "";
    for (const p of providers) {
      const medalClass = t.slug === "premium" ? "medal gold" : "medal";
      provHtml += '<div class="provider-row"><span class="' + medalClass + '">' + esc((p.brand || "?")[0]) + "</span>" +
        '<div class="provider-info"><b>' + esc(p.brand) + "</b><span>" + esc(p.tagline || "") + "</span></div>" +
        '<span class="chip">' + (p.modelCount || 0) + " model</span>" +
        (p.creditNote ? '<span class="chip">' + esc(p.creditNote) + "</span>" : "") +
        '<button class="btn btn-ghost btn-sm" onclick="showTierModels(' + p.id + ')">🔍 Lihat Model</button></div>';
    }
    cards += '<article class="card tier ' + esc(t.slug) + '">' +
      '<div class="card-head"><span class="badge ' + esc(t.slug) + '">' + esc(t.badge || t.name) + "</span>" + lockedBadge + "</div>" +
      "<h2>" + esc(t.name) + "</h2>" +
      '<div class="audience">' + esc(t.audienceLabel || "") + "</div>" + price +
      '<div class="model-total">' + totalModels + " model</div>" + provHtml + "</article>";
  }
  const showcase = '<section class="tier-showcase"><h2>Pilihan Paket Tier</h2><div class="tier-grid">' + cards + "</div></section>";
  app.innerHTML = hero + showcase + bansosSection() + voucherSection() + harvestSection() + keysSection() +
    '<div id="creditPanel" class="panel hidden"></div><div id="apiPanel" class="panel hidden"></div>' +
    '<div id="fabWrap"><button id="creditBubbleBtn" title="Credit / Token Saya" onclick="toggleCreditPanel()">🪙</button>' +
    '<button id="apiBubbleBtn" title="Contoh API" onclick="toggleApiPanel()">&lt;/&gt;</button></div>' +
    '<div id="fabEdgeTab" onclick="toggleFab()"><span id="fabEdgeGlyph">‹</span></div>' +
    '<div id="modelListModal" class="tier-lock-modal hidden"><div class="modal-box"><div id="modelListBody"></div>' +
    '<button class="btn btn-plum" onclick="closeTierModels()">Tutup</button></div></div>' +
    '<div id="tierLockModal" class="tier-lock-modal hidden"><div class="modal-box"><h3>Segera Hadir</h3>' +
    "<p>Tier ini belum tersedia.</p>" +
    '<button class="btn btn-plum" onclick="closeTierLock()">Tutup</button></div></div>' +
    (ME && ME.is_admin ? '<section id="adminSection"></section>' : "");
  renderPicker();
  loadUser();
  if (ME && ME.is_admin) loadAdmin();
}
function bansosSection() {
  const pool = POOL || {};
  const enabled = pool.enabled !== false;
  const remaining = pool.remaining != null ? fmtID(pool.remaining) : "-";
  return '<section class="card bansos"><h2>🎁 Bansos</h2>' +
    (enabled
      ? "<p>Pool harian: <b>" + remaining + "</b> token tersisa dari " + fmtID(pool.total || 0) + ".</p>"
      : "<p>Bansos sedang dikunci.</p>") +
    '<div id="bansosKeys"></div>' +
    '<button id="bansosBtn" class="btn btn-gold" onclick="createBansosKey()" ' + (enabled ? "" : "disabled") + ">Ambil Key Bansos</button>" +
    '<div id="bansosMsg" class="msg"></div></section>';
}
function voucherSection() {
  return '<section class="card voucher"><h2>🎟️ Tukar Vocher</h2>' +
    '<div class="row"><input id="voucherCode" placeholder="Kode vocher (XXXX-XXXX-XXXX-XXXX)">' +
    '<button class="btn btn-plum" onclick="redeemVoucher()">Tukar</button></div>' +
    '<div id="voucherMsg" class="msg"></div></section>';
}
function harvestSection() {
  return '<section class="card harvest"><h2>🌾 Panen Akun</h2>' +
    '<div id="harvestPicker"></div>' +
    '<div class="row"><label id="harvestCountLabel">Jumlah akun (1–50)</label>' +
    '<input id="harvestCount" type="number" value="5" min="1" max="50">' +
    '<button id="harvestBtn" class="btn btn-gold" onclick="doUserHarvest()">Panen Akun</button></div>' +
    '<div id="harvestProgWrap" class="prog-wrap hidden"><div id="harvestProg" class="prog"></div></div>' +
    '<div id="harvestProc" class="msg"></div><div id="harvestSummary"></div></section>';
}
function keysSection() {
  return '<section class="card keys"><h2>🔑 Key Saya</h2><div id="keysList"></div>' +
    '<div class="row"><button class="btn btn-ghost" onclick="copyAllHarvestKeys()">Salin Semua</button>' +
    '<button class="btn btn-danger" onclick="deleteAllHarvestKeys()">Hapus Semua Hasil Panen</button></div></section>';
}
function renderPicker() {
  const box = $("#harvestPicker");
  if (!box) return;
  const rank = userRank();
  let html = "";
  for (const { tier, provider } of allProviders()) {
    const r = tier.slug === "media" ? 0 : (TIER_RANK[tier.slug] ?? 0);
    const locked = tier.locked || r > rank;
    const cls = "tier-side-opt" + (provider.id === pickedProviderId ? " sel" : "") + (locked ? " locked" : "");
    const label = (locked ? "🔒 " : "") + shortTierName(tier) + " • " + (provider.modelCount || 0) + " Model";
    html += locked
      ? '<span class="' + cls + '">' + esc(label) + "</span>"
      : '<button class="' + cls + '" onclick="pickProvider(' + provider.id + ",'" + esc(tier.slug) + "')\">" + esc(label) + "</button>";
  }
  box.innerHTML = html;
  syncHarvestLimit();
}
function pickProvider(id, slug) { pickedProviderId = id; pickedTierSlug = slug; renderPicker(); }
function syncHarvestLimit() {
  const input = $("#harvestCount"), label = $("#harvestCountLabel");
  if (!input || !label) return;
  const limit = harvestLimitFor(pickedTierSlug);
  input.max = limit;
  label.textContent = "Jumlah akun (1–" + limit + ")";
  let v = parseInt(input.value, 10);
  if (isNaN(v) || v < 1) v = 1;
  if (v > limit) v = limit;
  input.value = v;
}
function showComingSoon() { const m = $("#tierLockModal"); if (m) m.classList.remove("hidden"); }
function closeTierLock() { const m = $("#tierLockModal"); if (m) m.classList.add("hidden"); }
async function showTierModels(pid) {
  try {
    const d = await api("/api/public/providers/" + pid + "/models");
    const models = d.models || [];
    const notes = d.notes || {};
    let list = models.map((m) => "<li>" + esc(m) + (notes[m] ? " — <i>" + esc(notes[m]) + "</i>" : "") + "</li>").join("");
    $("#modelListBody").innerHTML = "<h3>" + esc(d.brand || "") + " — " + models.length + " model</h3><ul class='model-list'>" + list + "</ul>";
    $("#modelListModal").classList.remove("hidden");
  } catch (e) { alert("Gagal memuat model: " + e.message); }
}
function closeTierModels() { const m = $("#modelListModal"); if (m) m.classList.add("hidden"); }

// ---------- panen user ----------
async function doUserHarvest() {
  const btn = $("#harvestBtn");
  const proc = $("#harvestProc"), summary = $("#harvestSummary"), progWrap = $("#harvestProgWrap"), prog = $("#harvestProg");
  syncHarvestLimit();
  const count = parseInt($("#harvestCount").value, 10);
  const provider = allProviders().find((x) => x.provider.id === pickedProviderId);
  if (!provider || provider.tier.locked) { if (proc) proc.textContent = "Panen dibatalkan: provider terkunci/tidak valid."; return; }
  if (btn) btn.disabled = true;
  if (proc) proc.textContent = "Lagi Proses... Scrap Proxy...";
  if (summary) summary.innerHTML = "";
  if (progWrap) progWrap.classList.remove("hidden");
  if (prog) prog.style.width = "0%";
  let jobId;
  try {
    const out = await api("/api/harvest", { method: "POST", body: JSON.stringify({ providerId: pickedProviderId, count }) });
    jobId = out.jobId;
    if (!jobId) throw new Error("Panen gagal dimulai");
  } catch (e) {
    if (proc) proc.textContent = "Gagal: " + e.message;
    if (btn) btn.disabled = false;
    return;
  }
  if (harvestPollTimer) clearInterval(harvestPollTimer);
  harvestPollTimer = setInterval(async () => {
    let d;
    try { d = await api("/api/harvest/job/" + jobId); }
    catch (e) {
      clearInterval(harvestPollTimer);
      if (proc) proc.textContent = "Panen tidak ditemukan, cek Key Saya";
      if (btn) btn.disabled = false;
      return;
    }
    const job = d.job || {};
    if (job.status === "done") {
      clearInterval(harvestPollTimer);
      if (prog) prog.style.width = "100%";
      if (proc) proc.textContent = "Panen selesai.";
      renderHarvestResult(job);
      if (btn) btn.disabled = false;
      loadUser();
    } else if (job.status === "failed") {
      clearInterval(harvestPollTimer);
      if (proc) proc.textContent = "Gagal: " + (job.error || "Panen gagal");
      if (btn) btn.disabled = false;
    } else {
      const total = job.count || count;
      const done = job.doneCount || 0, live = job.liveCount || 0;
      if (prog) prog.style.width = (total ? (done / total) * 100 : 0) + "%";
      if (proc) proc.textContent = "Lagi Proses... akun " + done + " dari " + total + ", live " + live +
        (job.proxyTotal ? " · Total Proxy OK: " + job.proxyTotal : "");
    }
  }, 3000);
}
function renderHarvestResult(job) {
  const summary = $("#harvestSummary");
  if (!summary) return;
  const keys = job.keys || [];
  LAST_HARVEST_KEYS = keys;
  let html = "<p>Live: " + (job.liveCount || 0) + " · Mati: " + Math.max(0, (job.count || 0) - (job.liveCount || 0)) +
    (job.proxyTotal ? " · Total Proxy OK: " + job.proxyTotal : "") + "</p>";
  for (const k of keys) {
    html += '<div class="keybox">' + esc(k.providerBrand || "") + " · " + esc(k.tierSlug || "") +
      (k.live ? " · <b>Live</b>" : " · Mati") +
      '<div class="key-text">' + esc(k.live && k.key ? k.key : (k.keyPrefix || "")) + "</div>" +
      '<div class="key-meta">Credit: ' + (k.credit == null ? "—" : fmtID(k.credit)) +
      " · Model: " + (k.modelCount || 0) + " (" + esc(k.modelSource || "") + ")</div></div>";
  }
  summary.innerHTML = html;
}
// ---------- key saya ----------
async function loadUser() {
  let keys = [];
  try { const d = await api("/api/my-keys"); keys = d.keys || []; } catch { keys = []; }
  MYKEYS = keys;
  const list = $("#keysList");
  if (!list) return;
  if (!keys.length) { list.innerHTML = "<p>Belum ada key. Panen akun dulu.</p>"; return; }
  list.innerHTML = keys.map((k) => '<div class="keybox">' + esc(k.providerBrand || "") + " · " + esc(k.tierSlug || "") +
    (k.live ? " · <b>Live</b>" : " · Mati") +
    '<div class="key-text">' + esc(k.live && k.key ? k.key : (k.keyPrefix || "")) + "</div>" +
    '<div class="key-meta">Credit: ' + (k.credit == null ? "—" : fmtID(k.credit)) +
    " · Model: " + (k.modelCount || 0) + " (" + esc(k.modelSource || "") + ")" +
    " · Akun: " + (k.liveAccounts || 0) + "</div>" +
    '<div class="row">' +
    (k.live && k.key ? '<button class="btn btn-ghost btn-sm" onclick="copyText(decodeURIComponent(\'' + encodeURIComponent(k.key) + "'), this)\">Salin</button>" : "") +
    '<button class="btn btn-danger btn-sm" onclick="deleteMyKey(' + k.id + ')">Hapus</button></div></div>').join("");
}
async function deleteMyKey(id) {
  if (!confirm("Hapus key ini?")) return;
  try { await api("/api/my-keys/" + id, { method: "DELETE" }); } catch (e) { alert("Gagal: " + e.message); }
  loadUser();
}
function copyAllHarvestKeys() {
  const live = MYKEYS.filter((k) => k.live && k.key).map((k) => k.key);
  if (!live.length) { alert("Tidak ada key live."); return; }
  copyText(live.join("\n"));
}
async function deleteAllHarvestKeys() {
  if (!LAST_HARVEST_KEYS.length) { alert("Tidak ada hasil panen terakhir."); return; }
  if (!confirm("Hapus semua key hasil panen terakhir?")) return;
  for (const k of LAST_HARVEST_KEYS) { try { await api("/api/my-keys/" + k.id, { method: "DELETE" }); } catch {} }
  LAST_HARVEST_KEYS = [];
  loadUser();
}
// ---------- bansos ----------
async function loadBansos() {
  try { POOL = await api("/api/bansos/pool"); } catch {}
  let keys = [];
  try { const d = await api("/api/bansos/my-keys"); keys = d.keys || []; } catch {}
  const box = $("#bansosKeys");
  if (box) {
    box.innerHTML = keys.length
      ? keys.map((k) => '<div class="keybox"><div class="key-text">' + esc(k.key) + "</div></div>").join("")
      : "<p>Belum ada key Bansos.</p>";
  }
  const btn = $("#bansosBtn");
  if (btn) btn.disabled = POOL.enabled === false || keys.length >= 2;
  if (!bansosTimer) bansosTimer = setInterval(async () => { try { POOL = await api("/api/bansos/pool"); } catch {} loadBansos(); }, 30000);
}
async function createBansosKey() {
  const msg = $("#bansosMsg");
  try {
    const d = await api("/api/bansos/keys", { method: "POST", body: "{}" });
    if (msg) msg.textContent = "Key Bansos dibuat: " + (d.keyPrefix || "");
    loadBansos();
  } catch (e) { if (msg) msg.textContent = "Gagal: " + e.message; }
}
// ---------- voucher ----------
async function redeemVoucher() {
  const code = ($("#voucherCode") || {}).value || "";
  const msg = $("#voucherMsg");
  try {
    const d = await api("/api/voucher/redeem", { method: "POST", body: JSON.stringify({ code }) });
    if (msg) msg.textContent = d.message || "Vocher berhasil ditukar.";
    setTimeout(() => location.reload(), 1500);
  } catch (e) { if (msg) msg.textContent = "Gagal: " + e.message; }
}
// ---------- panel credit & api ----------
function toggleCreditPanel() {
  const panel = $("#creditPanel");
  if (!panel) return;
  if (!panel.classList.contains("hidden")) { panel.classList.add("hidden"); return; }
  $("#apiPanel").classList.add("hidden");
  let rows = "";
  const byTier = {};
  for (const k of MYKEYS) { const t = k.tierSlug || "?"; if (byTier[t] == null) byTier[t] = 0; if (k.credit != null) byTier[t] += k.credit; }
  for (const [t, v] of Object.entries(byTier)) rows += "<div>" + esc(t) + ": <b>" + fmtID(v) + "</b></div>";
  panel.innerHTML = "<h3>Credit / Token Saya</h3>" + (rows || "<p>Belum ada key.</p>");
  panel.classList.remove("hidden");
}
function toggleApiPanel() {
  const panel = $("#apiPanel");
  if (!panel) return;
  if (!panel.classList.contains("hidden")) { panel.classList.add("hidden"); return; }
  $("#creditPanel").classList.add("hidden");
  const base = (SETTINGS.base_url || location.origin).replace(/\/$/, "");
  const key = (MYKEYS[0] && MYKEYS[0].key) || "hgw-KEY_KAMU";
  panel.innerHTML = "<h3>Contoh API</h3>" +
    "<p>Base URL: <code>" + esc(base) + "</code></p>" +
    "<pre>curl " + esc(base) + "/v1/models -H \"Authorization: Bearer " + esc(key) + "\"</pre>" +
    "<pre>curl " + esc(base) + "/v1/chat/completions -H \"Authorization: Bearer " + esc(key) + "\" -H \"Content-Type: application/json\" -d '{\"model\": \"gpt-4o-mini\", \"messages\": [{\"role\": \"user\", \"content\": \"Halo\"}]}'</pre>";
  panel.classList.remove("hidden");
}
function toggleFab() {
  fabOpen = !fabOpen;
  const wrap = $("#fabWrap"), glyph = $("#fabEdgeGlyph");
  if (wrap) wrap.classList.toggle("fab-closed", !fabOpen);
  if (glyph) glyph.style.transform = fabOpen ? "rotate(0deg)" : "rotate(180deg)";
}

// ---------- admin ----------
let ADMIN_TAB = "pengguna", ADMIN_DATA = {}, KEY_FILTER_USER = null, ARMED = {};
async function switchTab(tab) {
  ADMIN_TAB = tab;
  if (ME && ME.is_admin) await loadAdmin();
}
async function loadAdmin() {
  const sec = $("#adminSection");
  if (!sec) return;
  try {
    const [stats, users, keys, vouchers, providers, workers, tiers, settings, logs] = await Promise.all([
      api("/api/admin/stats"), api("/api/admin/users"), api("/api/admin/keys"),
      api("/api/admin/vouchers"), api("/api/admin/providers"), api("/api/admin/workers"),
      api("/api/admin/tiers"), api("/api/admin/settings"), api("/api/admin/harvest-logs"),
    ]);
    ADMIN_DATA = { stats, users: users.users, keys: keys.keys, vouchers: vouchers.vouchers, providers, workers: workers.workers, tiers: tiers.tiers, settings, logs: logs.logs };
  } catch (e) { ADMIN_DATA = { error: e.message }; }
  renderAdmin();
}
function renderAdmin() {
  const sec = $("#adminSection");
  if (!sec) return;
  const d = ADMIN_DATA;
  if (d.error) { sec.innerHTML = '<section class="card admin"><h2>Panel Admin</h2><p>Gagal memuat: ' + esc(d.error) + "</p></section>"; return; }
  const s = d.stats || {};
  sec.innerHTML = '<section class="card admin"><h2>Panel Admin</h2>' +
    "<p>" + (s.users || 0) + " pengguna · " + (s.keys || 0) + " kunci · " + (s.providers || 0) + " provider · " +
    (s.workersActive || 0) + " worker aktif · " + (s.tiers || 0) + " tier</p>" +
    '<div class="tabs"><button class="tab' + (ADMIN_TAB === "pengguna" ? " sel" : "") + '" onclick="switchTab(\'pengguna\')">Pengguna</button>' +
    '<button class="tab' + (ADMIN_TAB === "admin" ? " sel" : "") + '" onclick="switchTab(\'admin\')">Admin</button></div>' +
    (ADMIN_TAB === "pengguna" ? renderAdminUsers() : renderAdminSections()) + "</section>";
}
function renderAdminUsers() {
  const users = ADMIN_DATA.users || [];
  return "<h3>Pengguna</h3>" + users.map((u) => '<div class="admin-row"><div><b>' + esc(u.name || "") + "</b> · " + esc(u.email || "") +
    " · " + esc(u.tierSlug || "") + (u.suspended ? " · <b>DITANGGUHKAN</b>" : "") +
    (u.lastIp ? " · IP " + esc(u.lastIp) : "") + "</div><div class='row'>" +
    '<button class="btn btn-ghost btn-sm" onclick="viewUserKeys(' + u.id + ')">Lihat Kunci</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="setUserTier(' + u.id + ')">Set Tier</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="askSuspendUser(' + u.id + ",'" + (u.suspended ? "0" : "1") + "')\">" + (u.suspended ? "Buka Blokir" : "Tangguhkan") + "</button>" +
    '<button class="btn btn-danger btn-sm" onclick="askDeleteUser(' + u.id + ')">Hapus</button></div></div>').join("") +
    '<div id="userKeysBox"></div>';
}
function renderAdminSections() {
  const d = ADMIN_DATA;
  const vouchers = (d.vouchers || []).map((v) => '<div class="admin-row"><code>' + esc(v.code) + "</code> · " + esc(v.tierSlug) +
    " · " + v.durationDays + " hari · " + (v.used ? "dipakai oleh " + esc(v.usedBy || "") : "belum dipakai") +
    '<div class="row"><button class="btn btn-ghost btn-sm" onclick="copyVoucher(\'' + esc(v.code) + "')\">Salin</button>" +
    '<button class="btn btn-danger btn-sm" onclick="deleteVoucher(' + v.id + ')">Hapus</button></div></div>').join("");
  const keys = (d.keys || []).map((k) => '<div class="admin-row"><code>' + esc(k.keyPrefix) + "</code> · " + esc(k.ownerEmail || "") +
    " · " + esc(k.providerBrand || "") + " · " + esc(k.tierSlug || "") + " · credit " + (k.credit == null ? "—" : fmtID(k.credit)) +
    '<button class="btn btn-danger btn-sm" onclick="askDeleteKeyAdmin(' + k.id + ')">Hapus</button></div>').join("");
  const providers = (d.providers || []).map((p) => '<div class="admin-row"><b>' + esc(p.brand_name) + "</b> · " + (p.model_count || 0) + " model" +
    '<div class="row"><input id="provKey-' + p.id + '" placeholder="Upstream API key baru">' +
    '<button class="btn btn-ghost btn-sm" onclick="setProviderKey(' + p.id + ')">Simpan Key</button></div></div>').join("");
  const workers = (d.workers || []).map((w) => '<div class="admin-row">#' + w.id + " · " + esc(w.name || "") + " · " + esc(w.status || "") +
    " · credit " + fmtID(w.credit || 0) + "</div>").join("");
  const logs = (d.logs || []).slice(0, 50).map((l) => "<div>" + esc(l.createdAt || "") + " · " + esc(l.message || "") + "</div>").join("");
  return "<h3>Vocher</h3><div class='row'><select id='voucherTier'><option value='plus'>Plus</option><option value='pro'>Pro</option><option value='premium'>Premium</option><option value='media'>Media</option></select>" +
    '<button class="btn btn-plum" onclick="createVoucher()">Buat Vocher</button></div>' + vouchers +
    "<h3>Kunci" + (KEY_FILTER_USER ? " (filter user #" + KEY_FILTER_USER + ' <button class="btn btn-ghost btn-sm" onclick="clearKeyFilter()">Hapus Filter</button>)' : "") + "</h3>" + keys +
    "<h3>Panen Admin</h3><div class='row'><select id='adminProvider'>" + (d.providers || []).map((p) => "<option value='" + p.id + "'>" + esc(p.brand_name) + "</option>").join("") + "</select>" +
    '<input id="adminCount" type="number" value="1" min="1" max="50">' +
    '<button class="btn btn-gold" onclick="doAdminHarvest()">Panen</button></div><div id="adminHarvestMsg" class="msg"></div>' +
    "<h3>Provider</h3>" + providers +
    "<h3>Worker</h3><div class='row'><select id='workerProvider'>" + (d.providers || []).map((p) => "<option value='" + p.id + "'>" + esc(p.brand_name) + "</option>").join("") + "</select>" +
    '<input id="workerName" placeholder="Nama worker"><input id="workerKey" placeholder="Upstream API key">' +
    '<button class="btn btn-plum" onclick="addWorker()">Tambah Worker</button></div>' + workers +
    "<h3>Tier Baru</h3><div class='row'><input id='newTierName' placeholder='Nama tier'><input id='newTierAud' placeholder='Audience label'><input id='newTierMax' type='number' placeholder='Max model'>" +
    '<button class="btn btn-plum" onclick="addTier()">Tambah Tier</button></div>' +
    "<h3>Pengaturan</h3><div class='row'><input id='setName' value='" + esc((d.settings || {}).gateway_name || "") + "'><input id='setBase' value='" + esc((d.settings || {}).base_url || "") + "'>" +
    '<button class="btn btn-plum" onclick="saveSettings()">Simpan</button></div>' +
    "<h3>Log Panen</h3><div class='log-box'>" + logs + "</div>";
}
async function createVoucher() {
  const tierSlug = ($("#voucherTier") || {}).value || "plus";
  try { const d = await api("/api/admin/vouchers", { method: "POST", body: JSON.stringify({ tierSlug }) }); alert("Vocher dibuat: " + d.code); loadAdmin(); }
  catch (e) { alert("Gagal: " + e.message); }
}
async function deleteVoucher(id) {
  if (!confirm("Hapus vocher ini?")) return;
  try { await api("/api/admin/vouchers/" + id, { method: "DELETE" }); loadAdmin(); } catch (e) { alert("Gagal: " + e.message); }
}
function copyVoucher(code) { copyText(code); alert("Kode tersalin: " + code); }
async function viewUserKeys(userId) {
  KEY_FILTER_USER = userId;
  try {
    const d = await api("/api/admin/keys?userId=" + userId);
    const box = $("#userKeysBox");
    if (box) box.innerHTML = "<h4>Kunci user #" + userId + "</h4>" + (d.keys || []).map((k) => "<div><code>" + esc(k.keyPrefix) + "</code> · " + esc(k.providerBrand || "") + "</div>").join("");
  } catch (e) { alert("Gagal: " + e.message); }
}
function clearKeyFilter() { KEY_FILTER_USER = null; loadAdmin(); }
async function setUserTier(userId) {
  const tierSlug = prompt("Tier baru (gratis/plus/pro/premium/media):");
  if (!tierSlug) return;
  try { await api("/api/admin/users/" + userId + "/tier", { method: "POST", body: JSON.stringify({ tierSlug }) }); loadAdmin(); }
  catch (e) { alert("Gagal: " + e.message); }
}
function armed(key, fn) {
  if (ARMED[key]) { delete ARMED[key]; fn(); return; }
  ARMED[key] = true;
  alert("Klik lagi untuk mengonfirmasi.");
  setTimeout(() => { delete ARMED[key]; }, 5000);
}
function askDeleteUser(id) { armed("delUser" + id, async () => { try { await api("/api/admin/users/" + id, { method: "DELETE" }); loadAdmin(); } catch (e) { alert("Gagal: " + e.message); } }); }
function askSuspendUser(id, val) { armed("susp" + id, async () => { try { await api("/api/admin/users/" + id + "/suspend", { method: "POST", body: JSON.stringify({ suspended: val === "1" }) }); loadAdmin(); } catch (e) { alert("Gagal: " + e.message); } }); }
function askDeleteKeyAdmin(id) { armed("delKey" + id, async () => { try { await api("/api/admin/keys/" + id, { method: "DELETE" }); loadAdmin(); } catch (e) { alert("Gagal: " + e.message); } }); }
async function addTier() {
  const name = ($("#newTierName") || {}).value || "";
  const audienceLabel = ($("#newTierAud") || {}).value || "";
  const maxModels = parseInt(($("#newTierMax") || {}).value || "", 10);
  try { await api("/api/admin/tiers", { method: "POST", body: JSON.stringify({ name, audienceLabel, maxModels: isNaN(maxModels) ? null : maxModels }) }); loadAdmin(); }
  catch (e) { alert("Gagal: " + e.message); }
}
function stepAdminCount(delta) {
  const input = $("#adminCount");
  if (!input) return;
  let v = (parseInt(input.value, 10) || 1) + delta;
  if (v < 1) v = 1;
  if (v > 50) v = 50;
  input.value = v;
}
async function doAdminHarvest() {
  const providerId = parseInt(($("#adminProvider") || {}).value || "", 10);
  const count = parseInt(($("#adminCount") || {}).value || "1", 10);
  const msg = $("#adminHarvestMsg");
  try {
    const out = await api("/api/admin/harvest", { method: "POST", body: JSON.stringify({ providerId, count }) });
    if (!out.jobId) throw new Error("Panen gagal dimulai");
    if (msg) msg.textContent = "Job #" + out.jobId + " berjalan...";
    const timer = setInterval(async () => {
      try {
        const d = await api("/api/harvest/job/" + out.jobId);
        if (d.job.status === "done") { clearInterval(timer); if (msg) msg.textContent = "Selesai: live " + d.job.liveCount + " dari " + d.job.count; loadAdmin(); }
        else if (d.job.status === "failed") { clearInterval(timer); if (msg) msg.textContent = "Gagal: " + (d.job.error || "Panen gagal"); }
        else if (msg) msg.textContent = "Berjalan: akun " + (d.job.doneCount || 0) + " dari " + d.job.count + ", live " + (d.job.liveCount || 0);
      } catch { clearInterval(timer); if (msg) msg.textContent = "Panen tidak ditemukan"; }
    }, 3000);
  } catch (e) { if (msg) msg.textContent = "Gagal: " + e.message; }
}
async function addWorker() {
  const providerId = parseInt(($("#workerProvider") || {}).value || "", 10);
  const name = ($("#workerName") || {}).value || "Worker";
  const upstreamApiKey = ($("#workerKey") || {}).value || "";
  try { await api("/api/admin/workers", { method: "POST", body: JSON.stringify({ providerId, name, upstreamApiKey }) }); loadAdmin(); }
  catch (e) { alert("Gagal: " + e.message); }
}
async function setProviderKey(providerId) {
  const upstreamApiKey = ($("#provKey-" + providerId) || {}).value || "";
  try { await api("/api/admin/providers/" + providerId, { method: "PUT", body: JSON.stringify({ upstreamApiKey }) }); alert("Key provider disimpan."); }
  catch (e) { alert("Gagal: " + e.message); }
}
async function saveSettings() {
  const gateway_name = ($("#setName") || {}).value || "";
  const base_url = ($("#setBase") || {}).value || "";
  try { await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ gateway_name, base_url }) }); alert("Pengaturan disimpan."); }
  catch (e) { alert("Gagal: " + e.message); }
}

document.addEventListener("DOMContentLoaded", load);
