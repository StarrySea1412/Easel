/** The workbench login is independent of platform and model credentials. */
export function workbenchLoginError() {
  return Object.assign(new Error('工作台登录已过期，请重新登录工作台。'), { status: 401, code: 'workbench_login_required' });
}

export function createWorkbenchAccess() {
  let expired = false;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => expired,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    guard(transport: typeof fetch, origin: string): typeof fetch {
      return async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, origin);
        const internal = url.origin === origin && /\/api\//.test(url.pathname);
        if (internal && expired) throw workbenchLoginError();
        const response = await transport(input, init);
        if (internal && response.status === 401 && response.headers.get('X-Easel-Auth') === 'required') {
          if (!expired) { expired = true; listeners.forEach(listener => listener()); }
          throw workbenchLoginError();
        }
        return response;
      };
    },
  };
}

export const workbenchAccess = createWorkbenchAccess();
/** Install before mounting the app so direct and shared API clients agree. */
export function installWorkbenchAccess() {
  window.fetch = workbenchAccess.guard(window.fetch.bind(window), window.location.origin);
}
