/* v0.7：Service Worker 已退役。本文件只做一件事——自毁。
   任何仍注册着旧版 SW 的设备会在下次更新检查时装入本文件：
   无 fetch 监听器（装入即对所有请求透明），激活后立即注销自身，
   设备从此回到纯原生网络通路。 */
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.registration.unregister().catch(() => {})));
