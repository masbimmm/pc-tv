// PC-TV server (Node.js port dari server.py)
// Fitur sama: proxy HLS + Referer, resolver Vidio (auth di data/vidio-auth.json),
// resolver Transmedia (wowza token), playlist M3U, LAN bind 0.0.0.0.
// Tanpa dependency npm: murni modul bawaan Node.

"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { URL, URLSearchParams } = require("url");

const APP_DIR = __dirname;
const STATIC_DIR = path.join(APP_DIR, "..", "static");
const DATA_DIR = path.join(APP_DIR, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "playlists.json");
const PRESET_FILE = path.join(APP_DIR, "..", "indonesia.m3u");

const SERVER_VERSION = "2.0.0-node";
const HTTP_TIMEOUT = 12_000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// ---- Transmedia: wowza token (algoritma detikVideo.core.js stMain) ----
const DETIK_SEC = {
  transtv: { prefix: "transtv-sec/smil:", postfix: "transtv.smil", secret: "807aad1578ee7d9a" },
  trans7: { prefix: "trans7-sec/smil:", postfix: "trans7.smil", secret: "258eed02421df5e2" },
};
const DETIK_CSHX = "3bcdb206";
const DETIK_REFERER = "https://20.detik.com/";

function detikSecUrl(ch, minutes = 120) {
  const cfg = DETIK_SEC[ch];
  const starttime = "0";
  const endtime = String(Date.now() + minutes * 60_000);
  const raw = `${cfg.prefix}${cfg.postfix}?${cfg.secret}&wowzatokenendtime=${endtime}&wowzatokenstarttime=${starttime}`;
  const token = crypto
    .createHash("sha256")
    .update(raw)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return (
    `https://video.detik.com/${cfg.prefix}${cfg.postfix}/playlist.m3u8` +
    `?wowzatokenstarttime=${starttime}&wowzatokenendtime=${endtime}&wowzatokenhash=${encodeURIComponent(token)}`
  );
}

// ---- state ----
let DATA = { sources: [], channels: [], updated: 0 };

function log(...args) {
  console.log(`[${new Date().toLocaleTimeString("id-ID")}]`, ...args);
}

function loadData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    try {
      DATA = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      return;
    } catch (e) {
      log("playlists.json rusak, mulai kosong:", e.message);
    }
  }
  DATA = { sources: [], channels: [], updated: 0 };
}

function saveData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(DATA, null, 1), "utf8");
  fs.renameSync(tmp, DATA_FILE);
}

// ---- fetch upstream ----
// Reusing sockets cuts first-byte latency on repeated segment fetches from
// ~300ms (new TLS handshake) to ~15ms; live streams stall without it.
const AGENTS = new Map();
function agentFor(u) {
  const proto = u.protocol === "https:" ? "https" : "http";
  const mod = proto === "https" ? https : http;
  if (!AGENTS.has(mod)) {
    AGENTS.set(
      mod,
      new mod.Agent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 24, maxFreeSockets: 8 })
    );
  }
  return AGENTS.get(mod);
}

function upstreamHeaders({ referer, extra } = {}) {
  return {
    "User-Agent": UA,
    Accept: "*/*",
    "Accept-Language": "id,en;q=0.8",
    "Accept-Encoding": "identity",
    ...(referer ? { Referer: referer } : {}),
    ...(extra || {}),
  };
}

// Resolves as soon as response headers arrive, leaving the body streaming.
function openUpstream(url, { referer, extra, timeout = HTTP_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: upstreamHeaders({ referer, extra }),
        timeout,
        agent: agentFor(u),
      },
      resolve
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

function readAll(stream, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    stream.on("data", (c) => {
      n += c.length;
      if (n > limit) stream.destroy(new Error("upstream body too large"));
      else chunks.push(c);
    });
    stream.on("end", () => {
      let body = Buffer.concat(chunks);
      const enc = String(stream.headers["content-encoding"] || "").split(",").map((s) => s.trim().toLowerCase());
      try {
        if (enc.includes("gzip") && body[0] === 0x1f && body[1] === 0x8b) body = zlib.gunzipSync(body);
        else if (enc.includes("deflate")) body = zlib.inflateSync(body);
      } catch { /* already plain */ }
      resolve(body);
    });
    stream.on("error", reject);
  });
}

function fetchUrl(url, opts = {}) {
  return openUpstream(url, opts).then(async (res) => ({
    status: res.statusCode,
    headers: res.headers,
    body: await readAll(res),
  }));
}

// ---- M3U parser ----
const ATTR_RE = /([\w-]+)="([^"]*)"/g;

function parseM3U(text) {
  const channels = [];
  let pending = null;
  let referrer = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^\ufeff/, "");
    if (!line) continue;
    if (/^#EXTINF/i.test(line)) {
      const attrs = {};
      let m;
      while ((m = ATTR_RE.exec(line))) attrs[m[1]] = m[2];
      const title = line.includes(",") ? line.slice(line.lastIndexOf(",") + 1).trim() : "";
      pending = {
        name: title || attrs["tvg-name"] || "Tanpa Nama",
        group: (attrs["group-title"] || "").trim(),
        logo: (attrs["tvg-logo"] || "").trim(),
        tvg_id: (attrs["tvg-id"] || "").trim(),
        tvg_name: (attrs["tvg-name"] || "").trim(),
      };
      referrer = "";
      continue;
    }
    if (line.startsWith("#")) {
      const rm = line.match(/^#EXTVLCOPT:http-referrer=(.+)/i);
      if (rm) referrer = rm[1].trim();
      continue;
    }
    const url = line.split("|", 1)[0].trim();
    if (!url) continue;
    if (/^\/(vidio|detik-sec|stream)\?/.test(url)) {
      // internal route
      const meta = pending || { name: url, group: "", logo: "", tvg_id: "", tvg_name: "" };
      channels.push({
        id: normId(meta.name),
        name: meta.name,
        group: meta.group || "Lainnya",
        logo: meta.logo,
        tvg_id: meta.tvg_id,
        tvg_name: meta.tvg_name,
        url,
        page: referrer,
      });
      pending = null;
      referrer = "";
      continue;
    }
    if (!/^https?:\/\//i.test(url)) continue;
    const meta = pending || { name: url, group: "", logo: "", tvg_id: "", tvg_name: "" };
    channels.push({
      id: normId(meta.name),
      name: meta.name,
      group: meta.group || "Lainnya",
      logo: meta.logo,
      tvg_id: meta.tvg_id,
      tvg_name: meta.tvg_name,
      url,
      page: referrer,
    });
    pending = null;
    referrer = "";
  }
  return channels;
}

const normId = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

// ---- sources -> channels ----
function loadSource(src) {
  if (src.text) return parseM3U(src.text);
  if (src.kind === "single") return [makeSingle(src)];
  return null; // remote playlist: di-fetch async di rebuildChannels
}

function makeSingle(src) {
  return {
    id: normId(src.name || "Stream"),
    name: src.name || "Stream",
    group: "Manual",
    logo: "",
    tvg_id: "",
    tvg_name: "",
    url: src.url,
    page: src.page || "",
  };
}

async function rebuildChannels() {
  const channels = [];
  const seen = new Set();
  for (const src of DATA.sources || []) {
    if (src.enabled === false) continue;
    let items;
    if (src.text) {
      items = parseM3U(src.text);
    } else if (src.kind === "single") {
      items = [makeSingle(src)];
    } else if (src.url) {
      try {
        const ok = /\.m3u8?(\?|$)/i.test(src.url) || /\.txt(\?|$)/i.test(src.url) || /m3u/i.test(src.url);
        if (!ok) {
          items = [makeSingle(src)];
        } else {
          const r = await fetchUrl(src.url, { timeout: 20_000 });
          items = parseM3U(r.body.toString("utf8"));
        }
      } catch (e) {
        src.last_error = String(e).slice(0, 300);
        log(`sumber gagal: ${src.name} -> ${e}`);
        continue;
      }
    } else continue;
    src.last_error = "";
    src.count = items.length;
    src.last_load = Math.floor(Date.now() / 1000);
    for (const ch of items) {
      ch.source = src.id;
      let cid = `${src.id}::${ch.id || ch.url}`.replace(/[^\w:.-]+/g, "_");
      let n = 1;
      while (seen.has(cid)) {
        n += 1;
        cid = `${src.id}::${ch.id || ch.url}`.replace(/[^\w:.-]+/g, "_") + `_${n}`;
      }
      seen.add(cid);
      ch.cid = cid;
      channels.push(ch);
    }
  }
  DATA.channels = channels;
  DATA.updated = Math.floor(Date.now() / 1000);
  saveData();
  return channels.length;
}

// ---- helpers HTTP ----
function send(res, code, body, ctype = "application/json; charset=utf-8", extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(code, {
    "Content-Type": ctype,
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    ...extra,
  });
  res.end(buf);
}
const sendJson = (res, obj, code = 200) => send(res, code, JSON.stringify(obj));

function readBody(req) {
  return new Promise((resolve) => {
    let n = 0;
    const chunks = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > 2_000_000) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function absProxy(uri, base, referer) {
  // data: URIs (shaka-packager EXT-X-CONTENT-STEERING) cannot be fetched, and
  // wrapping one would make the proxy fetch itself in a loop.
  if (/^data:/i.test(uri)) return uri;
  const absolute = new URL(uri, base).toString();
  const qs = new URLSearchParams({ u: absolute });
  if (referer) qs.set("ref", referer);
  return "/stream?" + qs.toString();
}

// Segments stream straight through to the browser instead of buffering whole
// upstream bodies; hls.js starts decoding at first byte instead of last.
function proxyBody(req, res, upstreamRes) {
  res.writeHead(upstreamRes.statusCode, {
    "Content-Type": String(upstreamRes.headers["content-type"] || "video/mp2t"),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    ...(upstreamRes.headers["content-length"] ? { "Content-Length": upstreamRes.headers["content-length"] } : {}),
  });
  upstreamRes.pipe(res);
  upstreamRes.on("error", () => res.destroy());
  res.on("close", () => upstreamRes.destroy());
}

// ---- routes ----
async function vidioStream(req, res, q) {
  const id = q.get("id") || "";
  if (!id) return send(res, 400, "missing id", "text/plain");
  let auth = {};
  const authFile = path.join(DATA_DIR, "vidio-auth.json");
  if (fs.existsSync(authFile)) {
    try {
      auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
    } catch {}
  }
  const headers = {
    ...auth,
    "User-Agent": auth["User-Agent"] || UA,
    Referer: "https://www.vidio.com/",
    "Accept-Language": "id",
    "X-Secure-Level": "2",
    "X-API-Platform": "web-desktop",
  };
  let r;
  try {
    r = await fetchUrl(`https://api.vidio.com/livestreamings/${id}/stream?initialize=true`, { extra: headers, timeout: 20_000 });
  } catch (e) {
    return send(res, 502, `vidio error: ${e}`, "text/plain");
  }
  if (r.status !== 200) return send(res, r.status, `vidio api ${r.status}`, "text/plain");
  let attrs;
  try {
    attrs = JSON.parse(r.body.toString("utf8")).data.attributes;
  } catch {
    return send(res, 502, "vidio response parse failed", "text/plain");
  }
  if (!attrs.hls) return send(res, 404, "channel has no HLS stream", "text/plain");
  if (attrs.is_drm || attrs.is_preview) return send(res, 403, "DRM or preview requires the official player", "text/plain");
  const stream = absProxy(attrs.hls, attrs.hls, "https://www.vidio.com/");
  const manifest = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\n${stream}\n`;
  send(res, 200, manifest, "application/vnd.apple.mpegurl");
}

async function detikSecStream(req, res, q) {
  const ch = q.get("ch") || "";
  if (!DETIK_SEC[ch]) return send(res, 400, "unknown channel, ?ch=transtv|trans7", "text/plain");
  const target = detikSecUrl(ch, 120);
  const stream = absProxy(target, target, DETIK_REFERER);
  const manifest = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=744100,RESOLUTION=1280x720\n${stream}\n`;
  send(res, 200, manifest, "application/vnd.apple.mpegurl");
}

// MNC renames its allcutv endpoints now and then (gtv2023 -> gtv-sdi). When a
// playlist 404s, probe sibling names on the same host and keep whichever still
// returns an HLS manifest, cached so a dead name is only probed once an hour.
const ENDPOINT_CACHE = new Map(); // url -> { ok: url|null, at: ms }
const ENDPOINT_TTL = 60 * 60 * 1000;

function mncCandidates(url) {
  const u = new URL(url);
  const m = u.pathname.match(/\/([a-z0-9-]+?)(-sdi)?\.m3u8$/i);
  if (!m || !/(^|\.)rctiplus\.id$/i.test(u.hostname)) return [];
  // Strip a trailing year (gtv2023 -> gtv) so old and new names map to one stem.
  const base = m[1].toLowerCase().replace(/\d{4}$/, "") || m[1].toLowerCase();
  const hosts = [u.hostname, "allcutv.rctiplus.id"];
  const names = [
    `${base}-sdi`, base,
    ...[2023, 2024, 2025, 2026, 2027].map((y) => `${base}${y}`),
  ];
  const out = [];
  for (const h of hosts) {
    for (const n of names) {
      const cand = `https://${h}/${n}.m3u8`;
      if (cand !== url) out.push(cand);
    }
  }
  return out;
}

async function probeHls(url, referer, extra) {
  try {
    const r = await openUpstream(url, { referer, extra, timeout: 8000 });
    if (r.statusCode !== 200) { r.resume(); return false; }
    // Some edges answer 200 with an error page; trust the playlist magic bytes.
    const head = await new Promise((resolve) => {
      let buf = Buffer.alloc(0);
      r.on("data", (c) => { buf = Buffer.concat([buf, c]); if (buf.length >= 256) r.pause(); });
      r.on("end", () => resolve(buf.toString("utf8")));
      setTimeout(() => { r.pause(); resolve(buf.toString("utf8")); }, 7000).unref();
    });
    r.resume();
    return head.startsWith("#EXTM3U");
  } catch {
    return false;
  }
}

async function resolveMncEndpoint(url, referer, extra) {
  const hit = ENDPOINT_CACHE.get(url);
  if (hit && Date.now() - hit.at < ENDPOINT_TTL) return hit.ok;
  for (const cand of mncCandidates(url)) {
    if (await probeHls(cand, referer, extra)) {
      log(`endpoint fallback: ${url} -> ${cand}`);
      ENDPOINT_CACHE.set(url, { ok: cand, at: Date.now() });
      return cand;
    }
  }
  ENDPOINT_CACHE.set(url, { ok: null, at: Date.now() });
  return null;
}

async function proxyStream(req, res, q) {
  const target = q.get("u") || "";
  if (!/^https?:\/\//.test(target)) return send(res, 400, "hanya http/https", "text/plain");
  let referer = q.get("ref") || null;
  const isDetik = target.includes("video.detik.com");
  if (!referer && isDetik) referer = DETIK_REFERER;
  const extra = isDetik ? { Cookie: `cshx=${DETIK_CSHX}`, Origin: new URL(DETIK_REFERER).origin } : {};

  // A redirected CDN serves a different manifest/segment, so follow hops and
  // rewrite later lines against the final URL rather than the requested one.
  // MNC's CDN serves variant playlists from a stale edge cache for minutes.
  // Add a query only to HLS playlist requests so every reload sees the live edge.
  let current = target;
  // MNC's CDN serves variant playlists from a stale edge cache, so a bust helps
  // there. Other origins (detik's wowza, Vidio) reject unknown query params with
  // 404/403 on the child playlists, so only bust the host that needs it.
  const needsBust = /(^|\.)rctiplus\.(id|com)$/i.test(new URL(current).hostname);
  if (needsBust && /\.m3u8?(\?|$)/i.test(current)) {
    const bust = new URL(current);
    bust.searchParams.set("_pctv", Date.now().toString());
    current = bust.toString();
  }
  let r;
  for (let hop = 0; hop <= 4; hop += 1) {
    try {
      r = await openUpstream(current, { referer, extra });
      if (process.env.PCTV_DEBUG) log("upstream", current, "->", r.statusCode);
    } catch (e) {
      return send(res, 502, `upstream error: ${e}`, "text/plain");
    }
    const loc = r.headers.location;
    if ([301, 302, 303, 307, 308].includes(r.statusCode) && loc && hop < 4) {
      r.resume();
      current = new URL(loc, current).toString();
      continue;
    }
    break;
  }

  const ctype = String(r.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const isPlaylist = ctype.includes("mpegurl") || /\.m3u8?(\?|$)/i.test(current);

  if (r.statusCode !== 200) {
    // Dead MNC endpoint: try sibling names before giving up (see resolveMncEndpoint).
    if (r.statusCode === 404 && /(^|\.)rctiplus\.id$/i.test(new URL(current).hostname)) {
      const fixed = await resolveMncEndpoint(target, referer, extra);
      if (fixed) return proxyStream(req, res, new URLSearchParams({ u: fixed, ...(referer ? { ref: referer } : {}) }));
    }
    const body = await readAll(r).catch(() => Buffer.alloc(0));
    return send(res, r.statusCode, body.subarray(0, 4096), ctype || "application/octet-stream");
  }

  if (!isPlaylist) return proxyBody(req, res, r);

  const text = (await readAll(r)).toString("utf8");
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s) continue;
    if (s.startsWith("#")) {
      // URI="" also appears in EXT-X-MAP, EXT-X-KEY, EXT-X-MEDIA and EXT-X-I-FRAME-STREAM-INF.
      out.push(s.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${absProxy(uri, current, referer)}"`));
    } else {
      out.push(absProxy(s, current, referer));
    }
  }
  send(res, 200, out.join("\n") + "\n", "application/vnd.apple.mpegurl");
}

// ---- static ----
function serveFile(res, file, ctype) {
  if (!fs.existsSync(file)) return send(res, 404, `${path.basename(file)} tidak ditemukan`, "text/plain");
  send(res, 200, fs.readFileSync(file), ctype);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ---- server ----
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  const q = u.searchParams;
  try {
    if (req.method === "HEAD") req.method = "GET";
    if (p === "/" || p === "/index.html") return serveFile(res, path.join(STATIC_DIR, "index.html"), MIME[".html"]);
    if (p === "/hls.min.js" || p === "/hls.js") return serveFile(res, path.join(STATIC_DIR, "hls.min.js"), MIME[".js"]);
    if (p === "/app.js") return serveFile(res, path.join(STATIC_DIR, "app.js"), MIME[".js"]);
    if (p === "/style.css") return serveFile(res, path.join(STATIC_DIR, "style.css"), MIME[".css"]);
    if (p === "/api/state") {
      return sendJson(res, {
        channels: DATA.channels || [],
        sources: (DATA.sources || []).map((s) => ({ ...s, text: undefined })),
        updated: DATA.updated,
        version: SERVER_VERSION,
        proxy: true,
      });
    }
    if (p === "/vidio") return vidioStream(req, res, q);
    if (p === "/detik-sec") return detikSecStream(req, res, q);    if (p === "/stream") return proxyStream(req, res, q);
    if (p === "/api/refresh" && req.method === "POST") return sendJson(res, { ok: true, channels: await rebuildChannels() });
    if (req.method === "POST") {
      const body = await readBody(req);
      if (p === "/api/sources") {
        const url = (body.url || "").trim();
        if (!/^https?:\/\//.test(url)) return sendJson(res, { error: "URL harus diawali http:// atau https://" }, 400);
        DATA.sources.push({
          id: `src${Date.now().toString().slice(-9)}`,
          name: (body.name || url.hostname || "sumber").slice(0, 80),
          url,
          enabled: true,
        });
        saveData();
        return sendJson(res, { ok: true, channels: await rebuildChannels() });
      }
      if (p === "/api/sources/addone") {
        const url = (body.url || "").trim();
        if (!/^https?:\/\//.test(url)) return sendJson(res, { error: "URL harus diawali http:// atau https://" }, 400);
        const name = (body.name || new URL(url).hostname || "Stream").slice(0, 80);
        let err = "";
        try {
          const r = await fetchUrl(url, { referer: body.page || null, timeout: 12_000 });
          if (r.status !== 200) err = `HTTP ${r.status}`;
        } catch (e) {
          err = String(e).slice(0, 160);
        }
        DATA.sources.push({
          id: `one${Date.now().toString().slice(-9)}`,
          name,
          url,
          page: body.page || "",
          enabled: true,
          kind: "single",
          last_error: err,
        });
        saveData();
        return sendJson(res, { ok: true, channels: await rebuildChannels(), note: err || "OK" });
      }
      if (p === "/api/sources/delete") {
        DATA.sources = (DATA.sources || []).filter((s) => s.id !== body.id);
        saveData();
        return sendJson(res, { ok: true, channels: await rebuildChannels() });
      }
      if (p === "/api/sources/toggle") {
        for (const s of DATA.sources) if (s.id === body.id) s.enabled = !s.enabled;
        saveData();
        return sendJson(res, { ok: true, channels: await rebuildChannels() });
      }
      if (p === "/api/upload") {
        DATA.sources.push({
          id: `up${Date.now().toString().slice(-9)}`,
          name: (body.name || "Playlist upload").slice(0, 80),
          url: "",
          text: body.text || "",
          enabled: true,
        });
        saveData();
        return sendJson(res, { ok: true, channels: await rebuildChannels() });
      }
    }
    send(res, 404, '{"error":"not found"}');
  } catch (e) {
    log("ERR", p, e.message);
    send(res, 500, `server error: ${e}`, "text/plain");
  }
});

// ---- boot ----
function freePort(preferred, host) {
  const net = require("net");
  const candidates = [preferred, preferred + 1, preferred + 2, 0];
  return new Promise((resolve) => {
    let i = 0;
    const attempt = () => {
      const cand = candidates[i++];
      const s = net.createServer();
      s.once("error", () => {
        if (i >= candidates.length) return resolve(0);
        attempt();
      });
      s.once("listening", () => {
        const port = s.address().port;
        s.close(() => resolve(port));
      });
      s.listen(cand, host);
    };
    attempt();
  });
}

async function main() {
  loadData();
  if (!(DATA.sources && DATA.sources.length)) {
    DATA.sources = [];
    if (fs.existsSync(PRESET_FILE)) {
      DATA.sources.push({
        id: "idpreset",
        name: "Indonesia FTA (preset)",
        url: "",
        text: fs.readFileSync(PRESET_FILE, "utf8"),
        enabled: true,
      });
    }
    DATA.sources.push({
      id: "seed1",
      name: "Demo Mux (tes HLS)",
      url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
      page: "",
      kind: "single",
      enabled: true,
    });
    saveData();
  }
  const host = process.env.PCTV_HOST || "0.0.0.0";
  const port = await freePort(parseInt(process.env.PCTV_PORT || "8765", 10), host);
  server.listen(port, host, async () => {
    log(`PC-TV (node) jalan di http://127.0.0.1:${port}`);
    log(`bind: ${host}:${port} | data: ${DATA_FILE}`);
    log("Ctrl+C untuk berhenti");
    await rebuildChannels();
  });
}

main();
