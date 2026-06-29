// Runs before first paint. Resolves the active theme from the persisted preference
// or the OS setting and applies the `dark` class so there is no flash. Kept tiny and
// CSP-safe (served from /, script-src 'self'). The app's ThemeProvider takes over after.
(function () {
  try {
    var stored = localStorage.getItem('apphub.theme'); // 'light' | 'dark' | 'system' | null
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var dark = stored === 'dark' || ((stored === 'system' || !stored) && prefersDark);
    document.documentElement.classList.toggle('dark', dark);
  } catch (e) {
    /* localStorage may be unavailable; default to light */
  }
})();
