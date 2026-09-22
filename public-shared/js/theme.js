// Light or dark, decided before the first paint.
//
// This is a classic script rather than a module, and it sits in <head> above
// the stylesheet on purpose: a module is deferred until after the document is
// parsed, which would mean a dark-mode user seeing a white page flash first.
// That flash is small and it is horrible, and this is the only way to avoid it
// without an inline script — which this server's Content-Security-Policy does
// not allow, and rightly so.
(function () {
  var KEY = 'portal.theme';
  var root = document.documentElement;

  function stored() {
    try {
      var value = localStorage.getItem(KEY);
      return value === 'light' || value === 'dark' ? value : null;
    } catch (err) {
      // Private browsing, or storage switched off. Not an error: it only
      // means we follow the operating system, which is the default anyway.
      return null;
    }
  }

  var chosen = stored();
  if (chosen) root.setAttribute('data-theme', chosen);

  /// Exposed for the apps' own theme buttons.
  ///
  /// Passing nothing flips to the opposite of what is on screen now, which is
  /// what a single toggle button wants.
  window.__theme = {
    /// What is actually being shown, whether chosen or inherited from the
    /// operating system.
    current: function () {
      return (
        root.getAttribute('data-theme') ||
        (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      );
    },
    /// Whether this was a deliberate choice, as opposed to following the
    /// system. A settings screen needs to be able to say so.
    isExplicit: function () {
      return Boolean(root.getAttribute('data-theme'));
    },
    set: function (value) {
      var next = value || (this.current() === 'dark' ? 'light' : 'dark');
      root.setAttribute('data-theme', next);
      try {
        localStorage.setItem(KEY, next);
      } catch (err) {
        // The theme still applies for this page; it just will not be
        // remembered. Better than refusing to switch at all.
      }
      window.dispatchEvent(new CustomEvent('themechange', { detail: next }));
      return next;
    },
    /// Back to following the operating system.
    clear: function () {
      root.removeAttribute('data-theme');
      try {
        localStorage.removeItem(KEY);
      } catch (err) {}
      window.dispatchEvent(new CustomEvent('themechange', { detail: this.current() }));
    },
  };
})();
