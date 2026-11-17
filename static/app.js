/* PC-TV frontend */
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  channels: [], sources: [], groups: [], curr: null, group: "Semua", fav: new Set(),
  hls: null, nativeHLS: null, loading: true, loadError: "",
};

/* ---------- helpers ---------- */
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._id);
  toast._id = setTimeout(() => t.classList.add("hidden"), ms);
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { error: text.slice(0, 200) || `HTTP ${r.status}` }; }
}

/* ---------- load & render ---------- */
async function load() {
  state.loading = true;
  renderList();
  renderSources();
  try {
    const st = await api("/api/state");
    if (st.error) throw new Error(st.error);
    state.channels = st.channels || [];
    state.sources = st.sources || [];
    state.updated = st.updated || 0;
    state.groups = ["Semua", ...new Set(state.channels.map(c => c.group).filter(Boolean))];
    state.loadError = "";
  } catch (e) {
    state.loadError = "Tidak bisa memuat daftar channel: " + e.message;
  }
  state.loading = false;
  renderGroups();
  renderSources();
  renderList();
}

function groupFor(c) { return state.group === "Semua" || c.group === state.group; }

function renderGroups() {
  const el = $("#groupList");
  el.innerHTML = state.groups.map(g => {
    const n = g === "Semua" ? state.channels.length : state.channels.filter(c => c.group === g).length;
    return `<button class="g ${g === state.group ? "active" : ""}" data-g="${esc(g)}" type="button">
      <span class="gname">${esc(g)}</span><span>${n}</span></button>`;
  }).join("");
}

function renderSources() {
  const el = $("#sourceList");
  if (!state.sources.length) { el.innerHTML = `<div class="src">Belum ada sumber</div>`; return; }
  el.innerHTML = state.sources.map(s => {
    const off = s.enabled === false;
    const err = s.last_error ? ` <span class="serr" title="${esc(s.last_error)}">!</span>` : "";
    return `<div class="src ${off ? "off" : ""}">
      <span class="sname" title="${esc(s.name)}">${esc(s.name)}${err}</span>
      <button class="sswitch" type="button" data-id="${esc(s.id)}"
        aria-pressed="${off ? "false" : "true"}">${off ? "off" : "on"}</button>
    </div>`;
  }).join("");
}

function visibleChannels() {
  const q = ($("#q").value || "").toLowerCase().trim();
  return state.channels.filter(c => groupFor(c) && (!q || c.name.toLowerCase().includes(q)));
}

function renderList() {
  const el = $("#grid");
  const count = $("#listCount");
  const hint = $("#listHint");

  if (state.loading) {
    count.textContent = "memuat…";
    hint.textContent = "";
    el.innerHTML = `<div class="empty">Memuat daftar channel.</div>`;
    return;
  }
  if (state.loadError) {
    count.textContent = "gagal";
    hint.textContent = "";
    el.innerHTML = `<div class="empty">${esc(state.loadError)}</div>`;
    return;
  }

  const list = visibleChannels();
  count.textContent = `${list.length} dari ${state.channels.length} channel`;
  hint.textContent = "";

  if (!list.length) {
    el.innerHTML = `<div class="empty">${state.channels.length
      ? "Tidak ada channel yang cocok. Coba kata kunci atau grup lain."
      : "Belum ada channel. Klik Tambah sumber untuk memasukkan playlist."}</div>`;
    return;
  }

  el.innerHTML = list.map((c, i) => `
    <button class="chrow ${state.curr && state.curr.cid === c.cid ? "playing" : ""}"
      type="button" data-cid="${esc(c.cid)}" aria-current="${state.curr && state.curr.cid === c.cid}">
      <span class="idx">${i + 1}</span>
      <span class="cname">${esc(c.name)}</span>
      <span class="cgroup">${esc(c.group)}</span>
    </button>`).join("");
}

$("#q").addEventListener("input", renderList);

$("#grid").addEventListener("click", e => {
  const row = e.target.closest(".chrow");
  if (!row) return;
  const c = state.channels.find(x => x.cid === row.dataset.cid);
  if (c) play(c);
});

$("#groupList").addEventListener("click", e => {
  const b = e.target.closest(".g");
  if (!b) return;
  state.group = b.dataset.g;
  renderGroups();
  renderList();
});

$("#sourceList").addEventListener("click", async e => {
  const b = e.target.closest(".sswitch");
  if (!b) return;
  b.disabled = true;
  const r = await api("/api/sources/toggle", { method: "POST", body: JSON.stringify({ id: b.dataset.id }) });
  b.disabled = false;
  if (r.error) { toast("Gagal: " + r.error); return; }
  load();
});

/* ---------- player ---------- */
function proxyUrl(u, ref) {
  if (u.startsWith("/vidio?") || u.startsWith("/detik-sec?") || u.startsWith("/stream?")) return u;
  let p = "/stream?u=" + encodeURIComponent(u);
  if (ref) p += "&ref=" + encodeURIComponent(ref);
  return p;
}

function setErr(msg) {
  const el = $("#err");
  if (!msg) { el.hidden = true; el.textContent = ""; return; }
  el.hidden = false;
  el.textContent = msg;
  const official = {
    "Trans TV": "https://www.transtv.co.id/live/",
    "Trans7": "https://www.transtv.co.id/live/trans7",
    "CNN Indonesia": "https://www.transtv.co.id/live/cnn",
    "CNBC Indonesia": "https://www.transtv.co.id/live/cnbc",
    "Insert Live": "https://www.transtv.co.id/live/insertlive-tv",
  }[state.curr?.name];
  if (official) {
    const a = document.createElement("a");
    a.href = official;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = " Buka player resmi";
    a.style.color = "var(--acc)";
    el.appendChild(a);
  }
}

function setStat(txt) { $("#nowStat").textContent = txt || ""; }

/* Jump to the live edge. hls.js exposes seekToLiveEdge(), but its accuracy
   depends on the current playlist; retry once on the next level update. */
function seekLive(hls, v) {
  try { hls.seekToLiveEdge(); } catch (e) {}
  setTimeout(() => {
    try {
      const d = hls.levels?.[hls.currentLevel]?.details;
      if (d && d.live && typeof d.edge === "number") {
        v.currentTime = d.edge - Math.min(4, (d.targetduration || 4));
      }
    } catch (e) {}
  }, 400);
}

function teardown() {
  clearInterval(play._sync);
  clearInterval(play._stat);
  if (state.hls) { try { state.hls.destroy(); } catch (e) {} state.hls = null; }
  if (state.nativeHLS) { try { state.nativeHLS.stopLoad?.(); } catch (e) {} state.nativeHLS = null; }
  const v = $("#tv");
  v.classList.remove("on");
  $("#stage").classList.remove("playing");
  v.pause();
  v.removeAttribute("src");
  v.load();
  $("#nowDot").hidden = true;
  setStat("");
}

function play(ch) {
  state.curr = ch;
  setErr("");
  teardown();
  const v = $("#tv");
  const proxy = proxyUrl(ch.url, ch.page || null);

  $("#nowName").textContent = ch.name;
  $("#nowProg").textContent = ch.group || "";
  $("#nowDot").hidden = false;
  renderList();

  const native = v.canPlayType("application/vnd.apple.mpegurl") !== "";

  function tryHlsJs() {
    if (!window.Hls) return false;
    const H = window.Hls;
    if (!H.isSupported()) {
      setErr("Browser ini tidak mendukung HLS. Pakai Chrome/Edge/Firefox terbaru.");
      return false;
    }
    state.hls = new H({
      lowLatencyMode: false,          // these sources publish plain 4-10s segments; LL mode only adds stalls
      backBufferLength: 90,
      liveSyncDurationCount: 3,       // hold 3 segments behind the published live edge
      maxBufferLength: 30,
      // TVRI/Transmedia publish a 1080p top variant at 2.5 Mbps. Fetching it for
      // a half-width player wastes the whole link and starves the decoder, so
      // never fetch above the size actually being displayed.
      capLevelToPlayerSize: true,
      capLevelOnFPSDrop: true,
      manifestLoadingTimeOut: 20000,
      manifestLoadingMaxRetry: 3,
      manifestLoadingRetryDelay: 1000,
      levelLoadingTimeOut: 15000,
      levelLoadingMaxRetry: 6,
      levelLoadingRetryDelay: 1000,
      fragLoadingTimeOut: 25000,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 800,
      abrEwmaDefaultEstimate: 1_000_000, // start low so ABR does not open on a bitrate it cannot sustain
    });
    state.hls.on(H.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      const code = data.response?.code;
      switch (data.type) {
        case H.ErrorTypes.NETWORK_ERROR:
          // A segment that has already fallen off the live edge 404s; re-sync
          // instead of killing the player.
          if (data.details === H.ErrorDetails.FRAG_LOAD_ERROR && state.curr) {
            try { seekLive(state.hls, v); } catch {}
            return;
          }
          setErr(`Gagal ambil stream (HTTP ${code || "?"}). URL mungkin mati atau geoblock. Coba channel lain atau isi Referer.`);
          break;
        case H.ErrorTypes.MEDIA_ERROR:
          try { state.hls.recoverMediaError(); } catch {}
          setErr("Stream macet atau formatnya tidak cocok. Muat ulang atau ganti channel.");
          break;
        default:
          setErr("Stream error: " + (data.details || "unknown"));
      }
    });
    state.hls.loadSource(proxy);
    state.hls.attachMedia(v);
    state.hls.on(H.Events.MANIFEST_PARSED, () => {
      v.classList.add("on");
      $("#stage").classList.add("playing");
      v.play().catch(() => {});
    });

    // A backgrounded tab, a long stall, or a paused-then-resumed player ends up
    // minutes behind the live edge. Cap the drift instead of letting it grow:
    // once we are more than 15s past the target latency, jump forward.
    clearInterval(play._sync);
    play._sync = setInterval(() => {
      const h = state.hls;
      if (!h || !state.curr || v.paused) return;
      const live = h.levels[h.currentLevel]?.details?.live;
      if (typeof h.latency !== "number" || !live) return;
      const target = typeof h.targetLatency === "number" ? h.targetLatency : 12;
      if (h.latency > target + 15) seekLive(h, v);
    }, 10000);

    clearInterval(play._stat);
    play._stat = setInterval(() => {
      if (!state.hls || v.paused) return;
      const h = state.hls;
      const lv = h.levels[h.currentLevel];
      const res = lv && lv.height ? `${lv.height}p` : "";
      const lat = typeof h.latency === "number" ? `${h.latency.toFixed(1)}s delay` : "";
      setStat([res, lat].filter(Boolean).join(" · "));
    }, 1000);
    return true;
  }

  const looksM3U8 = /\.m3u8(\?|$)/i.test(ch.url);
  const looksMP4 = /\.mp4(\?|$)/i.test(ch.url);

  function showStage() {
    v.classList.add("on");
    $("#stage").classList.add("playing");
    v.play().catch(() => {});
  }

  if (looksM3U8 || !looksMP4) {
    const ok = tryHlsJs();
    if (!ok && native) { v.src = proxy; showStage(); }
  } else {
    v.src = proxy;
    showStage();
  }
}

window.__pctv = state;

$("#tv").addEventListener("error", () => {
  if (!state.curr) return;
  const code = $("#tv").error?.code;
  setErr(code === 4 ? "Stream tidak ditemukan (404) atau formatnya tidak didukung."
    : code === 2 ? "Gangguan jaringan saat memuat stream."
    : "Gagal memutar stream (kode " + (code ?? "?") + ").");
});

/* ---------- modal ---------- */
const overlay = $("#overlay");
let lastFocus = null;
function openModal() {
  lastFocus = document.activeElement;
  overlay.classList.remove("hidden");
  $("#m3uText").focus();
}
function closeModal() {
  overlay.classList.add("hidden");
  if (lastFocus) lastFocus.focus();
}
$("#btnAdd").addEventListener("click", openModal);
$("#mClose").addEventListener("click", closeModal);
overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !overlay.classList.contains("hidden")) closeModal();
});

$$(".tab").forEach(t => t.addEventListener("click", () => {
  $$(".tab").forEach(x => {
    const on = x === t;
    x.classList.toggle("active", on);
    x.setAttribute("aria-selected", String(on));
  });
  $$(".tabbody").forEach(b => b.classList.toggle("hidden", b.dataset.t !== t.dataset.t));
}));

/* ---------- presets: only endpoints verified against this machine ---- */
const HOT = [
  { n: "RCTI", u: "https://allcutv.rctiplus.id/rcti-sdi.m3u8", r: "https://www.rctiplus.com/", m: "MNC 720p" },
  { n: "MNC TV", u: "https://allcutv.rctiplus.id/mnctv-sdi.m3u8", r: "https://www.rctiplus.com/", m: "MNC 720p" },
  { n: "GTV", u: "https://allcutv.rctiplus.id/gtv2023.m3u8", r: "https://www.rctiplus.com/", m: "MNC" },
  { n: "iNews", u: "https://allcutv.rctiplus.id/inews2023.m3u8", r: "https://www.rctiplus.com/", m: "MNC" },
  { n: "TVRI Nasional", u: "https://ott-balancer.tvri.go.id/live/eds/Nasional/hls/Nasional.m3u8", r: "", m: "TVRI" },
  { n: "Metro TV", u: "https://edge.medcom.id/live-edge/smil:metro.smil/playlist.m3u8", r: "", m: "Medcom" },
];
function renderHot() {
  $("#hotList").innerHTML = HOT.map((h, i) =>
    `<button class="hotbtn" type="button" data-i="${i}">${esc(h.n)}<span class="hmeta">${esc(h.m)}</span></button>`).join("");
}
$("#hotList").addEventListener("click", e => {
  const b = e.target.closest(".hotbtn");
  if (!b) return;
  const h = HOT[+b.dataset.i];
  b.disabled = true;
  api("/api/sources/addone", { method: "POST", body: JSON.stringify({ url: h.u, name: h.n, page: h.r }) })
    .then(r => {
      b.disabled = false;
      toast(r.ok ? `Ditambahkan: ${h.n}` : "Gagal: " + (r.error || "?"), 2200);
      if (r.ok) { closeModal(); load(); }
    });
});
renderHot();

/* ---------- submit ---------- */
$("#m3uSubmit").addEventListener("click", async () => {
  const text = $("#m3uText").value.trim();
  const name = $("#m3uName").value.trim();
  if (!text) return toast("Tempel isi playlist dulu.", 2200);
  const body = /^https?:\/\//i.test(text) && !text.includes("\n")
    ? { url: text, name }
    : { text, name };
  const r = await api(body.url ? "/api/sources" : "/api/upload", { method: "POST", body: JSON.stringify(body) });
  toast(r.ok ? `OK: ${r.channels ?? 0} channel.` : "Gagal: " + (r.error || "?"), 2600);
  if (r.ok) { closeModal(); load(); }
});

$("#urlSubmit").addEventListener("click", async () => {
  const url = $("#urlInput").value.trim();
  const name = $("#urlName").value.trim();
  const page = $("#urlPage").value.trim();
  if (!/^https?:\/\//i.test(url)) return toast("URL harus diawali http:// atau https://", 2400);
  const r = await api("/api/sources/addone", { method: "POST", body: JSON.stringify({ url, name, page }) });
  toast(r.ok ? `OK: ${r.channels ?? 0} channel.` : "Gagal: " + (r.error || "?"), 2600);
  if (r.ok) { closeModal(); load(); }
});

$("#btnRefresh").addEventListener("click", async () => {
  const b = $("#btnRefresh");
  b.disabled = true;
  b.textContent = "Memuat…";
  try {
    const r = await api("/api/refresh", { method: "POST" });
    toast(r.error ? "Gagal: " + r.error : `Dimuat ${r.channels ?? 0} channel.`, 2200);
    await load();
  } catch (e) {
    toast("Gagal refresh: " + e.message, 2400);
  }
  b.disabled = false;
  b.textContent = "Muat ulang";
});

/* ---------- boot ---------- */
load();
