// PWA bootstrap. Extracted from index.html so the CSP header can drop
// script-src 'unsafe-inline' and pin scripts to 'self'. Order matters:
// gesture handlers first (they need to attach before the app boots),
// then SPA route restoration, then the 404-redirect stash, then service
// worker registration. All original semantics preserved verbatim.

// -- iOS pinch/double-tap block --
// iOS Safari ignores user-scalable=no in the viewport meta tag, so
// block pinch/double-tap zoom gestures explicitly for the PWA.
document.addEventListener('gesturestart', function (e) { e.preventDefault(); }, { passive: false });
document.addEventListener('gesturechange', function (e) { e.preventDefault(); }, { passive: false });
document.addEventListener('gestureend', function (e) { e.preventDefault(); }, { passive: false });
document.addEventListener('touchmove', function (e) {
  if (e.touches && e.touches.length > 1) e.preventDefault();
}, { passive: false });
var lastTouchEnd = 0;
document.addEventListener('touchend', function (e) {
  var now = Date.now();
  if (now - lastTouchEnd <= 350) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

// -- GitHub Pages SPA routing redirect restoration --
(function() {
  var redirect = sessionStorage.redirect;
  delete sessionStorage.redirect;
  if (redirect && redirect !== location.href) {
    history.replaceState(null, null, redirect);
  }
})();

// -- Redirect handler for 404.html --
if (window.location.pathname !== '/' && !window.location.pathname.includes('.')) {
  sessionStorage.redirect = window.location.href;
}

// -- Service worker registration --
if ('serviceWorker' in navigator) {
  var basePath = window.location.pathname.replace(/index\.html$/, '').replace(/\/$/, '') || '/';
  var swPath = basePath + '/service-worker.js';
  navigator.serviceWorker.register(swPath).then(function (reg) {
    console.log('Service Worker registered:', swPath);
  }).catch(function (err) {
    console.log('Service Worker registration failed:', err);
  });

  // Auto-reload once when a new service worker takes control so users
  // get fresh code without having to reinstall the PWA. Auth token lives
  // in localStorage, so this does not sign anyone out.
  var __swRefreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (__swRefreshing) return;
    __swRefreshing = true;
    window.location.reload();
  });
}
