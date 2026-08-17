/* Uptalk demo Service Worker：媒体文件本地缓存 + Range 响应
   目的：iOS 主屏幕 Web App 的媒体进程对网络流/blob 均可能挂起，
   由 SW 以普通同源 URL + 206 区间响应从 Cache 回吐，播放全程本地化 */
const CACHE = 'uptalk-media';
const MEDIA = /classroom-web(-lite)?\.mp4$/;
const bufMem = new Map(); /* 进程内热缓存，避免每个 range 请求重复解码 */

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

async function mediaBuffer(url) {
  if (bufMem.has(url)) return bufMem.get(url);
  const cache = await caches.open(CACHE);
  let res = await cache.match(url, { ignoreVary: true, ignoreSearch: true });
  if (!res) {
    const net = await fetch(url, { cache: 'default' });
    if (!net.ok) throw new Error('net ' + net.status);
    const buf = await net.arrayBuffer();
    await cache.put(url, new Response(buf.slice(0), { headers: {
      'Content-Type': 'video/mp4', 'Content-Length': String(buf.byteLength) } }));
    bufMem.set(url, buf);
    return buf;
  }
  const buf = await res.arrayBuffer();
  bufMem.set(url, buf);
  return buf;
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
    return fetch(req); /* SW 层失败则透传网络 */
  }
}

self.addEventListener('fetch', e => {
  let u;
  try { u = new URL(e.request.url); } catch (err) { return; }
  if (u.origin === self.location.origin && MEDIA.test(u.pathname)) {
    e.respondWith(serveMedia(e.request));
  }
});
