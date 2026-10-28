import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deepProbe } from "./probe.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");
const RESULTS_PATH = path.join(__dirname, "results.json");

const DEFAULT_CFG = {
  baseURL: "",
  apiKey: "",
  timeoutMs: 90000,
  prompt: "Write a Python function named solve that returns the nth Fibonacci number using iterative DP. Then give 3 unit tests.",
  maxTokens: 256,
  runs: 1,
  concurrency: 3,
};

async function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8")); } catch {}
  return { ...DEFAULT_CFG, ...cfg };
}

async function saveConfig(patch) {
  const cur = await loadConfig();
  const next = { ...cur, ...patch };
  if (next.baseURL) next.baseURL = String(next.baseURL).trim().replace(/\/+$/, "");
  if (next.apiKey) next.apiKey = String(next.apiKey).trim();
  await fs.writeFile(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

const maskKey = (k) => (!k ? "" : k.length <= 8 ? "â€¢â€¢â€¢â€¢" : k.slice(0, 4) + "â€¢â€¢â€¢â€¢â€¢â€¢" + k.slice(-4));

/**
 * Satu request ke endpoint OpenAI-compatible. Mengukur waktu sampai byte pertama
 * (TTFT) dan waktu total. Tidak pernah throw untuk error HTTP â€” hasilnya object.
 */
async function probe(model, cfg, signal) {
  const started = performance.now();
  let ttft = null;
  let status = 0;
  let err = null;
  let content = "";
  let usage = null;

  try {
    const res = await fetch(`${cfg.baseURL.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: cfg.maxTokens ?? 256,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: cfg.prompt }],
      }),
    });
    status = res.status;

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      err = `HTTP ${res.status}: ${text.slice(0, 200) || res.statusText}`;
    } else {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let json;
          try { json = JSON.parse(payload); } catch { continue; }
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            if (ttft === null) ttft = Math.round(performance.now() - started);
            content += delta;
          }
          if (json.usage) usage = json.usage;
          if (json.error) err = json.error.message ?? JSON.stringify(json.error);
        }
      }
      if (!content.trim() && !err) err = "Respons kosong";
    }
  } catch (e) {
    err = e.name === "AbortError" ? "Timeout" : e.message;
  }

  const total = Math.round(performance.now() - started);
  return {
    model,
    ok: !err,
    status,
    error: err,
    ttft: ttft ?? total,
    total,
    tokensOut: usage?.completion_tokens ?? null,
    tokensIn: usage?.prompt_tokens ?? null,
    tps: usage?.completion_tokens ? +(usage.completion_tokens / (total / 1000)).toFixed(2) : null,
    preview: content.slice(0, 400),
    at: new Date().toISOString(),
  };
}

const app = express();
app.use(express.json({ limit: "1mb" }));
// Error JSON rusak -> balas 400, jangan lempar stack trace HTML
app.use((err, _req, res, next) => {
  if (!err) return next();
  res.status(err.status || 400).json({ error: err.message || "Request tidak valid" });
});
app.use(express.static(path.join(__dirname, "public")));

// Terima JSON body sebagai raw string, parse sendiri (tahan terhadap quoting PowerShell/curl)
const rawJson = express.text({ type: ["application/json", "text/*"], limit: "2mb" });
function readBody(req) {
  const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  try { return JSON.parse(raw || "{}"); } catch { return { __invalid: true }; }
}

// Daftar model live dari endpoint (bukan dari config, supaya ikut update)
app.get("/api/models", async (_req, res) => {
  try {
    const cfg = await loadConfig();
    if (!cfg.baseURL || !cfg.apiKey) return res.json({ models: [], needsConfig: true, prompt: cfg.prompt, maxTokens: cfg.maxTokens, runs: cfg.runs });
    const r = await fetch(`${cfg.baseURL.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    if (!r.ok) return res.status(502).json({ error: `HTTP ${r.status}` });
    const json = await r.json();
    const ids = (json.data ?? []).map((m) => m.id).sort();
    res.json({
      models: ids,
      prompt: cfg.prompt,
      maxTokens: cfg.maxTokens,
      runs: cfg.runs,
      host: new URL(cfg.baseURL).host,
      keyMask: maskKey(cfg.apiKey),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Konfigurasi provider (bisa diganti tanpa edit file) ----------
app.get("/api/config", async (_req, res) => {
  const cfg = await loadConfig();
  res.json({
    baseURL: cfg.baseURL,
    keyMask: maskKey(cfg.apiKey),
    hasKey: !!cfg.apiKey,
    prompt: cfg.prompt,
    maxTokens: cfg.maxTokens,
    runs: cfg.runs,
    timeoutMs: cfg.timeoutMs,
  });
});

app.put("/api/config", async (req, res) => {
  const b = req.body ?? {};
  const out = {};
  if (typeof b.baseURL === "string" && b.baseURL.trim()) out.baseURL = b.baseURL;
  if (typeof b.apiKey === "string" && b.apiKey.trim()) out.apiKey = b.apiKey;
  if (b.prompt) out.prompt = String(b.prompt);
  if (b.maxTokens) out.maxTokens = Math.min(Math.max(Number(b.maxTokens), 16), 4096);
  if (b.runs) out.runs = Math.min(Math.max(Number(b.runs), 1), 5);
  if (b.timeoutMs) out.timeoutMs = Math.min(Math.max(Number(b.timeoutMs), 5000), 300000);
  if (!Object.keys(out).length) return res.status(400).json({ error: "Tidak ada perubahan" });

  const cfg = await saveConfig(out);
  // verifikasi langsung: endpoint harus bisa menyebut model
  try {
    const r = await fetch(`${cfg.baseURL}/models`, { headers: { Authorization: `Bearer ${cfg.apiKey}` }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return res.status(400).json({ error: `Endpoint menolak (HTTP ${r.status}). Cek base URL & API key.` });
    const j = await r.json();
    const count = (j.data ?? []).length;
    if (!count) return res.status(400).json({ error: "Tersambung tapi tidak ada model." });
    res.json({ ok: true, baseURL: cfg.baseURL, keyMask: maskKey(cfg.apiKey), models: count });
  } catch (e) {
    return res.status(400).json({ error: "Gagal menghubungi endpoint: " + e.message });
  }
});

// ---------- Deep probe: ukur kualitas + kecepatan per jenis kemampuan ----------
app.post("/api/probe", async (req, res) => {
  const model = req.body?.model;
  if (typeof model !== "string" || !model) return res.status(400).json({ error: "model kosong" });
  try {
    const cfg = await loadConfig();
    if (!cfg.baseURL) return res.status(400).json({ error: "Provider belum diatur" });
    res.json(await deepProbe(model, cfg));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Benchmark blocking: kirim semua model, balas saat selesai semua
app.post("/api/bench", rawJson, async (req, res) => {
  const body = readBody(req);
  const models = Array.isArray(body?.models) ? body.models.filter((m) => typeof m === "string") : [];
  if (!models.length) return res.status(400).json({ error: "models kosong" });
  const runs = Math.min(Math.max(Number(body?.runs) || 1, 1), 5);
  try {
    const cfg = await loadConfig();
    const jobs = [];
    for (const m of models) for (let i = 0; i < runs; i++) jobs.push(m);
    const results = await mapLimit(jobs, Math.min(cfg.concurrency ?? 3, 8), (m) =>
      probe(m, { ...cfg, prompt: body?.prompt || cfg.prompt }, AbortSignal.timeout(cfg.timeoutMs ?? 90000))
    );
    await saveHistory({ mode: "batch", results });
    res.json({ results: summarize(results), raw: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Benchmark streaming (NDJSON): satu baris per hasil, plus event progress
app.post("/api/bench/stream", rawJson, async (req, res) => {
  const body = readBody(req);
  const models = Array.isArray(body?.models) ? body.models.filter((m) => typeof m === "string") : [];
  if (!models.length) return res.status(400).json({ error: "models kosong" });
  const runs = Math.min(Math.max(Number(body?.runs) || 1, 1), 5);

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const send = (o) => res.write(JSON.stringify(o) + "\n");

  try {
    const cfg = await loadConfig();
    const jobs = [];
    for (const m of models) for (let i = 0; i < runs; i++) jobs.push({ m, i });
    const all = [];
    send({ type: "start", total: jobs.length });
    await mapLimit(jobs, Math.min(cfg.concurrency ?? 3, 8), async ({ m, i }) => {
      const r = await probe(m, { ...cfg, prompt: body?.prompt || cfg.prompt }, AbortSignal.timeout(cfg.timeoutMs ?? 90000));
      r.run = i + 1;
      all.push(r);
      send({ type: "result", result: r });
      return r;
    });
    await saveHistory({ mode: "stream", results: all });
    send({ type: "done", summary: summarize(all) });
  } catch (e) {
    send({ type: "error", error: e.message });
  } finally {
    res.end();
  }
});

app.get("/api/history", async (_req, res) => {
  try {
    const rows = JSON.parse(await fs.readFile(RESULTS_PATH, "utf8"));
    res.json({ history: rows.slice(-50).reverse() });
  } catch {
    res.json({ history: [] });
  }
});

app.delete("/api/history", async (_req, res) => {
  await fs.writeFile(RESULTS_PATH, "[]").catch(() => {});
  res.json({ ok: true });
});

async function saveHistory(entry) {
  let rows = [];
  try { rows = JSON.parse(await fs.readFile(RESULTS_PATH, "utf8")); } catch {}
  rows.push({ ...entry, at: new Date().toISOString() });
  await fs.writeFile(RESULTS_PATH, JSON.stringify(rows.slice(-100), null, 2)).catch(() => {});
}

/** Ringkasan per model: median/avg/min/max + success rate. */
function summarize(raw) {
  const byModel = new Map();
  for (const r of raw) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  }
  return [...byModel.entries()]
    .map(([model, rs]) => {
      const ok = rs.filter((r) => r.ok);
      const totals = ok.map((r) => r.total).sort((a, b) => a - b);
      const ttfts = ok.map((r) => r.ttft).sort((a, b) => a - b);
      const tps = ok.map((r) => r.tps).filter((v) => v != null);
      const median = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : null);
      return {
        model,
        runs: rs.length,
        success: ok.length,
        successRate: +(ok.length / rs.length).toFixed(3),
        medianTotal: median(totals),
        avgTotal: totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : null,
        minTotal: totals[0] ?? null,
        maxTotal: totals.at(-1) ?? null,
        medianTTFT: median(ttfts),
        avgTps: tps.length ? +(tps.reduce((a, b) => a + b, 0) / tps.length).toFixed(1) : null,
        errors: [...new Set(rs.filter((r) => !r.ok).map((r) => r.error))].slice(0, 3),
      };
    })
    .sort((a, b) => (a.successRate !== b.successRate ? b.successRate - a.successRate : (a.medianTotal ?? 1e9) - (b.medianTotal ?? 1e9)));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

const PORT = Number(process.env.PORT) || 9400;
app.listen(PORT, "127.0.0.1", () => {
  console.log(`ReBENCH ready â†’ http://127.0.0.1:${PORT}`);
});

