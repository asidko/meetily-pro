'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useModelCatalog } from '@/hooks/useModelCatalog';
import { useAssistantSettings } from '@/hooks/useAssistantSettings';
import { useModelSelection } from '@/hooks/useModelSelection';
import { SPEECH_PROVIDERS, TEXT_PROVIDERS, availability, catalogLabel, isCloudSpeech, type Catalog, type CatalogProvider, type ModelChoice } from '@/lib/model-catalog';
import { ProvidersSection } from './ProvidersSection';
import { LiveAssistantSettings } from './LiveAssistantSettings';

const ALL_PROVIDERS: CatalogProvider[] = [...SPEECH_PROVIDERS, ...TEXT_PROVIDERS];

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
      <p className="mb-4 text-sm text-gray-600">{description}</p>
      {children}
    </section>
  );
}

interface InUseRowProps {
  label: string;
  purpose: string;
  catalog: Catalog;
  choice: ModelChoice;
  onShow: (provider: CatalogProvider) => void;
}

function InUseRow({ label, purpose, catalog, choice, onShow }: InUseRowProps) {
  const state = availability(catalog, choice);
  const chosen = state.kind !== 'none';
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium text-gray-800">{label}</div>
        <div className="text-xs text-gray-500">{purpose}</div>
        {state.kind === 'gone' && (
          <div className="mt-1 flex items-center gap-1.5 text-xs text-amber-700">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />{state.reason} Press Use on another option below.
          </div>
        )}
        {state.kind === 'unknown' && <div className="mt-1 text-xs text-gray-500">{state.reason}</div>}
      </div>
      {chosen ? (
        <button type="button" className="min-w-0 max-w-[50%] truncate text-right text-sm text-blue-700 hover:underline" title={choice.model} onClick={() => onShow(choice.provider as CatalogProvider)}>
          {catalogLabel(choice.provider)} - {choice.model}
        </button>
      ) : (
        <span className="shrink-0 text-sm text-gray-500">None yet - press Use below</span>
      )}
    </div>
  );
}

export function ModelsSettings() {
  const { catalog, refresh } = useModelCatalog(ALL_PROVIDERS);
  const selection = useModelSelection();
  const { ai, voice } = selection;
  const [open, setOpen] = useState('');
  const assistant = useAssistantSettings();

  const showProvider = useCallback((provider: CatalogProvider) => {
    setOpen(provider);
    requestAnimationFrame(() => document.getElementById(`provider-${provider}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <Section title="In use" description="Press Use next to any ready option below to switch.">
        <div className="divide-y">
          <InUseRow label="Voice transcript" purpose={`Turns speech into text while you record.${isCloudSpeech(voice.provider) ? ` Your audio is sent to ${catalogLabel(voice.provider)}.` : ''}`} catalog={catalog} choice={voice} onShow={showProvider} />
          <InUseRow label="AI model" purpose="Writes summaries and answers your questions during and after a call." catalog={catalog} choice={ai} onShow={showProvider} />
          <div className="pt-3">
            <LiveAssistantSettings {...assistant} />
          </div>
        </div>
      </Section>
      <Section title="Providers" description="Set up each source once, then press Use to pick its model.">
        <ProvidersSection catalog={catalog} refresh={refresh} open={open} onOpenChange={setOpen} selection={selection} onCustomServerSaved={() => refresh(['custom-openai'])} />
      </Section>
    </div>
  );
}
