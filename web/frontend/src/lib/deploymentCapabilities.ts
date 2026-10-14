import { useEffect, useState } from 'react';

export interface DeploymentCapabilities {
  mode: 'local' | 'server' | 'unknown';
  environmentInstall: boolean;
  storageMigration: boolean;
}

const unknown: DeploymentCapabilities = { mode: 'unknown', environmentInstall: false, storageMigration: false };
const local: DeploymentCapabilities = { mode: 'local', environmentInstall: true, storageMigration: true };

/** Mutation controls require a recognized deployment response. */
export function decodeDeploymentCapabilities(value: unknown): DeploymentCapabilities {
  if (!value || typeof value !== 'object') return unknown;
  const info = value as Record<string, unknown>;
  const deployment = info.deployment && typeof info.deployment === 'object'
    ? info.deployment as Record<string, unknown> : undefined;
  if (deployment?.mode === 'local') return local;
  if (deployment?.mode === 'server') return {
    mode: 'server',
    environmentInstall: deployment.environmentInstall === true && deployment.readOnlyRoot === false,
    storageMigration: false,
  };
  // Older server releases expose readiness and admission pools but no mutation
  // capabilities. They remain readable and never enable desktop installers.
  if (info.web === true && info.resources && typeof info.resources === 'object')
    return { mode: 'server', environmentInstall: false, storageMigration: false };
  return unknown;
}

export async function fetchDeploymentCapabilities(signal?: AbortSignal): Promise<DeploymentCapabilities> {
  const base = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
  const response = await fetch(`${base}/api/server/readiness`, { cache: 'no-store', signal });
  // This route is registered only by the server deployment entrypoint.
  if (response.status === 404) return local;
  if (!response.ok) return unknown;
  return decodeDeploymentCapabilities(await response.json());
}

export function useDeploymentCapabilities() {
  const [capabilities, setCapabilities] = useState<DeploymentCapabilities>(unknown);
  useEffect(() => {
    let active = true, sequence = 0;
    let controller: AbortController | undefined;
    const read = async () => {
      const current = ++sequence;
      controller?.abort();
      controller = new AbortController();
      const request = controller;
      setCapabilities(unknown);
      const timeout = window.setTimeout(() => request.abort(), 10000);
      try {
        const value = await fetchDeploymentCapabilities(request.signal);
        if (active && current === sequence) setCapabilities(value);
      } catch {
        if (active && current === sequence) setCapabilities(unknown);
      } finally { window.clearTimeout(timeout); }
    };
    void read();
    window.addEventListener('online', read);
    window.addEventListener('focus', read);
    return () => {
      active = false;
      controller?.abort();
      window.removeEventListener('online', read);
      window.removeEventListener('focus', read);
    };
  }, []);
  return capabilities;
}
