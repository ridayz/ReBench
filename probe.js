// Deep probe: apa model ini bisa, seberapa cepat, seberapa pintar.
// Semua test kecil dan murah; hasil dinilai sendiri, bukan mengandalkan opini model.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(cfg, model, messages, { maxTokens = 64, extra = {}, signal } = {}) {
  const t0 = performance.now();
  const tFirst = { value: null };
  let text = "";
  let reasoning = "";
  let usage = null;
  let status = 0;
  let err = null;
  let aborted = false;

  try {
    const res = await fetch(`${cfg.baseURL}/chat/completions`, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        stream: false,
        messages,
        ...extra,
      }),
    });
    status = res.status;
    if (!res.ok) {
      err = `HTTP ${status}: ${(await res.text().catch(() => "")).slice(0, 160)}`;
    } else {
      const j = await res.json();
      const msg = j.choices?.[0]?.message ?? {};
      text = msg.content ?? "";
      reasoning = msg.reasoning_content ?? msg.reasoning ?? "";
      usage = j.usage ?? null;
      if (!text && !reasoning) err = "respons kosong";
    }
  } catch (e) {
    aborted = e.name === "TimeoutError" || e.name === "AbortError";
    err = aborted ? "timeout" : e.message;
  }
  const total = Math.round(performance.now() - t0);
  return {
    ok: !err,
    status,
    err,
    text: text.trim(),
    reasoning: reasoning.trim(),
    latency: total,
    tokensIn: usage?.prompt_tokens ?? null,
    tokensOut: usage?.completion_tokens ?? null,
    tps: usage?.completion_tokens ? +(usage.completion_tokens / (total / 1000)).toFixed(1) : null,
  };
}

const grade = (name, passed, latency, detail = "") => ({ name, passed, latency, detail });

/** Tes-tes individual. Tiap tes mengembalikan { name, passed, latency, detail }. */
export async function deepProbe(model, cfg) {
  const timeout = (ms) => AbortSignal.timeout(ms ?? 60000);

  // 1. Respons dasar + kecepatan nyata (3 request paralel untuk ukur throughput)
  const basic = await call(cfg, model, [{ role: "user", content: "Sebutkan satu warna, satu kata saja." }], { maxTokens: 16, signal: timeout(60000) });
  const tests = [];
  tests.push(grade("chat-dasar", basic.ok && basic.text.length > 0, basic.latency, basic.text.slice(0, 60)));

  // 2. Instruksi ketat: output harus persis "PONG"
  const strict = await call(cfg, model, [
    { role: "system", content: "You obey literally. Output only PONG." },
    { role: "user", content: "Reply. Nothing else." },
  ], { maxTokens: 8, signal: timeout(30000) });
  const strictOk = strict.ok && /^PONG$/i.test(strict.text.replace(/[^A-Za-z]/g, ""));
  tests.push(grade("patuh-instruksi", strictOk, strict.latency, strict.text.slice(0, 40)));

  // 3. Matematika kecil (cek penalaran cepat)
  const math = await call(cfg, model, [{ role: "user", content: "Berapa 17 * 23? Jawab hanya angka." }], { maxTokens: 16, signal: timeout(30000) });
  const mathOk = math.ok && math.text.replace(/[^\d]/g, "").includes("391");
  tests.push(grade("matematika", mathOk, math.latency, math.text.slice(0, 40)));

  // 4. Format JSON ketat (penting untuk agent/tool calling)
  const json = await call(cfg, model, [
    { role: "system", content: "Respond with valid JSON only. Schema: {\"ok\":true,\"n\":<int>}" },
    { role: "user", content: "n = 7" },
  ], { maxTokens: 64, signal: timeout(30000), extra: { response_format: { type: "json_object" } } });
  const jsonText = json.ok ? json.text.replace(/^```json\n?|```$/g, "").trim() : "";
  let jsonOk = false;
  try {
    const parsed = JSON.parse(jsonText);
    jsonOk = parsed.ok === true && Number(parsed.n) === 7;
  } catch {}
  tests.push(grade("output-json", jsonOk, json.latency, jsonText.slice(0, 60)));

  // 5. Coding mikro (fungsi + ekspektasi hasil)
  const code = await call(cfg, model, [
    { role: "system", content: "Answer with code only, no markdown, no explanation." },
    { role: "user", content: "Write a JS arrow function `isPalindrome(s)` that ignores case and non-alphanumerics." },
  ], { maxTokens: 220, signal: timeout(60000) });
  const codeText = code.ok ? code.text : "";
  const codeOk = /isPalindrome/.test(codeText) && /replace/.test(codeText) && /reverse/.test(codeText);
  tests.push(grade("coding", codeOk, code.latency, codeText.split("\n")[0]?.slice(0, 70) ?? ""));

  // 6. Instruksi panjang / recall di tengah konteks (uji context handling)
  const needle = "ZQ-4417";
  const filler = "Baris log tanpa makna apa pun. ".repeat(60);
  const recall = await call(cfg, model, [
    { role: "user", content: `${filler} Kode rahasia: ${needle}. ${filler}\n\nSebutkan kode rahasia di atas. Hanya kodenya.` },
  ], { maxTokens: 20, signal: timeout(60000) });
  const recallOk = recall.ok && recall.text.includes(needle);
  tests.push(grade("recall-konteks", recallOk, recall.latency, recall.text.slice(0, 50)));

  // 7. Klasifikasi singkat (agent routing)
  const route = await call(cfg, model, [
    { role: "system", content: "Klasifikasikan permintaan user. Balas SATU kata: KODE, DATA, TULIS, atau LAIN." },
    { role: "user", content: "Tolong perbaiki bug undefined di file auth.js" },
  ], { maxTokens: 8, signal: timeout(30000) });
  const routeOk = route.ok && /^KODE$/i.test(route.text.replace(/[^A-Za-z]/gi, ""));
  tests.push(grade("routing", routeOk, route.latency, route.text.slice(0, 30)));

  // 8. Vision: model suka diam-diam "buta". Kirim gambar 1x1 merah + token warna.
  const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const vision = await call(cfg, model, [
    {
      role: "user",
      content: [
        { type: "text", text: "Apa warna dominan gambar ini? Sebut satu kata: merah, hijau, atau biru." },
        { type: "image_url", image_url: { url: `data:image/png;base64,${png1x1}` } },
      ],
    },
  ], { maxTokens: 12, signal: timeout(45000) });
  const visionOk = vision.ok && /merah|red/i.test(vision.text);
  tests.push(grade("vision", visionOk, vision.latency, vision.text.slice(0, 40) || vision.err || ""));

  // 9. Konsistensi: 3 request identik, seberapa stabil latensinya
  const cons = await Promise.all(
    [0, 1, 2].map(() => call(cfg, model, [{ role: "user", content: "Balas dengan satu kata: stabil" }], { maxTokens: 8, signal: timeout(30000) }))
  );
  const lat = cons.filter((c) => c.ok).map((c) => c.latency);
  const avg = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null;
  const jitter = lat.length > 1 ? Math.round(Math.max(...lat) - Math.min(...lat)) : null;
  tests.push({ name: "konsistensi", passed: lat.length === 3, latency: avg ? Math.round(avg) : null, detail: jitter != null ? `jitter ±${jitter}ms` : "—", meta: { jitter } });

  const scored = tests.filter((t) => t.name !== "konsistensi");
  const passed = scored.filter((t) => t.passed).length;
  const score = Math.round((passed / scored.length) * 100);
  const latencies = tests.map((t) => t.latency).filter((v) => v != null).sort((a, b) => a - b);
  const medianLat = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null;

  return {
    model,
    at: new Date().toISOString(),
    score,
    passed,
    total: scored.length,
    medianLatency: medianLat,
    tps: basic.tps,
    tokensOut: basic.tokensOut,
    tests,
    capabilities: {
      vision: tests.find((t) => t.name === "vision")?.passed ?? false,
      json: tests.find((t) => t.name === "output-json")?.passed ?? false,
      code: tests.find((t) => t.name === "coding")?.passed ?? false,
      reasoning: tests.find((t) => t.name === "matematika")?.passed ?? false,
      longContext: tests.find((t) => t.name === "recall-konteks")?.passed ?? false,
      instruction: tests.find((t) => t.name === "patuh-instruksi")?.passed ?? false,
    },
    speed: {
      fast: medianLat != null && medianLat < 1500,
      median: medianLat,
      tps: basic.tps,
    },
  };
}
