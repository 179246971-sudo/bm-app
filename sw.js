/**
 * Service Worker
 *
 * 作用只有一个：让安卓 Chrome 愿意把网站「安装」到桌面
 *（Chrome 要求站点注册了带 fetch 处理器的 SW）。
 *
 * 故意不缓存任何东西——报名数据和中奖的课表必须每次都是最新的，
 * 缓存反而会让人看到旧状态。
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // 空处理器：一律走网络，不拦截、不缓存
});

