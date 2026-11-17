// Applies the stored theme before first paint. An external file (not inline) so the CSP can keep `script-src 'self'`.
try {
  var theme = localStorage.getItem('theme-preference');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch (error) {}
