import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useConfig } from '@/contexts/ConfigContext';
import { CLOUD_PROVIDERS, CLOUD_SPEECH_PROVIDERS, keyProvider, loadProvider, type Call, type Catalog, type CatalogInputs, type CatalogProvider } from '@/lib/model-catalog';

const DOWNLOAD_EVENTS: { event: string; provider: CatalogProvider; done: (payload: { status?: string }) => boolean }[] = [
  { event: 'model-download-complete', provider: 'localWhisper', done: () => true },
  { event: 'parakeet-model-download-complete', provider: 'parakeet', done: () => true },
  { event: 'ollama-model-download-complete', provider: 'ollama', done: () => true },
  { event: 'builtin-ai-download-progress', provider: 'builtin-ai', done: (payload) => payload.status === 'completed' },
];

function changedProviders(previous: CatalogInputs, next: CatalogInputs): CatalogProvider[] {
  const changed: CatalogProvider[] = [...CLOUD_PROVIDERS, ...CLOUD_SPEECH_PROVIDERS].filter((provider) => {
    const key = keyProvider(provider);
    return !!key && (previous.keys[key] ?? '') !== (next.keys[key] ?? '');
  });
  if (previous.ollamaEndpoint !== next.ollamaEndpoint) changed.push('ollama');
  return changed;
}

export function useModelCatalog(providers: CatalogProvider[]) {
  const { providerApiKeys, modelConfig } = useConfig();
  const [catalog, setCatalog] = useState<Catalog>({});
  const generation = useRef<Partial<Record<CatalogProvider, number>>>({});
  const inputs = useRef<CatalogInputs>({ keys: providerApiKeys, ollamaEndpoint: modelConfig.ollamaEndpoint ?? null });

  const refresh = useCallback(async (only?: CatalogProvider[]) => {
    const targets = only ? only.filter((provider) => providers.includes(provider)) : providers;
    await Promise.all(targets.map(async (provider) => {
      const run = (generation.current[provider] ?? 0) + 1;
      generation.current[provider] = run;
      const state = await loadProvider(invoke as Call, provider, inputs.current);
      if (generation.current[provider] === run) {
        setCatalog((prev) => ({ ...prev, [provider]: state }));
      }
    }));
  }, [providers]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const next: CatalogInputs = { keys: providerApiKeys, ollamaEndpoint: modelConfig.ollamaEndpoint ?? null };
    const stale = changedProviders(inputs.current, next).filter((provider) => providers.includes(provider));
    inputs.current = next;
    if (stale.length === 0) return;
    setCatalog((prev) => ({ ...prev, ...Object.fromEntries(stale.map((provider) => [provider, { status: 'loading' }])) }));
    refresh(stale);
  }, [providerApiKeys, modelConfig.ollamaEndpoint, providers, refresh]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const unlisteners = DOWNLOAD_EVENTS.map(({ event, provider, done }) =>
      listen<{ status?: string }>(event, ({ payload }) => {
        if (done(payload ?? {})) refreshRef.current([provider]);
      })
    );
    return () => {
      unlisteners.forEach((pending) => pending.then((unlisten) => unlisten()).catch(() => undefined));
    };
  }, []);

  return { catalog, refresh };
}
