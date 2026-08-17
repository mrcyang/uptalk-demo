/* Uptalk demo Service Worker：媒体文件本地缓存 + Range 响应
   目的：iOS 主屏幕 Web App 的媒体进程对网络流/blob 均可能挂起，
   由 SW 以普通同源 URL + 206 区间响应从 Cache 回吐，播放全程本地化 */
const CACHE = 'uptalk-media';
const MEDIA = /classroom-web(-lite)?\.mp4$/;
const bufMem = new Map(); /* 进程内热缓存，避免每个 range 请求重复解码 */
const inflight = new Map(); /* url→Promise：并发请求共享同一次下载，不再各起一份 6.6MB */

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

async function mediaBuffer(url) {
  if (bufMem.has(url)) return bufMem.get(url);
  if (inflight.has(url)) return inflight.get(url);
  const p = (async () => {
    const cache = await caches.open(CACHE);
    const res = await cache.match(url, { ignoreVary: true, ignoreSearch: true });
    if (res) { const buf = await res.arrayBuffer(); bufMem.set(url, buf); return buf; }
    const net = await fetch(url, { cache: 'default' });
    if (!net.ok) throw new Error('net ' + net.status);
    const buf = await net.arrayBuffer();
    bufMem.set(url, buf); /* 先入内存再写盘：写盘配额失败不丢弃已下载数据 */
    try { await cache.put(url, new Response(buf.slice(0), { headers: {
      'Content-Type': 'video/mp4', 'Content-Length': String(buf.byteLength) } })); } catch (e) {}
    return buf;
  })();
  inflight.set(url, p);
  try { return await p; } finally { inflight.delete(url); }
}

async function serveMedia(req) {
  try {
    const buf = await mediaBuffer(req.url);
    const total = buf.byteLength;
    const range = req.headers.get('range');
    if (!range) {
      return new Response(buf.slice(0), { status: 200, headers: {
        'Content-Type': 'video/mp4', 'Content-Length': String(total), 'Accept-Ranges': 'bytes' } });
    }
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? +m[1] : 0;
    const end = (m && m[2]) ? Math.min(+m[2], total - 1) : total - 1;
    if (start >= total) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
    }
    const chunk = buf.slice(start, end + 1);
    return new Response(chunk, { status: 206, headers: {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': String(chunk.byteLength),
      'Accept-Ranges': 'bytes' } });
  } catch (e) {
    if (req.headers.get('range')) {
      /* Range 请求绝不透传：网络流在 App 模式会挂死媒体进程且毫无征兆；
         快速 503 让 <video> 立即报错，页面得以感知并换轨 */
      return new Response(null, { status: 503, headers: { 'X-SW-Error': String(e && e.message || e) } });
    }
    return fetch(req); /* 整文件请求仍透传，保 Safari 标签页兜底 */
  }
}

self.addEventListener('fetch', e => {
  let u;
  try { u = new URL(e.request.url); } catch (err) { return; }
  if (e.request.headers.get('X-SW-Bypass')) return; /* 页面自带下载器：放行直连，进度真实可见 */
  if (u.origin === self.location.origin && MEDIA.test(u.pathname)) {
    e.respondWith(serveMedia(e.request));
  }
});
