# PC-TV

Nonton TV Indonesia di PC **tanpa TV tuner**, cukup browser dan koneksi internet.
Semua channel ditarik dari **live streaming resmi** masing-masing stasiun, bukan
aplikasi TV berbayar. Server lokal **Node.js zero-dependency**, UI dark minimal,
bisa diakses dari HP/laptop lain di jaringan yang sama.

## Cara pakai (Windows)

1. Pastikan **Node.js 18+** terpasang: https://nodejs.org/
2. **Klik dua kali `start.bat`**, atau manual:
   ```
   cd nodejs && node server.js
   ```
3. Buka `http://127.0.0.1:8765` di browser. Dari HP/laptop lain di WiFi yang
   sama: `http://<IP-PC-anda>:8765` (lihat IP lewat `ipconfig`).

> Tidak perlu `npm install`. Semua modul bawaan Node: `http`, `https`, `fs`,
> `crypto`, `path`. Player memakai **hls.js 1.5.17** yang sudah dibundel offline
> di `static/hls.min.js`.

## Channel bawaan (preset `indonesia.m3u`)

| Grup | Channel | Sumber |
| --- | --- | --- |
| TVRI | Nasional, Sport HD, World, Jawa Barat | `ott-balancer.tvri.go.id` (terbuka) |
| Berita | Metro TV, Magna Channel | `edge.medcom.id` (terbuka) |
| Berita | CNN Indonesia, CNBC Indonesia | `video.detik.com` (wowza token) |
| MNC | RCTI, MNC TV, GTV | `allcutv.rctiplus.id` (Referer rctiplus) |
| Berita | iNews | `allcutv.rctiplus.id` (Referer rctiplus) |
| Transmedia | Trans TV, Trans7 | `20.detik.com` (wowza token, dibuat server) |
| Umum | RTV | `rtvstream.rtv.co.id` (terbuka) |
| Vidio | Indosiar, SCTV, ANTV, TVOne, Metro, BTV, JakTV, dll | `vidio.com` (perlu sesi, opsional) |

Legenda header:
- **TVRI / Metro / Magna / RTV** tanpa header khusus.
- **RCTI / MNC TV / GTV / iNews** butuh `Referer: https://www.rctiplus.com/`
  (otomatis dikirim proxy PC-TV).
- **Trans TV / Trans7**: server membuat **wowza token** sendiri lewat endpoint
  `/detik-sec?ch=transtv|trans7`. Token = SHA256 dari
  `prefix + postfix + "?" + secret + "&wowzatokenendtime=...&wowzatokenstarttime=0"`,
  di-base64 lalu `+`→`-`, `/`→`_`, umur 2 jam, dibuat ulang tiap channel dibuka.
  Proxy otomatis menyertakan `Origin: https://20.detik.com` dan cookie `cshx`.
- **Vidio** (opsional): server memanggil API internal
  `vidio.com/livestreamings/<id>/stream?initialize=true` memakai cookie
  `x-user-token` Anda. Taruh token di `data/vidio-auth.json` (lihat bawah).

## Fitur

- **Playlist M3U/M3U8** tempel langsung atau lewat URL, auto ter-parser.
- **Satu URL** tambah channel `.m3u8`/`.mp4` atau halaman live resmi.
- **Hotlink** channel populer siap pakai.
- **Proxy HLS** bawaan: menulis-ulang playlist + meneruskan segmen, jadi masalah
  `Referer`, CORS, dan cookie tidak menghalangi player. UDP/RTSP tidak didukung.
- **Endpoint fallback otomatis (MNC)**: kalau `allcutv.rctiplus.id` mengganti
  nama playlist (pernah `gtv2023` → `gtv-sdi`), server otomatis probe nama
  saudara (`<base>-sdi`, `<base>`, `<base>2023..2027`), ambil yang pertama balas
  `#EXTM3U`, cache 1 jam. Channel tidak mati saat stasiun rename.
- **Kategori / grup**, **cari channel**, **keyboard** (Tab urut visual,
  Escape tutup dialog).
- **EPG XMLTV** opsional kalau playlist punya `tvg-id`.

## Tambah channel sendiri

Buka tombol **＋ Sumber**:
- **Playlist M3U** — paste isi file playlist (format standar `#EXTINF`/`#EXTM3U`).
  Baris `#EXTVLCOPT:http-referrer=...` otomatis dipakai.
- **Satu URL** — isi URL `.m3u8`/`.mp4` atau halaman live; app cek & mulai mainkan.
- **Hotlink** — satu klik channel populer siap pakai.

## Vidio (opsional)

Channel Vidio butuh cookie `x-user-token` akun Vidio Anda (gratisan dapat akses
channel FTA; premium sesuai langganan):
1. Login `vidio.com` di browser → DevTools → Application → Cookies → salin nilai `x-user-token`.
2. Simpan ke `data/vidio-auth.json`:
   ```json
   { "x_user_token": "TOKEN_ANDA" }
   ```
3. Restart server. Channel Vidio di playlist (`/vidio?id=205` dll.) jalan.

> Tanpa file itu, channel Vidio tetap muncul tapi player menampilkan error.

## Struktur

```
pc-tv/
  start.bat        launcher Windows (klik dua kali)
  indonesia.m3u    preset channel FTA + Vidio (sumber resmi)
  nodejs/
    server.js      server lokal + proxy HLS + resolver + wowza token (zero-dep)
    package.json   meta (tanpa dependencies)
  static/
    index.html     UI
    style.css      tema dark (lihat DESIGN.md)
    app.js         logika player (hls.js)
    hls.min.js     hls.js 1.5.17 (dibundel offline)
  data/
    playlists.json config + daftar channel (otomatis, jangan dihapus)
    vidio-auth.json opsional: cookie x-user-token Vidio
  DESIGN.md        arah desain UI
  AGENTS.md        konvensi untuk AI assistant
```

## Endpoint server

| Path | Fungsi |
| --- | --- |
| `GET /` | UI |
| `GET /api/state` | JSON daftar channel + sumber |
| `POST /api/refresh` | rebuild channel dari sumber |
| `POST /api/sources` | tambah sumber (playlist/url) |
| `GET /stream?u=URL&ref=REFERER` | proxy HLS (playlist + segmen) |
| `GET /vidio?id=N` | resolver channel Vidio (butuh auth) |
| `GET /detik-sec?ch=transtv|trans7` | manifest Trans TV/Trans7 dengan wowza token |

## Catatan & troubleshooting

- **Channel tidak bunyi/gambar** → browser lama. Pakai Chrome/Edge/Firefox
  terbaru; hls.js butuh MSE modern. Di **iPhone/Safari** refresh halaman
  (cache lama bisa bikin player tidak muncul).
- **GTV/iNews blank** → buka channel lain lalu kembali; resolver MNC akan
  otomatis mencari nama endpoint terbaru (cek log `nodejs/node_live.log`).
- **RCTI/MNC blank** → pastikan lewat proxy PC-TV, jangan buka URL-nya langsung
  di browser (403 tanpa `Referer: rctiplus`).
- **Reset** → hapus `data/playlists.json`, restart server.
- **Port** default 8765. Ganti: `set PCTV_PORT=9000` (cmd) sebelum start.
- **Host** default `0.0.0.0` (terbuka ke LAN). Kunci ke loopback saja:
  `set PCTV_HOST=127.0.0.1`.

Lisensi: untuk penggunaan pribadi; gunakan konten stream sesuai ketentuan
masing-masing stasiun.
