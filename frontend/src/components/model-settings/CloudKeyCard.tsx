'use client';

import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfig } from '@/contexts/ConfigContext';
import { catalogLabel, type CloudProvider } from '@/lib/model-catalog';

const KEY_PAGES: Record<CloudProvider, string> = {
  openai: 'https://platform.openai.com/api-keys',
  claude: 'https://console.anthropic.com/settings/keys',
  groq: 'https://console.groq.com/keys',
  openrouter: 'https://openrouter.ai/keys',
};

function maskKey(key: string): string {
  const trimmed = key.trim();
  return trimmed.length <= 8 ? '********' : `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

interface CloudKeyCardProps {
  provider: CloudProvider;
  inUseBy: string[];
}

export function CloudKeyCard({ provider, inUseBy }: CloudKeyCardProps) {
  const { providerApiKeys, updateProviderApiKey } = useConfig();
  const savedKey = providerApiKeys[provider]?.trim() || '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const label = catalogLabel(provider);

  const save = async () => {
    const key = draft.trim();
    if (!key) return;
    setBusy(true);
    try {
      await invoke('api_save_api_key', { provider, apiKey: key });
      updateProviderApiKey(provider, key);
      setEditing(false);
      setDraft('');
      toast.success(`${label} key saved`);
    } catch (error) {
      toast.error(`Could not save the ${label} key`, { description: String(error) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await invoke('api_delete_api_key', { provider });
      updateProviderApiKey(provider, null);
      setConfirmRemove(false);
      toast.success(`${label} key removed`);
    } catch (error) {
      toast.error(`Could not remove the ${label} key`, { description: String(error) });
    } finally {
      setBusy(false);
    }
  };

  if (savedKey && !editing) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-gray-700">Key <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">{maskKey(savedKey)}</code></span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={busy}>Change</Button>
            <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700" onClick={() => (inUseBy.length ? setConfirmRemove(true) : remove())} disabled={busy}>Remove key</Button>
          </div>
        </div>
        {confirmRemove && (
          <div className="flex items-center justify-between gap-3 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
            <span>{label} runs {inUseBy.join(' and ')}. They stop working until you pick another model.</span>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="destructive" onClick={remove} disabled={busy}>Remove</Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmRemove(false)} disabled={busy}>Keep</Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            type={show ? 'text' : 'password'}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') save(); }}
            placeholder={`${label} API key`}
            className="pr-10"
            autoFocus={editing}
          />
          <button type="button" className="absolute inset-y-0 right-0 px-3 text-gray-500" onClick={() => setShow(!show)} aria-label={show ? 'Hide key' : 'Show key'}>
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <Button onClick={save} disabled={busy || !draft.trim()}>Save key</Button>
        {editing && <Button variant="outline" onClick={() => { setEditing(false); setDraft(''); }} disabled={busy}>Cancel</Button>}
      </div>
      <p className="text-xs text-gray-500">
        Get a key at <button type="button" className="text-blue-600 underline" onClick={() => invoke('open_external_url', { url: KEY_PAGES[provider] })}>{KEY_PAGES[provider].replace('https://', '')}</button>
      </p>
    </div>
  );
}
