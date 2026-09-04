// 聚会点共享版 —— 后端
// 无第三方依赖（纯 Node 内置模块）。功能：
//   1) 房间管理：创建/加入房间，人员位置同步（内存 + 持久化到 data/rooms.json）
//   2) 高德 Web服务 key 代理：地址检索 + 附近场所搜索（key 只在服务端，不暴露给前端，也没有跨域问题）
// 运行：node server.mjs   （默认端口 8788）
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const DATA = join(ROOT, 'data');
const DB_FILE = join(DATA, 'rooms.json');
const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || '0.0.0.0'; // 监听所有网卡，局域网/NAS 可访问

// 读取高德 Web服务 key（config.json，或环境变量 AMAP_KEY）
let AMAP_KEY = process.env.AMAP_KEY || '';
try { const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')); AMAP_KEY = AMAP_KEY || cfg.amapKey || ''; } catch (e) {}

// ---------- 存储 ----------
let rooms = {};
try { if (existsSync(DB_FILE)) rooms = JSON.parse(readFileSync(DB_FILE, 'utf8')); } catch (e) { rooms = {}; }
let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { mkdirSync(DATA, { recursive: true }); } catch (e) {}
    try { writeFileSync(DB_FILE, JSON.stringify(rooms), 'utf8'); } catch (e) {}
  }, 200);
}
function id(n) { return randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, n).toUpperCase(); }

// ---------- HTTP 小工具 ----------
function send(res, code, body, type) { res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8' }); res.end(body); }
function json(res, code, obj) { send(res, code, JSON.stringify(obj)); }
function readBody(req) { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch (e) { r({}); } }); }); }

// ---------- 高德代理（Web服务 key，服务端调用，无 CORS）----------
async function amapGeocode(address) {
  const u = 'https://restapi.amap.com/v3/geocode/geo?key=' + encodeURIComponent(AMAP_KEY) + '&address=' + encodeURIComponent(address) + '&output=json';
  const r = await fetch(u); const d = await r.json();
  if (d.status !== '1' || !d.geocodes || !d.geocodes.length) throw new Error('高德未能定位「' + address + '」');
  const loc = d.geocodes[0].location.split(',');
  return { lat: +loc[1], lng: +loc[0] };
}
async function amapPlace(keyword, lat, lng, radius) {
  const u = 'https://restapi.amap.com/v3/place/around?key=' + encodeURIComponent(AMAP_KEY) +
    '&location=' + lng + ',' + lat + '&radius=' + Math.min(Math.max(radius, 100), 50000) +
    '&keywords=' + encodeURIComponent(keyword) + '&offset=25&page=1&sortrule=distance&output=json';
  const r = await fetch(u); const d = await r.json();
  if (d.status !== '1') throw new Error('高德搜索失败：' + (d.info || '未知'));
  return (d.pois || []).map(p => { const ll = p.location.split(','); return { name: p.name, lat: +ll[1], lng: +ll[0], addr: (p.pname || '') + (p.cityname || '') + (p.address || '') }; });
}
// IP 定位（城市级精度，作为浏览器定位被禁用时的兜底）
async function amapIp(ip) {
  const u = 'https://restapi.amap.com/v3/ip?key=' + encodeURIComponent(AMAP_KEY) + (ip ? '&ip=' + encodeURIComponent(ip) : '');
  const r = await fetch(u); const d = await r.json();
  if (d.status !== '1' || !d.rectangle) throw new Error('IP 定位失败：' + (d.info || '未知'));
  const [w, s, e, n] = d.rectangle.split(';').map(x => x.split(',')).flat().map(Number);
  return { lat: (s + n) / 2, lng: (w + e) / 2, city: d.city || '' };
}

// ---------- 服务器 ----------
createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const path = decodeURIComponent(u.pathname);
    const method = req.method;

    // ---- API ----
    if (path.startsWith('/api/')) {
      if (method === 'GET') {
        const m = path.match(/^\/api\/room\/([^/]+)$/);
        if (m) { const rm = rooms[m[1]]; return json(res, rm ? 200 : 404, rm || { error: '房间不存在' }); }
        return json(res, 404, { error: 'not found' });
      }
      if (method === 'POST') {
        if (path === '/api/room') { const b = await readBody(req); const rid = id(6); rooms[rid] = { id: rid, name: b.name || '聚会', created: Date.now(), people: [] }; saveDB(); return json(res, 200, rooms[rid]); }
        if (path === '/api/geocode') { const b = await readBody(req); const g = await amapGeocode(b.address); return json(res, 200, g); }
        if (path === '/api/place') { const b = await readBody(req); const p = await amapPlace(b.keyword || b.cat, b.lat, b.lng, b.radius || 3000); return json(res, 200, { pois: p }); }
        if (path === '/api/ip') { const ip = req.socket.remoteAddress || ''; const pub = ip.replace(/^::ffff:/, '').startsWith('127.') ? '' : ip; const g = await amapIp(pub); return json(res, 200, g); }
        const m = path.match(/^\/api\/room\/([^/]+)\/people$/);
        if (m) { const rm = rooms[m[1]]; if (!rm) return json(res, 404, { error: '房间不存在' }); const b = await readBody(req); const lat = +b.lat, lng = +b.lng; if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return json(res, 400, { error: '坐标无效' }); const pid = id(6); rm.people.push({ id: pid, name: b.name || '人员', lat, lng }); saveDB(); return json(res, 200, { person: rm.people[rm.people.length - 1] }); }
        return json(res, 404, { error: 'not found' });
      }
      if (method === 'DELETE') {
        const m = path.match(/^\/api\/room\/([^/]+)\/people\/([^/]+)$/);
        if (m) { const rm = rooms[m[1]]; if (rm) { rm.people = rm.people.filter(p => p.id !== m[2]); saveDB(); } return json(res, 200, { ok: true }); }
        return json(res, 404, { error: 'not found' });
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    // ---- 静态页面（SPA：任意非 API 路径都返回 index.html，前端用路径 /r/<房间号> 识别房间）----
    let fp = path === '/' ? join(PUBLIC, 'index.html') : join(PUBLIC, path.replace(/^\//, ''));
    if (!existsSync(fp) || statSync(fp).isDirectory()) fp = join(PUBLIC, 'index.html');
    const body = readFileSync(fp);
    const ct = extname(fp) === '.js' ? 'text/javascript; charset=utf-8' : (extname(fp) === '.css' ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8');
    return send(res, 200, body, ct);
  } catch (e) {
    return json(res, 500, { error: (e && e.message) || '服务器错误' });
  }
}).listen(PORT, HOST, () => {
  console.log('🎯 聚会点共享版已启动：http://localhost:' + PORT);
  console.log('   创建房间后，把链接发给朋友即可一起填位置。');
  if (!AMAP_KEY) console.log('⚠️ 未配置高德 key（config.json 的 amapKey），地址检索/场所搜索不可用。');
});
