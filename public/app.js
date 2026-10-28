/* ReBENCH - front-end */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const DASH = "-";

const state = {
  models: [],
  selected: new Set(),
  prompt: "",
  maxTokens: 256,
  runs: 1,
  summary: [],
  raw: [],
  probeResults: [],
  running: false,
  probing: false,
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtMs = (v) => (v == null ? DASH : v >= 60000 ? (v / 60000).toFixed(1) + " mnt" : (v / 1000).toFixed(2) + " s");
const fmtShort = (v) => (v == null ? DASH : v >= 1000 ? (v / 1000).toFixed(2) + "s" : v + "ms");

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = "toast-msg " + kind;
  el.textContent = msg;
  $("#toastStack").appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 320);
  }, 3900);
}

function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) {
    btn.dataset.label = btn.innerHTML;
    btn.classList.add("busy");
    btn.innerHTML = `<i class="bi bi-arrow-repeat rb-spin me-1"></i> ${esc(label || "Memproses...")}`;
  } else {
    btn.classList.remove("busy");
    if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }
}

function animateCount(el, to, suffix = "", duration = 700) {
  if (to == null || !isFinite(to)) return;
  const cur = el.textContent.replace(/[^\d]/g, "");
  const from = el.dataset.val != null ? Number(el.dataset.val) || 0 : Number(cur) || 0;
  el.dataset.val = to;
  // tab background: requestAnimationFrame tidak jalan, jadi timer dipercepat
  if (document.hidden) {
    el.textContent = to + suffix;
    return;
  }
  const t0 = performance.now();
  const tick = (now) => {
    const p = Math.min((now - t0) / duration, 1);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (to - from) * e) + suffix;
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ---------- navigasi ---------- */
const TITLES = {
  dash: "Dashboard",
  run: "Jalankan Test",
  results: "Hasil",
  probe: "Cek Kemampuan",
  history: "Riwayat",
  settings: "Provider & API Key",
};

function go(view) {
  $$(".view").forEach((v) => (v.hidden = v.id !== "v-" + view));
  $$(".sidebar-item").forEach((n) => n.classList.toggle("active", n.querySelector("[data-view]")?.dataset.view === view));
  const title = $(".view-title");
  title.textContent = TITLES[view] ?? "Dashboard";
  if (view === "history") loadHistory();
  if (view === "results") renderRaw();
  if (view === "settings") loadConfigUI();
  if (view === "dash") requestAnimationFrame(() => drawAll(false));
  closeSidebar();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

$$("[data-view]").forEach((a) =>
  a.addEventListener("click", (e) => {
    e.preventDefault();
    go(a.dataset.view);
  })
);

/* sidebar: buka/tutup ala Mazer (slide dari kiri, dengan backdrop) */
const sidebar = $("#sidebar");
const backdrop = document.createElement("div");
backdrop.className = "sidebar-backdrop";
backdrop.hidden = true;
backdrop.addEventListener("click", closeSidebar);
document.body.appendChild(backdrop);

function openSidebar() {
  sidebar.classList.add("active");
  backdrop.hidden = false;
}
function closeSidebar() {
  if (window.innerWidth < 1200) {
    sidebar.classList.remove("active");
    backdrop.hidden = true;
  }
}
$("#burgerBtn")?.addEventListener("click", (e) => {
  e.preventDefault();
  sidebar.classList.contains("active") ? closeSidebar() : openSidebar();
});
$("#sidebarClose")?.addEventListener("click", closeSidebar);

/* ---------- mode terang / gelap ---------- */
const THEME_KEY = "rebenth-theme";
function applyTheme(mode) {
  const dark = mode === "dark";
  document.documentElement.setAttribute("data-bs-theme", dark ? "dark" : "light");
  // animasi/transisi warna dari tema lama bisa tertahan; bersihkan agar nilai CSS baru langsung dipakai
  document.getAnimations().forEach((a) => {
    if (a.transitionProperty || (a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest(".card"))) {
      try { a.cancel(); } catch {}
    }
  });
  const btn = $("#themeToggle");
  if (btn) {
    btn.innerHTML = dark ? '<i class="bi bi-sun-fill"></i>' : '<i class="bi bi-moon-stars-fill"></i>';
    btn.title = dark ? "Mode terang (tekan D)" : "Mode gelap (tekan D)";
  }
  try { localStorage.setItem(THEME_KEY, dark ? "dark" : "light"); } catch {}
  // chart canvas tidak ikut CSS, jadi digambar ulang dengan palet tema
  if (document.readyState !== "loading" && typeof drawAll === "function") drawAll(false);
}
function currentTheme() {
  return document.documentElement.getAttribute("data-bs-theme") === "dark" ? "dark" : "light";
}
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch {}
  const prefers = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyTheme(saved || prefers);
}
$("#themeToggle")?.addEventListener("click", () => applyTheme(currentTheme() === "dark" ? "light" : "dark"));
initTheme();

// tombol ripple
document.addEventListener("pointerdown", (e) => {
  const btn = e.target.closest(".btn");
  if (!btn || btn.closest(".page-heading")) return; // tombol tema jangan menggeser layout chart
  const r = btn.getBoundingClientRect();
  btn.style.setProperty("--rx", ((e.clientX - r.left) / r.width) * 100 + "%");
  btn.style.setProperty("--ry", ((e.clientY - r.top) / r.height) * 100 + "%");
  btn.classList.add("rippling");
  setTimeout(() => btn.classList.remove("rippling"), 650);
});

// topbar blur saat scroll
window.addEventListener(
  "scroll",
  () => document.querySelector("#main .page-heading")?.classList.toggle("scrolled", window.scrollY > 12),
  { passive: true }
);

// shortcut 1-6
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select")) return;
  const map = { 1: "dash", 2: "run", 3: "results", 4: "probe", 5: "history", 6: "settings" };
  if (map[e.key]) go(map[e.key]);
  if (e.key === "d" || e.key === "D") {
    e.preventDefault();
    applyTheme(currentTheme() === "dark" ? "light" : "dark");
  }
});

/* ---------- API ---------- */
async function api(path, opts) {
  const res = await fetch(path, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "HTTP " + res.status);
  return json;
}

/* ---------- model & kartu ---------- */
async function loadModels() {
  try {
    const data = await api("/api/models");
    state.models = data.models ?? [];
    state.prompt = data.prompt ?? "";
    state.maxTokens = data.maxTokens ?? 256;
    state.runs = data.runs ?? 1;
    if (data.host) $("#endpointTxt").textContent = data.host;
    if (data.needsConfig) {
      renderModels();
      toast("Belum ada provider - buka menu Provider & API Key", "err");
      go("settings");
      return;
    }
    $("#promptInput").value = state.prompt;
    $("#maxTokensInput").value = state.maxTokens;
    $("#runsInput").value = state.runs;
    $("#modelCount").textContent = state.models.length;
    const fast = ["gpt-6-luna", "gemini-3.8-flash", "deepseek-v4.1-flash", "gpt-5.6-luna", "mimo-v2.6-flash"];
    state.selected = new Set(fast.filter((m) => state.models.includes(m)));
    renderModels();
  } catch (e) {
  $("#connTxt").innerHTML = '<i class="bi bi-circle-fill text-danger" style="font-size:.5rem"></i> ' + esc(e.message);
    toast("Gagal memuat model: " + e.message, "err");
  }
}

function renderModels() {
  const q = $("#modelFilter").value.trim().toLowerCase();
  const list = state.models.filter((m) => m.toLowerCase().includes(q));
  $("#modelList").innerHTML = list.length
    ? list
        .map(
          (m) => `<div class="col-6">
      <div class="model-chip ${state.selected.has(m) ? "on" : ""}" data-model="${esc(m)}" title="${esc(m)}">
        <span class="dot"></span><span>${esc(m)}</span>
      </div></div>`
        )
        .join("")
    : '<div class="col-12 small muted py-3">Tidak ada model yang cocok.</div>';
  $$(".model-chip").forEach((c) =>
    c.addEventListener("click", () => {
      const m = c.dataset.model;
      state.selected.has(m) ? state.selected.delete(m) : state.selected.add(m);
      renderModels();
    })
  );
}

function renderCards(s) {
  const ok = s.reduce((a, m) => a + m.success, 0);
  const total = s.reduce((a, m) => a + m.runs, 0);
  const best = s.find((m) => m.success > 0);
  const ttfts = s.filter((m) => m.medianTTFT).map((m) => m.medianTTFT);
  const cards = [
    { title: "Model diuji", num: s.length, suffix: "", sub: total + " request", icon: "bi bi-cpu", tone: "purple" },
    { title: "Success rate", num: total ? Math.round((ok / total) * 100) : null, suffix: "%", sub: ok + " berhasil", icon: "bi bi-check2-circle", tone: "green" },
    { title: "Model tercepat", text: best ? best.model : DASH, sub: best ? fmtMs(best.medianTotal) : "belum ada datanya", icon: "bi bi-speedometer", tone: "blue", small: true },
    { title: "TTFT terbaik", text: ttfts.length ? fmtMs(Math.min(...ttfts)) : DASH, sub: "token pertama", icon: "bi bi-stopwatch", tone: "red" },
    { title: "Throughput", text: best && best.avgTps ? best.avgTps + " tok/s" : DASH, sub: "generate tercepat", icon: "bi bi-lightning-charge", tone: "blue" },
  ];
  $("#cards").innerHTML = cards
    .map((c) => {
      const isNum = c.num != null;
      const valAttr = isNum ? `data-target="${c.num}" data-suffix="${c.suffix ?? ""}"` : "";
      const valTxt = isNum ? "0" + (c.suffix ?? "") : esc(c.text);
      return `<div class="col-12 col-md-6 col-xl">
      <div class="card shadow mb-4 stat-card"><div class="card-body">
        <div class="d-flex justify-content-between align-items-start gap-2">
          <div style="min-width:0">
            <div class="stat-label mb-2">${c.title}</div>
            <div class="stat-value ${isNum ? "count" : ""}" style="${c.small ? "font-size:1rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" : ""}" ${valAttr}>${isNum ? esc(c.num + (c.suffix ?? "")) : valTxt}</div>
            <div class="stat-sub mt-1">${esc(c.sub)}</div>
          </div>
          <span class="stats-icon ${c.tone}"><i class="${c.icon}"></i></span>
        </div>
      </div></div></div>`;
    })
    .join("");

  // angka sudah tampil final (fallback kalau animasi tidak jalan); animasi hanya menghaluskan
  $$(".count").forEach((el, i) => el.classList.add("pulse"));
  setTimeout(() => $$(".count").forEach((el) => el.classList.remove("pulse")), 800);
}

function renderBoard() {
  const s = state.summary;
  renderSkillSummary();
  if (!s.length) return;
  $("#boardBody").innerHTML = s
    .map((m, i) => {
      const color = m.successRate === 1 ? "bg-success" : m.successRate > 0.5 ? "bg-warning" : "bg-danger";
      const medal = ["bi bi-trophy-fill text-warning", "bi bi-award-fill muted", "bi bi-award-fill text-warning"][i] || "";
      const scored = probeScorecard(m);
      return `<tr>
        <td class="fw-bold">${medal ? `<i class="bi ${medal} me-1"></i>` : ""}${i + 1}</td>
        <td class="mono" style="font-size:.8rem">${esc(m.model)}</td>
        <td style="min-width:120px">
          <div class="progress" style="height:.6rem"><div class="progress-bar ${color}" style="width:${Math.round(m.successRate * 100)}%"></div></div>
          <span class="smaller muted">${m.success}/${m.runs}</span>
        </td>
        <td class="fw-bold">${fmtMs(m.medianTotal)}</td>
        <td>${fmtMs(m.medianTTFT)}</td>
        <td>${m.avgTps ?? DASH}</td>
        <td class="small">${fmtMs(m.minTotal)} / ${fmtMs(m.maxTotal)}</td>
        <td style="min-width:250px">${scored}</td>
        <td>${m.errors.length ? `<span class="badge bg-danger " title="${esc(m.errors.join(" | "))}">error</span>` : '<span class="badge bg-success ">ok</span>'}</td>
      </tr>`;
    })
    .join("");
  $("#lastRunTxt").textContent = "update " + new Date().toLocaleTimeString("id-ID");
}

function renderRaw() {
  const rows = state.raw;
  $("#rawBody").innerHTML = rows.length
    ? rows
        .map(
          (r) => `<tr>
      <td class="mono" style="font-size:.75rem">${esc(r.model)}</td>
      <td>${r.run ?? 1}</td>
      <td>${r.ok ? '<span class="badge bg-success ">OK</span>' : `<span class="badge bg-danger " title="${esc(r.error)}">FAIL</span>`}</td>
      <td>${fmtShort(r.ttft)}</td>
      <td>${fmtShort(r.total)}</td>
      <td>${r.tokensOut ?? DASH}</td>
      <td style="max-width:420px"><div class="mono-sm" style="white-space:pre-wrap;max-height:70px;overflow:auto">${esc(r.preview || r.error || "")}</div></td>
    </tr>`
        )
        .join("")
    : '<tr><td colspan="7" class="text-center muted py-4">Belum ada hasil.</td></tr>';
}

/* ---------- chart interaktif (canvas, tanpa dependency) ---------- */
const charts = { hover: null, progress: 0, anim: null };

/** Warna chart mengikuti tema (terang / gelap). */
function themeColors() {
  const dark = document.documentElement.getAttribute("data-bs-theme") === "dark";
    return dark
    ? { grid: "rgba(255,255,255,.07)", label: "#8a8a90", value: "#d4d4d4", empty: "#6b6b70", track: "#262626", purple: "#8b5cf6", purpleLight: "#c4b5fd" }
    : { grid: "#eaecf4", label: "#b7b9cc", value: "#5a5c69", empty: "#b7b9cc", track: "#d1d3e2" };
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  // view tersembunyi / tab background: jangan pernah ukur 0, nanti chart jadi 1x1
  if (rect.width < 2 || rect.height < 2) return null;
  canvas.width = Math.max(1, rect.width * dpr);
  canvas.height = Math.max(1, rect.height * dpr);
  canvas.style.width = rect.width + "px";
  canvas.style.height = rect.height + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: rect.height };
}

/** Jalankan animasi chart yang aman: batal kalau digambar ulang, dan selalu
 *  lanjut dari frame terakhir ke state final (tab background tidak punya rAF). */
function animateChart(render, duration) {
  const id = { active: true };
  charts.anim = id;
  if (!Array.isArray(charts.anims)) charts.anims = [];
  charts.anims.push(id);
  if (document.hidden) {
    render(1);
    charts.anims = charts.anims.filter((a) => a !== id);
    return;
  }
  const t0 = performance.now();
  const tick = (now) => {
    if (!id.active) return;
    const p = Math.min((now - t0) / duration, 1);
    render(easeOutCubic(p));
    if (p < 1) requestAnimationFrame(tick);
    else charts.anims = charts.anims.filter((a) => a !== id);
  };
  requestAnimationFrame(tick);
}

function cancelChartAnims() {
  (charts.anims || []).forEach((a) => (a.active = false));
  charts.anims = [];
}

function ensureTip(wrap) {
  let tip = wrap.querySelector(".chart-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "chart-tip";
    wrap.appendChild(tip);
  }
  return tip;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** Animasi bar dari 0 ke tinggi penuh; hover menampilkan tooltip. */
function drawBar(animate = true) {
  const canvas = $("#barChart");
  const size = setupCanvas(canvas);
  if (!size) return; // view tersembunyi: digambar saat view tampil lagi
  const { ctx, w, h } = size;
  const data = state.summary.slice(0, 10);
  const wrap = canvas.parentElement;
  const tip = ensureTip(wrap);
  const theme = themeColors();
  charts.barGeom = null;

  const render = (progress) => {
    ctx.clearRect(0, 0, w, h);
    if (!data.length) {
      ctx.fillStyle = theme.empty;
      ctx.font = "13px Nunito, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Belum ada data - jalankan test dulu", w / 2, h / 2);
      return;
    }
    const padL = 52, padR = 14, padT = 16, padB = 30;
    const max = Math.max(...data.map((d) => d.medianTotal ?? 0)) * 1.15 || 1;
    const plotH = h - padT - padB;
    const plotW = w - padL - padR;
    const slot = plotW / data.length;
    const barW = Math.min(slot * 0.58, 46);

    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = theme.value;
    ctx.font = "10px Nunito, sans-serif";
    ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const y = padT + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      const val = Math.round((max * (4 - i)) / 4);
      ctx.fillText(val >= 1000 ? (val / 1000).toFixed(1) + "s" : val + "ms", padL - 8, y + 3);
    }

    const geo = [];
    data.forEach((d, i) => {
      const x = padL + slot * i + (slot - barW) / 2;
      const v = (d.medianTotal ?? 0) * progress;
      const bh = Math.max((v / max) * plotH, 1);
      const hovered = charts.hover === i;
      const grad = ctx.createLinearGradient(0, padT + plotH - bh, 0, padT + plotH);
      if (d.successRate === 1) {
        if (theme.purple) {
          grad.addColorStop(0, hovered ? "#b79dff" : "#9069f9");
          grad.addColorStop(1, hovered ? "#7c4dff" : "#5b33c2");
        } else {
          grad.addColorStop(0, hovered ? "#5b8bff" : "#4e73df");
          grad.addColorStop(1, hovered ? "#3a63e8" : "#224abe");
        }
      } else {
        grad.addColorStop(0, hovered ? "#ffd25e" : "#f6c23e");
        grad.addColorStop(1, hovered ? "#f0b322" : "#dda20a");
      }
      ctx.fillStyle = grad;
      if (theme.purple) {
        ctx.save();
        ctx.shadowColor = hovered ? "rgba(139,92,246,.6)" : "rgba(139,92,246,.25)";
        ctx.shadowBlur = hovered ? 22 : 12;
        ctx.shadowOffsetY = 4;
      }
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, padT + plotH - bh, barW, bh, [5, 5, 0, 0]);
        ctx.fill();
      } else {
        ctx.fillRect(x, padT + plotH - bh, barW, bh);
      }
      if (theme.purple) ctx.restore();
      if (hovered) {
        if (!theme.purple) {
          ctx.save();
          ctx.shadowColor = "rgba(78,115,223,.45)";
          ctx.shadowBlur = 16;
          ctx.fill();
          ctx.restore();
        }
      }
      geo.push({ x, y: padT + plotH - bh, w: barW, h: bh, d });

      ctx.fillStyle = hovered ? (theme.purple || "#4e73df") : theme.value;
      ctx.font = hovered ? "700 10px Nunito, sans-serif" : "600 10px Nunito, sans-serif";
      const label = d.model.length > 15 ? d.model.slice(0, 14) + "..." : d.model;
      ctx.save();
      ctx.translate(x + barW / 2, h - padB + 13);
      ctx.rotate(-0.45);
      ctx.textAlign = "right";
      ctx.fillText(label, 0, 0);
      ctx.restore();
    });
    charts.barGeom = { geo, wrap, w };
  };

  // hentikan animasi grow lama supaya tidak tertinggal di skala kecil
  if (charts.growTimer) clearTimeout(charts.growTimer);
  canvas.style.transition = "none";
  canvas.style.transform = "none";
  // geometri langsung dipasang (tanpa menunggu frame) supaya hover selalu bekerja
  render(1);
  if (!animate) return;
  // efek grow: skala Y dari 0 ke 1 lewat CSS pada wrapper canvas
  canvas.style.transformOrigin = "0 100%";
  canvas.style.transform = "scaleY(0.02)";
  void canvas.offsetWidth;
  canvas.style.transition = "transform .8s cubic-bezier(.16,1,.3,1)";
  canvas.style.transform = "scaleY(1)";
  // pengaman: apa pun yang terjadi, pastikan canvas balik ke ukuran penuh
  charts.growTimer = setTimeout(() => {
    canvas.style.transition = "none";
    canvas.style.transform = "none";
  }, 900);
}

function attachBarHover() {
  const canvas = $("#barChart");
  if (canvas.dataset.bound) return;
  canvas.dataset.bound = "1";
  const tip = ensureTip(canvas.parentElement);

  const onMove = (e) => {
    const g = charts.barGeom;
    if (!g) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let hit = -1;
    g.geo.forEach((b, i) => {
      if (mx >= b.x - 6 && mx <= b.x + b.w + 6 && my >= b.y - 8 && my <= b.y + b.h + 8) hit = i;
    });
    if (hit !== charts.hover) {
      charts.hover = hit;
      drawBar(false);
    }
    if (hit === -1) {
      tip.classList.remove("show");
      return;
    }
    const d = g.geo[hit].d;
    tip.innerHTML = `<b>${esc(d.model)}</b><br>median ${fmtMs(d.medianTotal)} | TTFT ${fmtMs(d.medianTTFT)}<br>${d.success}/${d.runs} sukses${d.avgTps ? " | " + d.avgTps + " tok/s" : ""}`;
    tip.style.left = g.geo[hit].x + g.geo[hit].w / 2 + "px";
    tip.style.top = g.geo[hit].y + "px";
    tip.classList.add("show");
  };

  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("mouseleave", () => {
    charts.hover = null;
    tip.classList.remove("show");
    drawBar(false);
  });
}

/** Donut dengan sweep animation. */
function drawDonut(animate = true) {
  const canvas = $("#donutChart");
  const size = setupCanvas(canvas);
  if (!size) return;
  const { ctx, w, h } = size;
  const ok = state.summary.reduce((a, m) => a + m.success, 0);
  const fail = state.summary.reduce((a, m) => a + (m.runs - m.success), 0);
  const total = ok + fail;
  const theme = themeColors();
  $("#donutLegend").innerHTML = total
    ? `<span class="me-3 d-inline-flex align-items-center"><i class="bi bi-circle-fill me-1" style="color:${theme.purple || "#1cc88a"}"></i> Sukses <b class="ms-1 ">${ok}</b></span>
       <span class="d-inline-flex align-items-center"><i class="bi bi-circle-fill me-1" style="color:#e74a3b"></i> Gagal <b class="ms-1 ">${fail}</b></span>`
    : "";

  const render = (p) => {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 26;
    if (!total) {
      ctx.strokeStyle = theme.grid;
      ctx.lineWidth = 22;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = theme.track;
      ctx.font = "700 20px Nunito, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("-", cx, cy + 7);
      return;
    }
    let start = -Math.PI / 2;
    for (const [val, color] of [[ok, theme.purple || "#1cc88a"], [fail, "#e74a3b"]]) {
      if (!val) continue;
      const end = start + (val / total) * Math.PI * 2 * p;
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 22;
      ctx.lineCap = "butt";
      ctx.arc(cx, cy, r, start, end);
      ctx.stroke();
      start = end;
    }
    ctx.fillStyle = theme.value;
    ctx.font = "700 24px Nunito, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(Math.round((ok / total) * 100 * p) + "%", cx, cy + 5);
    ctx.font = "11px Nunito, sans-serif";
    ctx.fillStyle = theme.label;
    ctx.fillText("sukses", cx, cy + 22);
  };

  render(1);
  if (animate) animateChart(render, 850);
}

function drawAll(animate = true) {
  cancelChartAnims();
  drawBar(animate);
  drawDonut(animate);
}
window.addEventListener("resize", () => {
  clearTimeout(charts.rz);
  charts.rz = setTimeout(() => drawAll(false), 140);
});
// tab kembali terlihat: paksa gambar ulang supaya chart tidak tertinggal 0x0
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !$("#v-dash").hidden) drawAll(false);
});

/* ---------- jalankan benchmark (streaming) ---------- */
async function runBench(models) {
  if (state.running) return toast("Benchmark masih jalan", "err");
  if (!models.length) return toast("Pilih minimal 1 model", "err");
  state.running = true;
  state.raw = [];
  state.summary = [];
  renderRaw();
  $("#progressCard").hidden = false;
  $("#liveLog").innerHTML = "";
  $("#progressBar").style.width = "0%";
  const total = models.length * state.runs;
  $("#progressTxt").textContent = `0 / ${total}`;
  go("run");

  const done = [];
  const btn = $("#runBtn");
  setBusy(btn, true, "Mengukur...");
  try {
    const res = await fetch("/api/bench/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models, prompt: state.prompt, runs: state.runs, maxTokens: state.maxTokens }),
    });
    if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done: fin } = await reader.read();
      if (fin) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "result") {
          const r = msg.result;
          done.push(r);
          $("#progressBar").style.width = Math.round((done.length / total) * 100) + "%";
          $("#progressTxt").textContent = `${done.length} / ${total}`;
          const row = document.createElement("div");
          row.innerHTML = `${r.ok ? '<i class="bi bi-check-lg text-success"></i>' : '<i class="bi bi-x-lg text-danger"></i>'} <b>${esc(r.model)}</b> - ${fmtShort(r.total)}${
            r.ok ? ` | TTFT ${fmtShort(r.ttft)} | ${r.tokensOut ?? "?"} tok` : " | " + esc(r.error)
          }`;
          $("#liveLog").prepend(row);
        } else if (msg.type === "done") {
          state.summary = msg.summary ?? [];
        } else if (msg.type === "error") {
          throw new Error(msg.error);
        }
      }
    }
    state.raw = done;
    renderCards(state.summary);
    renderBoard();
    renderRaw();
    drawAll(true);
    attachBarHover();
    toast(`Selesai: ${state.summary.length} model diuji`, "ok");
    go("dash");
  } catch (e) {
    toast("Benchmark gagal: " + e.message, "err");
  } finally {
    state.running = false;
    setBusy(btn, false);
    $("#progressBar").classList.remove("progress-bar-animated");
  }
}

$("#runBtn").addEventListener("click", () => {
  state.prompt = $("#promptInput").value.trim() || state.prompt;
  state.maxTokens = Number($("#maxTokensInput").value) || 256;
  state.runs = Math.min(Math.max(Number($("#runsInput").value) || 1, 1), 5);
  runBench([...state.selected]);
});

$("#quickRun").addEventListener("click", () => {
  const picks = [...state.selected].slice(0, 5);
  runBench(picks.length ? picks : state.models.slice(0, 5));
});

$("#selectFast").addEventListener("click", () => {
  state.selected = new Set(
    ["gpt-6-luna", "gemini-3.8-flash", "deepseek-v4.1-flash", "gpt-5.6-luna", "mimo-v2.6-flash"].filter((m) => state.models.includes(m))
  );
  renderModels();
  toast("5 model tercepat dipilih", "ok");
});
$("#selAll").addEventListener("click", () => {
  state.selected = new Set(state.models);
  renderModels();
});
$("#selNone").addEventListener("click", () => {
  state.selected.clear();
  renderModels();
});
$("#modelFilter").addEventListener("input", renderModels);

/* ---------- export ---------- */
$("#copyCsv").addEventListener("click", async (e) => {
  const head = "model,run,ok,status,ttft_ms,total_ms,tokens_out,tps,error";
  const body = state.raw.map((r) =>
    [r.model, r.run ?? 1, r.ok, r.status, r.ttft, r.total, r.tokensOut ?? "", r.tps ?? "", (r.error ?? "").replace(/,/g, ";")].join(",")
  );
  try {
    await navigator.clipboard.writeText([head, ...body].join("\n"));
    toast("CSV dikopi ke clipboard", "ok");
  } catch {
    toast("Clipboard diblokir browser", "err");
  }
});

$("#dlJson").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ at: new Date().toISOString(), summary: state.summary, raw: state.raw }, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `rebenth-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("JSON diunduh", "ok");
});

/* ---------- riwayat ---------- */
async function loadHistory() {
  const el = $("#historyBody");
  try {
    const { history } = await api("/api/history");
    if (!history.length) {
      el.innerHTML = '<p class="muted mb-0">Belum ada riwayat.</p>';
      return;
    }
    el.innerHTML = history
      .map(
        (h) => `<div class="mb-3" style="border-left:.25rem solid #4e73df;padding-left:.75rem">
        <div class="small fw-bold ">${new Date(h.at).toLocaleString("id-ID")} <span class="badge bg-primary ">${esc(h.mode)}</span></div>
        <div class="mono-sm">${h.results.map((r) => `${esc(r.model)}: ${r.ok ? fmtShort(r.total) : "FAIL"}`).join(" | ")}</div>
      </div>`
      )
      .join("");
  } catch (e) {
    el.innerHTML = `<p class="text-danger mb-0">${esc(e.message)}</p>`;
  }
}

$("#clearHistory").addEventListener("click", async () => {
  await fetch("/api/history", { method: "DELETE" });
  loadHistory();
  toast("Riwayat dihapus", "ok");
});

/* ---------- skill per model: pintar, koding, vision, texting, reasoning, solusi ---------- */
const SKILLS = [
  { key: "smart", label: "Pintar", icon: "bi-mortarboard", tip: "skor tes kemampuan keseluruhan" },
  { key: "code", label: "Koding", icon: "bi-code-slash", tip: "menulis kode yang benar" },
  { key: "vision", label: "Vision", icon: "bi-image", tip: "membaca gambar" },
  { key: "texting", label: "Texting", icon: "bi-chat-dots", tip: "kecepatan & kualitas menulis" },
  { key: "reasoning", label: "Reasoning", icon: "bi-lightbulb", tip: "penalaran & hitungan" },
  { key: "solution", label: "Solusi", icon: "bi-stars", tip: "menyelesaikan masalah, bukan cuma jawab" },
];

/** Ambil hasil probe terakhir untuk model tertentu. */
function probeFor(model) {
  return (state.probeResults || []).find((r) => r.model === model) || null;
}

const testPassed = (probe, name) => !!probe?.tests?.find((t) => t.name === name)?.passed;

/**
 * Hitung 0-100 per skill dari data nyata:
 * probe (kalau sudah dijalankan) + hasil benchmark (latensi, throughput, sukses).
 */
function skillScores(model, summary) {
  const p = probeFor(model);
  const lat = summary?.medianTotal ?? null;
  const tps = summary?.avgTps ?? null;
  const ok = summary?.successRate ?? null;

  if (!p) return null;

  // dasar: skor probe keseluruhan
  const smart = p.score ?? 0;

  // koding & reasoning: hasil tes langsung
  const code = testPassed(p, "coding") ? (testPassed(p, "patuh-instruksi") ? 100 : 85) : 20;
  const reasoning = testPassed(p, "matematika") ? (testPassed(p, "recall-konteks") ? 100 : 80) : 15;

  // vision: lulus tes gambar = 100, gagal = 0 (tidak ada abu-abu)
  const vision = testPassed(p, "vision") ? 100 : 0;

  // texting: seberapa enak dipakai menulis -> kecepatan turun & output lancar
  const latScore = lat == null ? 50 : Math.max(0, Math.min(100, Math.round(100 - (lat - 800) / 22)));
  const tpsScore = tps == null ? 50 : Math.max(0, Math.min(100, Math.round((tps / 120) * 100)));
  const texting = Math.round(latScore * 0.7 + tpsScore * 0.3);

  // solusi: JSON + routing + konsistensi + sukses request
  const solParts = [
    testPassed(p, "output-json") ? 100 : 20,
    testPassed(p, "routing") ? 100 : 20,
    p.tests?.find((t) => t.name === "konsistensi")?.passed ? 100 : 30,
    ok == null ? 60 : Math.round(ok * 100),
  ];
  const solution = Math.round(solParts.reduce((a, b) => a + b, 0) / solParts.length);

  return { smart, code, vision, texting, reasoning, solution };
}

function skillTone(v) {
  if (v >= 80) return "s-high";
  if (v >= 60) return "s-mid";
  if (v >= 35) return "s-low";
  return "s-none";
}

/** Badge ringkas 6 skill untuk satu baris tabel. */
function probeScorecard(summary) {
  const probe = probeFor(summary.model);
  const scores = skillScores(summary.model, summary);
  if (!scores) {
    return `<button class="btn btn-sm btn-light skill-run" data-probe-model="${esc(summary.model)}" title="Belum diuji kemampuannya">
      <i class="bi bi-clipboard-pulse me-1 text-primary"></i> Cek skill
    </button>`;
  }
  return `<div class="skill-row">${SKILLS.map((s) => {
    const v = scores[s.key];
    const on = v >= 60;
    return `<span class="skill ${skillTone(v)}" title="${s.label}: ${v}/100 - ${s.tip}">
      <i class="bi ${s.icon}"></i><span>${v}</span>
    </span>`;
  }).join("")}
  <span class="skill-total ${probe.score >= 70 ? "s-high" : probe.score >= 40 ? "s-mid" : "s-low"}" title="skor tes keseluruhan">${probe.score}</span>
  </div>`;
}

function renderSkillSummary() {
  const el = $("#skillSummary");
  if (!el) return;
  const scored = (state.summary || []).map((m) => ({ m, s: skillScores(m.model, m) })).filter((x) => x.s);
  if (!scored.length) {
    el.innerHTML = `<p class="small muted mb-0">
      Skill muncul setelah <b>Cek Kemampuan</b> dijalankan. Klik tombol <b>Cek skill</b> di baris model, atau pilih beberapa model di menu itu.
    </p>`;
    return;
  }
  const best = (key) => {
    const sorted = [...scored].sort((a, b) => b.s[key] - a.s[key]);
    return sorted[0] ? { model: sorted[0].m.model, v: sorted[0].s[key] } : null;
  };
  el.innerHTML = `<div class="row">${SKILLS.map((sk) => {
    const b = best(sk.key);
    return `<div class="col-6 col-lg-2 mb-3">
      <div class="skill-card">
        <div class="skill-card-icon"><i class="bi ${sk.icon}"></i></div>
        <div class="skill-card-label">${sk.label}</div>
        <div class="skill-card-val ${b && b.v >= 60 ? "text-success" : "text-danger"}">${b ? b.v : "-"}</div>
        <div class="skill-card-model mono">${b ? esc(b.model) : "-"}</div>
      </div>
    </div>`;
  }).join("")}</div>`;
}

/* ---------- cek kemampuan (deep probe) ---------- */
const CAP_LABEL = {
  vision: { name: "Vision (gambar)", icon: "bi-image" },
  json: { name: "Output JSON", icon: "bi-braces" },
  code: { name: "Coding", icon: "bi-code-slash" },
  reasoning: { name: "Penalaran", icon: "bi-lightbulb" },
  longContext: { name: "Konteks panjang", icon: "bi-journal-text" },
  instruction: { name: "Patuh instruksi", icon: "bi-list-check" },
};

async function runProbe(models) {
  if (!models.length) return toast("Pilih model dulu di menu Jalankan Test", "err");
  if (state.probing) return toast("Masih ada uji berjalan", "err");
  state.probing = true;
  state.probeResults = [];
  $("#probeEmpty").hidden = true;
  $("#probeCards").innerHTML = models
    .map(
      (m) => `<div class="col-sm-3"><div class="card shadow mb-4"><div class="card-body py-3">
      <div class="smaller muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m)}</div>
      <div class="h5 mb-0 fw-bold "><i class="bi-arrow-repeat rb-spin text-primary"></i></div>
      <div class="small muted">menunggu</div>
    </div></div></div>`
    )
    .join("");
  $("#probeDetails").innerHTML = "";
  go("probe");
  setBusy($("#probeRun"), true, "Menguji " + models.length + " model...");

  const results = [];
  for (const m of models) {
    try {
      const r = await api("/api/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: m }),
      });
      results.push(r);
      renderProbeCards(results, models);
      toast(`${m}: skor ${r.score}/100`, "ok");
    } catch (e) {
      toast(`${m}: ${e.message}`, "err");
    }
  }
  state.probeResults = results;
  renderProbeCards(results, models);
  renderProbeDetails(results);
  renderBoard();
  setBusy($("#probeRun"), false);
  state.probing = false;
}

function renderProbeCards(results, models) {
  $("#probeCards").innerHTML = models
    .map((m) => {
      const r = results.find((x) => x.model === m);
      if (!r)
        return `<div class="col-sm-3"><div class="card shadow mb-4"><div class="card-body py-3">
        <div class="smaller muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m)}</div>
        <div class="h5 mb-0 fw-bold "><i class="bi-arrow-repeat rb-spin text-primary"></i></div>
        <div class="small muted">menunggu</div></div></div></div>`;
      const tone = r.score >= 70 ? "text-success" : r.score >= 40 ? "text-warning" : "text-danger";
      return `<div class="col-sm-3"><div class="card shadow mb-4"><div class="card-body py-3">
        <div class="smaller muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m)}</div>
        <div class="h3 mb-1 fw-bold ${tone} count" data-target="${r.score}">0</div>
        <div class="small muted">${r.passed}/${r.total} tes lulus</div>
        <div class="small muted">${fmtShort(r.medianLatency)} | ${r.speed.fast ? "Cepat" : "Sedang/lambat"}</div>
        <div class="mt-2">${Object.entries(r.capabilities)
          .map(([k, v]) => `<span class="badge ${v ? "bg-success" : "bg-danger"}  me-1" title="${CAP_LABEL[k]?.name ?? k}"><i class="bi ${CAP_LABEL[k]?.icon ?? "bi-circle-fill"}"></i></span>`)
          .join("")}</div>
      </div></div></div>`;
    })
    .join("");
  $$("#probeCards .count[data-target]").forEach((el) => animateCount(el, Number(el.dataset.target), "", 600));
}

function renderProbeDetails(results) {
  $("#probeDetails").innerHTML = results
    .map((r) => {
      const tone = r.score >= 70 ? "bg-success" : r.score >= 40 ? "bg-warning" : "bg-danger";
      return `<div class="col-lg-6"><div class="card shadow mb-4">
      <div class="card-header py-3 d-flex justify-content-between align-items-center">
        <h6 class="m-0 fw-bold text-primary mono" style="font-size:.85rem">${esc(r.model)}</h6>
        <span class="badge ${tone} ">${r.score}/100</span>
      </div>
      <div class="card-body">
        <div class="row mb-3">
          ${Object.entries(r.capabilities)
            .map(
              ([k, v]) => `<div class="col-6 mb-2 small">
              <i class="bi ${v ? "bi-check-circle-fill text-success" : "bi-x-circle-fill text-danger"} me-1"></i>${CAP_LABEL[k]?.name ?? k}</div>`
            )
            .join("")}
        </div>
        <table class="table table-sm mb-0">
          <thead><tr><th>Tes</th><th>Hasil</th><th>Latensi</th><th>Cuplikan</th></tr></thead>
          <tbody>${r.tests
            .map(
              (t) => `<tr>
            <td class="small fw-bold ">${esc(t.name)}</td>
            <td>${t.passed ? '<i class="bi bi-check-lg text-success"></i>' : '<i class="bi bi-x-lg text-danger"></i>'}</td>
            <td class="small">${fmtShort(t.latency)}</td>
            <td class="mono-sm" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.detail)}</td>
          </tr>`
            )
            .join("")}</tbody>
        </table>
      </div></div></div>`;
    })
    .join("");
}

$("#probeRun").addEventListener("click", () => runProbe([...state.selected]));

// tombol "Cek skill" di baris leaderboard
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-probe-model]");
  if (!btn) return;
  e.preventDefault();
  runProbe([btn.dataset.probeModel]);
});

/* ---------- settings ---------- */
async function loadConfigUI() {
  try {
    const c = await api("/api/config");
    $("#cfgBase").value = c.baseURL || "";
    $("#cfgPrompt").value = c.prompt || "";
    $("#cfgMaxTokens").value = c.maxTokens;
    $("#cfgRuns").value = c.runs;
    if (c.hasKey) {
      $("#cfgKey").placeholder = "tersimpan: " + c.keyMask + " (kosongkan bila tidak diubah)";
      $("#cfgKeyHint").innerHTML = `Key aktif: <span class="mono">${esc(c.keyMask)}</span> - isi kolom hanya bila ingin mengganti.`;
    }
  } catch (e) {
    toast("Gagal baca config: " + e.message, "err");
  }
}

$("#cfgSave").addEventListener("click", async () => {
  const msg = $("#cfgMsg");
  msg.innerHTML = '<i class="bi-arrow-repeat rb-spin"></i> menguji koneksi...';
  const payload = { baseURL: $("#cfgBase").value.trim() };
  const key = $("#cfgKey").value.trim();
  if (key) payload.apiKey = key;
  setBusy($("#cfgSave"), true, "Menguji...");
  try {
    const r = await api("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    msg.innerHTML = `<span class="text-success"><i class="bi-check-lg"></i> tersambung - ${r.models} model</span>`;
    $("#cfgKey").value = "";
    toast("Provider diperbarui", "ok");
    await loadConfigUI();
    await loadModels();
  } catch (e) {
    msg.innerHTML = `<span class="text-danger"><i class="bi-x-lg"></i> ${esc(e.message)}</span>`;
  } finally {
    setBusy($("#cfgSave"), false);
  }
});

$("#cfgSaveBench").addEventListener("click", async () => {
  try {
    await api("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: $("#cfgPrompt").value.trim(),
        maxTokens: Number($("#cfgMaxTokens").value),
        runs: Number($("#cfgRuns").value),
      }),
    });
    state.prompt = $("#cfgPrompt").value.trim();
    state.maxTokens = Number($("#cfgMaxTokens").value);
    state.runs = Number($("#cfgRuns").value);
    $("#promptInput").value = state.prompt;
    $("#maxTokensInput").value = state.maxTokens;
    $("#runsInput").value = state.runs;
    toast("Default benchmark disimpan", "ok");
  } catch (e) {
    toast(e.message, "err");
  }
});

$("#cfgReload").addEventListener("click", async () => {
  setBusy($("#cfgReload"), true, "Memuat...");
  await loadConfigUI();
  await loadModels();
  setBusy($("#cfgReload"), false);
  toast("Data model dimuat ulang", "ok");
});

/* ---------- boot ---------- */
(async function init() {
  const alive = await fetch("/api/models").then((r) => r.ok || r.status === 502).catch(() => false);
  if (!alive) $("#connTxt").innerHTML = '<i class="bi bi-circle-fill text-danger" style="font-size:.5rem"></i> Server mati';
  $("#footEndpoint").textContent = location.host;
  await loadModels();
  renderCards([]);
  drawAll(true);
  attachBarHover();
  loadConfigUI();
})();

