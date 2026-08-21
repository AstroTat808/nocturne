(() => {
  const nativeFetch = window.fetch.bind(window);
  const DASHBOARD_PATH = '/api/admin/dashboard';
  const AUTH_PATH = '/api/admin/auth';
  const APPLICATIONS_PATH = '/api/admin/applications';

  window.fetch = function nocturneAdminFetch(input, init = {}) {
    try {
      const rawUrl = typeof input === 'string' ? input : input?.url;
      if (rawUrl) {
        const url = new URL(rawUrl, window.location.origin);
        if (url.origin === window.location.origin && url.pathname === DASHBOARD_PATH) {
          const method = String(init.method || (typeof input !== 'string' ? input?.method : '') || 'GET').toUpperCase();

          if (method === 'GET' && url.searchParams.get('action') === 'session') {
            return nativeFetch(AUTH_PATH, init);
          }

          if (method === 'GET' && url.searchParams.get('action') === 'applications') {
            return nativeFetch(APPLICATIONS_PATH, init);
          }

          if (method === 'POST' && typeof init.body === 'string') {
            try {
              const body = JSON.parse(init.body);
              if (body?.action === 'login' || body?.action === 'logout') {
                return nativeFetch(AUTH_PATH, init);
              }
            } catch {}
          }
        }
      }
    } catch {}

    return nativeFetch(input, init);
  };
})();
