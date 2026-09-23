#!/usr/bin/env node
// Đăng bài "Lịch vạn niên" lên Facebook Page qua Graph API (thay Metricool cho Facebook).
//
// Chạy:   node dang-facebook.mjs [--date YYYY-MM-DD] [--root <thư mục gốc repo>] [--dry-run] [--image]
//   --date     Ngày của bài (mặc định: ngày VN của thời điểm hiện tại + 5 giờ
//              => chạy lúc 19:30 tối thì đăng bài cho NGÀY MAI; chạy lúc 00:00-04:59 thì vẫn là ngày đó).
//   --root     Thư mục chứa lich-van-nien/xuat-ban/ (mặc định: thư mục hiện tại).
//   --dry-run  Chỉ kiểm tra file + token + trùng lặp, KHÔNG đăng.
//   --image    Đăng ảnh media.png thay vì video.mp4.
//
// Biến môi trường bắt buộc: FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN
// (máy local: đọc từ file .env ở gốc repo 100X Agent; GitHub Actions: đọc từ Secrets).
//
// An toàn chạy lại nhiều lần: nếu Page đã có bài "LỊCH VẠN NIÊN — ..., D/M/YYYY" thì bỏ qua.
// Chỉ dùng Node >= 20 (fetch/FormData/Blob có sẵn), không cần npm install.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GRAPH = 'https://graph.facebook.com/v26.0';
const GRAPH_VIDEO = 'https://graph-video.facebook.com/v26.0';

// ---------- tham số ----------
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : undefined; };
const DRY = argv.includes('--dry-run');
const USE_IMAGE = argv.includes('--image');
const ROOT = path.resolve(arg('--root') || process.cwd());

function vnDate(offsetHours = 0) {
  const d = new Date(Date.now() + (7 + offsetHours) * 3600e3); // UTC+7
  return d.toISOString().slice(0, 10);
}
const DATE = arg('--date') || vnDate(5);
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) fail(`Sai định dạng --date: ${DATE} (cần YYYY-MM-DD)`);

// ---------- nạp .env nếu chạy trên máy (không ghi đè biến đã có) ----------
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const here = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(ROOT, '.env'));
loadDotEnv(path.resolve(here, '..', '..', '.env')); // gốc repo 100X Agent

const PAGE_ID = process.env.FB_PAGE_ID;
const TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
if (!PAGE_ID || !TOKEN) fail('Thiếu FB_PAGE_ID hoặc FB_PAGE_ACCESS_TOKEN (file .env hoặc GitHub Secrets).');

// ---------- tìm nội dung ----------
const dayDir = path.join(ROOT, 'lich-van-nien', 'xuat-ban', DATE);
const fbDir = path.join(dayDir, 'facebook');
const mediaFile = path.join(fbDir, USE_IMAGE ? 'media.png' : 'video.mp4');

function readCaption() {
  const cap = path.join(fbDir, 'caption.txt');
  if (fs.existsSync(cap)) return fs.readFileSync(cap, 'utf8').replace(/\r/g, '').trim();
  const gop = path.join(dayDir, 'NOI_DUNG_DANG.txt');
  if (fs.existsSync(gop)) {
    // Lấy khối "1) CAPTION FACEBOOK" nằm giữa 2 đường kẻ "-----" và mục "2)"/"=====".
    const t = fs.readFileSync(gop, 'utf8').replace(/\r/g, '');
    const m = t.match(/1\)\s*CAPTION FACEBOOK[^\n]*\n-+\n([\s\S]*?)\n-{10,}\n\s*2\)/) ||
              t.match(/1\)\s*CAPTION FACEBOOK[^\n]*\n-+\n([\s\S]*?)\n={10,}/);
    if (m) return m[1].trim();
  }
  return null;
}

const [y, mo, d] = DATE.split('-').map(Number);
const DATE_VN = `${d}/${mo}/${y}`; // dạng xuất hiện trong dòng đầu caption, vd "23/9/2026"

async function graph(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const e = body.error || {};
    let hint = '';
    if (e.code === 190) hint = '\n→ Token hết hạn/bị thu hồi: tạo lại token theo HUONG_DAN.md mục "Gia hạn token".';
    if (e.code === 200 || e.code === 10) hint = '\n→ Thiếu quyền: cần pages_manage_posts + pages_read_engagement.';
    throw new Error(`Graph API lỗi ${res.status}: ${e.message || JSON.stringify(body)}${hint}`);
  }
  return body;
}

async function alreadyPosted() {
  const r = await graph(`${GRAPH}/${PAGE_ID}/posts?fields=id,message,created_time&limit=15`);
  return (r.data || []).find(p => {
    const first = (p.message || '').split('\n')[0];
    return /LỊCH VẠN NIÊN/i.test(first) && new RegExp(`\\b${DATE_VN.replace(/\//g, '\\/')}\\b`).test(first);
  });
}

async function main() {
  console.log(`📅 Ngày bài: ${DATE} (${DATE_VN}) · Page ${PAGE_ID} · ${USE_IMAGE ? 'ẢNH' : 'VIDEO'}${DRY ? ' · DRY-RUN' : ''}`);

  const me = await graph(`${GRAPH}/me?fields=id,name`);
  if (me.id !== PAGE_ID) fail(`Token thuộc "${me.name}" (${me.id}), không phải Page ${PAGE_ID}.`);
  console.log(`🔑 Token hợp lệ cho Page "${me.name}"`);

  const dup = await alreadyPosted();
  if (dup) { console.log(`⏭️  Đã có bài ngày ${DATE_VN} (post ${dup.id}, ${dup.created_time}) — bỏ qua.`); return; }

  const caption = readCaption();
  const missing = !caption ? 'caption' : (!fs.existsSync(mediaFile) ? path.basename(mediaFile) : null);
  if (missing && process.env.SOFT_MISSING === '1') {
    console.log(`⏳ Chưa có ${missing} cho ngày ${DATE} (routine chưa đẩy lên) — chờ lần chạy sau.`);
    return;
  }
  if (!caption) fail(`Không thấy caption: ${path.relative(ROOT, fbDir)}/caption.txt hoặc ${path.relative(ROOT, dayDir)}/NOI_DUNG_DANG.txt`);
  if (!caption.split('\n')[0].includes(DATE_VN)) console.warn(`⚠️  Dòng đầu caption không chứa "${DATE_VN}" — kiểm tra lại đúng ngày chưa.`);
  if (!fs.existsSync(mediaFile)) fail(`Không thấy file: ${path.relative(ROOT, mediaFile)}`);
  console.log(`📝 Caption ${Buffer.byteLength(caption)} byte · 🎞️ ${path.relative(ROOT, mediaFile)} (${(fs.statSync(mediaFile).size / 1e6).toFixed(1)} MB)`);

  if (DRY) { console.log('✅ DRY-RUN ổn, chưa đăng.'); return; }

  const form = new FormData();
  const blob = new Blob([fs.readFileSync(mediaFile)], { type: USE_IMAGE ? 'image/png' : 'video/mp4' });
  let result;
  if (USE_IMAGE) {
    form.append('source', blob, 'media.png');
    form.append('message', caption);
    form.append('published', 'true');
    result = await graph(`${GRAPH}/${PAGE_ID}/photos`, { method: 'POST', body: form });
  } else {
    form.append('source', blob, 'video.mp4');
    form.append('description', caption);
    form.append('published', 'true');
    result = await graph(`${GRAPH_VIDEO}/${PAGE_ID}/videos`, { method: 'POST', body: form });
  }
  const id = result.post_id || result.id;
  console.log(`✅ Đã đăng: id ${id} → https://www.facebook.com/${id}`);

  // Ghi nhật ký (máy local: vào thư mục dang-facebook/nhat-ky; Actions: in ra log là đủ).
  const logDir = path.join(here, 'nhat-ky');
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, `${DATE}.json`), JSON.stringify({
      date: DATE, page_id: PAGE_ID, type: USE_IMAGE ? 'photo' : 'video', id,
      posted_at: new Date().toISOString(), caption_first_line: caption.split('\n')[0],
    }, null, 2));
  } catch { /* không bắt buộc */ }
}

function fail(msg) { console.error(`❌ ${msg}`); process.exit(1); }

main().catch(e => fail(e.message));
