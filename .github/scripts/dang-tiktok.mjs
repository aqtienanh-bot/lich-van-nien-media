#!/usr/bin/env node
// Gửi video Lịch Vạn Niên vào HỘP THƯ NHÁP TikTok (Content Posting API - Upload, scope video.upload).
// Chạy được với app ở chế độ SANDBOX (không cần TikTok duyệt). Sau khi gửi, điện thoại nhận thông báo
// TikTok → bấm vào → dán caption → Đăng. (Đăng thẳng công khai cần app được audit — chưa dùng ở đây.)
//
// Chạy:  node dang-tiktok.mjs [--date YYYY-MM-DD] [--root .] [--dry-run] [--at HH:MM]
// Env:   TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REFRESH_TOKEN
//        (tuỳ chọn) GH_TOKEN + GITHUB_REPOSITORY: tự cập nhật secret TIKTOK_REFRESH_TOKEN nếu TikTok cấp mã mới.
//        (tuỳ chọn) SOFT_MISSING=1: chưa có video thì thoát êm (chờ lần chạy sau).
// Ghi dấu đã gửi: .github/tiktok-log/<date>.json (workflow commit lại) → không gửi trùng.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const API = 'https://open.tiktokapis.com/v2';
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : undefined; };
const DRY = argv.includes('--dry-run');
const ROOT = path.resolve(arg('--root') || process.cwd());
const vnDate = (h = 0) => new Date(Date.now() + (7 + h) * 3600e3).toISOString().slice(0, 10);
const DATE = arg('--date') || vnDate(5);
const fail = (m) => { console.error(`❌ ${m}`); process.exit(1); };

const { TIKTOK_CLIENT_KEY: KEY, TIKTOK_CLIENT_SECRET: SECRET, TIKTOK_REFRESH_TOKEN: REFRESH } = process.env;
if (!KEY || !SECRET || !REFRESH) fail('Thiếu TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET / TIKTOK_REFRESH_TOKEN.');

const video = path.join(ROOT, 'lich-van-nien', 'xuat-ban', DATE, 'tiktok', 'video.mp4');
const logFile = path.join(ROOT, '.github', 'tiktok-log', `${DATE}.json`);

async function refreshAccess() {
  const body = new URLSearchParams({ client_key: KEY, client_secret: SECRET, grant_type: 'refresh_token', refresh_token: REFRESH });
  const r = await fetch(`${API}/oauth/token/`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json();
  if (!j.access_token) fail(`Không làm mới được token TikTok: ${JSON.stringify(j)}\n→ Cấp quyền lại theo HUONG_DAN_TIKTOK.md.`);
  if (j.refresh_token && j.refresh_token !== REFRESH) {
    console.log(`🔁 TikTok cấp refresh_token mới (hạn ${Math.round((j.refresh_expires_in || 0) / 86400)} ngày).`);
    if (process.env.GH_TOKEN && process.env.GITHUB_REPOSITORY) {
      try {
        execFileSync('gh', ['secret', 'set', 'TIKTOK_REFRESH_TOKEN', '--repo', process.env.GITHUB_REPOSITORY], { input: j.refresh_token });
        console.log('   → Đã tự cập nhật secret TIKTOK_REFRESH_TOKEN.');
      } catch (e) { console.warn(`⚠️  Không cập nhật được secret: ${e.message}`); }
    } else {
      console.warn('⚠️  Chưa có GH_TOKEN để tự lưu refresh_token mới — mã cũ vẫn dùng được tới khi hết hạn.');
    }
  }
  return j.access_token;
}

async function api(p, token, payload) {
  const r = await fetch(`${API}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(payload) });
  const j = await r.json();
  if (j.error && j.error.code !== 'ok') throw new Error(`${p}: ${j.error.code} — ${j.error.message}`);
  return j.data;
}

async function main() {
  console.log(`📅 TikTok ngày ${DATE}${DRY ? ' · DRY-RUN' : ''}`);
  if (fs.existsSync(logFile)) { console.log(`⏭️  Đã gửi video ngày ${DATE} vào hộp thư TikTok trước đó — bỏ qua.`); return; }
  const token = await refreshAccess();
  const info = await fetch(`${API}/user/info/?fields=open_id,display_name`, { headers: { Authorization: `Bearer ${token}` } })
    .then(r => r.json()).then(j => j.data).catch(() => null);
  console.log(`🔑 Token TikTok hợp lệ${info?.user?.display_name ? ` — tài khoản "${info.user.display_name}"` : ''}`);

  if (!fs.existsSync(video)) {
    if (process.env.SOFT_MISSING === '1') { console.log(`⏳ Chưa có ${path.relative(ROOT, video)} — chờ lần chạy sau.`); return; }
    fail(`Không thấy ${path.relative(ROOT, video)}`);
  }
  const size = fs.statSync(video).size;
  console.log(`🎞️ ${path.relative(ROOT, video)} (${(size / 1e6).toFixed(1)} MB)`);
  if (DRY) { console.log('✅ DRY-RUN ổn, chưa gửi.'); return; }

  const AT = arg('--at');
  if (AT && /^\d{1,2}:\d{2}$/.test(AT)) {
    const [h, m] = AT.split(':').map(Number);
    const vn = new Date(Date.now() + 7 * 3600e3);
    const wait = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate(), h, m) - 7 * 3600e3 - Date.now();
    if (wait > 0 && wait < 3 * 3600e3) { console.log(`⏰ Chờ tới ${AT} giờ VN (${Math.round(wait / 60000)} phút)...`); await new Promise(r => setTimeout(r, wait)); }
  }

  // Video < 64MB: gửi 1 lần (1 chunk). Lớn hơn: chia chunk 10MB (chunk cuối gộp phần dư).
  const CH = 10 * 1024 * 1024;
  const single = size <= 64 * 1024 * 1024;
  const chunk = single ? size : CH;
  const count = single ? 1 : Math.floor(size / CH);
  const init = await api('/post/publish/inbox/video/init/', token, { source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunk, total_chunk_count: count } });
  const buf = fs.readFileSync(video);
  for (let i = 0; i < count; i++) {
    const start = i * chunk, end = i === count - 1 ? size - 1 : start + chunk - 1;
    const r = await fetch(init.upload_url, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) }, body: buf.subarray(start, end + 1) });
    if (!r.ok && r.status !== 206) fail(`Upload chunk ${i + 1}/${count} lỗi HTTP ${r.status}: ${await r.text()}`);
  }
  console.log(`📤 Đã tải video lên (publish_id ${init.publish_id}). Đang chờ TikTok xử lý...`);

  let status = 'PROCESSING_UPLOAD';
  for (let i = 0; i < 30 && /PROCESSING/.test(status); i++) {
    await new Promise(r => setTimeout(r, 10000));
    const s = await api('/post/publish/status/fetch/', token, { publish_id: init.publish_id });
    status = s.status; if (s.fail_reason) fail(`TikTok báo lỗi: ${s.fail_reason}`);
  }
  console.log(`📬 Trạng thái: ${status}${status === 'SEND_TO_USER_INBOX' ? ' — đã vào hộp thư TikTok. Mở điện thoại, bấm thông báo TikTok, dán caption rồi Đăng.' : ''}`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, JSON.stringify({ date: DATE, publish_id: init.publish_id, status, sent_at: new Date().toISOString() }, null, 2));
}

main().catch(e => fail(e.message));
