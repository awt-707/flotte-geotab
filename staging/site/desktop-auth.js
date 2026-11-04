/* Supabase owns the session and its tokens. This controller only manages the
 * SDK refresh timer for the explicitly validated production desktop client. */
(() => {
  'use strict';
  window.createDesktopAuthRefresh = (auth, { enabled = false } = {}) => {
    if (enabled !== true) return { sessionChanged: async () => {}, dispose: async () => {} };
    if (!auth || ['initialize', 'startAutoRefresh', 'stopAutoRefresh'].some(method => typeof auth[method] !== 'function')) {
      throw new TypeError('Renouvellement de session desktop indisponible.');
    }
    let revision = 0, wanted = false, applied = null, disposed = false, initialization = null, tail = Promise.resolve();
    function update(next) {
      wanted = next;
      const ticket = ++revision;
      const operation = tail.then(async () => {
        // Initialization installs the SDK's visibility callback. Starting too
        // early would allow initialization to reinstall it and stop refresh
        // when Electron hides the window. These are public SDK methods only.
        initialization ||= Promise.resolve().then(() => auth.initialize());
        await initialization;
        if (ticket !== revision || applied === wanted) return;
        const requested = wanted;
        await auth[requested ? 'startAutoRefresh' : 'stopAutoRefresh']();
        applied = requested;
      });
      tail = operation.catch(() => { applied = null; });
      return operation;
    }
    return {
      sessionChanged(session) {
        if (disposed) return Promise.resolve();
        // Keep only this boolean, never another access/refresh token copy.
        return update(typeof session?.access_token === 'string' && !!session.access_token && !!session?.user?.id);
      },
      dispose() { disposed = true; return update(false); }
    };
  };
})();
