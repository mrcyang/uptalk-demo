/* Uptalk demo Service Worker v3（v0.6.3）：只从本地缓存服务媒体，绝不代理网络。
   规则：字节已在缓存 → 按 Range 回吐 206（App 模式的本地通道）；
   其余一律不介入（浏览器原生网络播放，行为与无 SW 时一致）。
   SW 自身从不发起媒体网络请求——下载唯一入口是页面的带进度 fetch。 */
const CACHE = 'uptalk-media';
const MEDIA = /classroom-web(-lite)?\.mp4$/;
const bufMem = new Map(); /* 进程内热缓存：SW 存活期内免重复读盘 */
let readySet = null;      /* 已确认在缓存中的 URL 集合；null = 尚未扫描 */

async function scanCache() {
  try {
    const c = await caches.open(CACHE);
    readySet = new Set((await c.keys()).map(r => r.url));
  } catch (e) { readySet = new Set(); }
}

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(Promise.all([self.clients.claim(), scanCache()])));
/* 页面在 cache.put 成功后通知；SW 被系统重启后也能靠 scanCache 自愈 */
self.addEventListener('message', e => {
  const d = e.data;
  if (d && d.t === 'media-cached' && d.url) { if (!readySet) readySet = new Set(); readySet.add(d.url); }
});

async function serveLocal(req) {
  try {
    let buf = bufMem.get(req.url);
    if (!buf) {
      const c = await caches.open(CACHE);
      const hit = await c.match(req.url, { ignoreVary: true, ignoreSearch: true });
      if (!hit) { if (readySet) readySet.delete(req.url); return fetch(req); } /* 登记过期：透传原生 */
      buf = await hit.arrayBuffer();
      bufMem.set(req.url, buf);
    }
    const total = buf.byteLength;
    const range = req.headers.get('range');
    if (!range) {
      return new Response(buf.slice(0), { status: 200, headers: {
        'Content-Type': 'video/mp4', 'Content-Length': String(total), 'Accept-Ranges': 'bytes' } });
    }
    let start, end;
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m && m[1] === '' && m[2]) { const n = Math.min(+m[2], total); start = total - n; end = total - 1; } /* 后缀区间 bytes=-N */
    else { start = m ? +(m[1] || 0) : 0; end = (m && m[2]) ? Math.min(+m[2], total - 1) : total - 1; }
    if (start >= total || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
    }
    const chunk = buf.slice(start, end + 1);
    return new Response(chunk, { status: 206, headers: {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': String(chunk.byteLength),
      'Accept-Ranges': 'bytes' } });
  } catch (e) {
    return fetch(req); /* 任何内部异常：透传原生网络，绝不比无 SW 更坏 */
  }
}

self.addEventListener('fetch', e => {
  let u;
  try { u = new URL(e.request.url); } catch (err) { return; }
  if (e.request.headers.get('X-SW-Bypass')) return; /* 页面自带下载器：直连，进度真实可见 */
  if (u.origin !== self.location.origin || !MEDIA.test(u.pathname)) return;
  if (!readySet) { e.waitUntil(scanCache()); return; } /* 未扫描：本次原生，同时补扫描 */
  if (!readySet.has(e.request.url)) return; /* 缓存没有：完全不介入 */
  e.respondWith(serveLocal(e.request));
});
