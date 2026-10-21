'use client';

import type { ReactNode } from 'react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { useConfig } from '@/contexts/ConfigContext';
import { ModelManager as WhisperModelManager } from '@/components/WhisperModelManager';
import { ParakeetModelManager } from '@/components/ParakeetModelManager';
import { BuiltInModelManager } from '@/components/BuiltInModelManager';
import { VOICE_LOCKED_REASON, type ModelSelection } from '@/hooks/useModelSelection';
import { CLI_AGENTS, CLOUD_PROVIDERS, CLOUD_SPEECH, CLOUD_SPEECH_PROVIDERS, SPEECH_PROVIDERS, catalogLabel, isCliAgent, isOnDevice, keyProvider, type Catalog, type CatalogProvider, type CloudProvider, type CloudSpeechProvider, type ProviderState, type SpeechProvider } from '@/lib/model-catalog';
import { CloudKeyCard } from './CloudKeyCard';
import { OllamaCard } from './OllamaCard';
import { CustomServerCard } from './CustomServerCard';
import { CliAgentCard } from './CliAgentCard';
import { UseModelButton } from './UseModelButton';

type Badge = { text: string; className: string };

function speechTwin(provider: CloudProvider): CloudSpeechProvider | undefined {
  return CLOUD_SPEECH_PROVIDERS.find((speech) => CLOUD_SPEECH[speech] === provider);
}

const BADGES = {
  missing: { text: 'Not set up', className: 'bg-gray-100 text-gray-600' },
  checking: { text: 'Checking', className: 'bg-gray-100 text-gray-500' },
  unreachable: { text: 'Unreachable', className: 'bg-red-50 text-red-700' },
} satisfies Record<string, Badge>;

function count(models: string[], noun: string): string {
  return `${models.length} ${noun}${models.length === 1 ? '' : 's'}`;
}

function describe(provider: CatalogProvider, state: ProviderState | undefined, hasKey: boolean): { line: string; badge?: Badge } {
  if (!state || state.status === 'loading') return { line: '', badge: BADGES.checking };
  const onDevice = isOnDevice(provider);
  const cli = isCliAgent(provider);
  if (state.status === 'ready') {
    if (onDevice) return { line: `${count(state.models, 'model')} downloaded` };
    if (provider === 'ollama') return { line: `Connected - ${count(state.models, 'model')}` };
    if (provider === 'custom-openai') return { line: state.models[0] };
    if (cli) return { line: state.detail ? `Signed in - ${state.detail}` : 'Signed in' };
    return { line: `Key saved - ${count(state.models, 'model')}` };
  }
  if (state.status === 'error') {
    return { line: hasKey ? `Key saved - ${state.reason}` : 'Could not connect', badge: BADGES.unreachable };
  }
  if (onDevice) return { line: 'No models downloaded', badge: BADGES.missing };
  if (hasKey) return { line: `Key saved - ${state.reason}`, badge: BADGES.missing };
  if (provider === 'ollama') return { line: 'Connected - no models yet', badge: BADGES.missing };
  if (provider === 'custom-openai') return { line: 'No server yet', badge: BADGES.missing };
  if (cli) return { line: state.reason, badge: BADGES.missing };
  return { line: 'No key', badge: BADGES.missing };
}

interface ProvidersSectionProps {
  catalog: Catalog;
  refresh: (only?: CatalogProvider[]) => Promise<void>;
  open: string;
  onOpenChange: (value: string) => void;
  selection: ModelSelection;
  onCustomServerSaved: () => void;
}

export function ProvidersSection({ catalog, refresh, open, onOpenChange, selection, onCustomServerSaved }: ProvidersSectionProps) {
  const { providerApiKeys } = useConfig();
  const { ai, voice, chooseAiModel, chooseVoiceModel, voiceLocked } = selection;

  const actionFor = (provider: CatalogProvider, state: ProviderState | undefined) => {
    if (state?.status !== 'ready') return null;
    const speech = SPEECH_PROVIDERS.includes(provider as SpeechProvider);
    return (
      <UseModelButton
        provider={provider}
        models={state.models}
        current={speech ? voice : ai}
        onChoose={speech ? chooseVoiceModel : chooseAiModel}
        disabled={speech && voiceLocked}
        disabledReason={VOICE_LOCKED_REASON}
      />
    );
  };

  const row = (provider: CatalogProvider, tag: string | null, body: ReactNode) => {
    const key = keyProvider(provider);
    const hasKey = !!(key && providerApiKeys[key]?.trim());
    const state = catalog[provider];
    const { line, badge } = describe(provider, state, hasKey);
    const action = actionFor(provider, state) ?? (badge && <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.className}`}>{badge.text}</span>);
    return (
      <AccordionItem key={provider} value={provider} id={`provider-${provider}`} className="scroll-mt-24">
        <AccordionTrigger className="py-3 hover:no-underline" actions={<div className="flex w-60 shrink-0 justify-end">{action}</div>}>
          <span className="flex min-w-0 flex-1 items-center gap-3">
            <span className="w-28 shrink-0 font-medium text-gray-900">{catalogLabel(provider)}</span>
            {tag && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-normal text-gray-600">{tag}</span>}
            <span className="min-w-0 flex-1 truncate text-xs font-normal text-gray-500" title={line}>{line}</span>
          </span>
        </AccordionTrigger>
        <AccordionContent className="px-1 pt-1 pb-4">{body}</AccordionContent>
      </AccordionItem>
    );
  };

  const keyCard = (provider: CloudProvider) => {
    const inUseBy = [
      ai.provider === provider && 'summaries and the assistant',
      voice.provider === speechTwin(provider) && 'the voice transcript',
    ].filter((use): use is string => !!use);
    return <CloudKeyCard provider={provider} inUseBy={inUseBy} />;
  };

  const cloudRows = (provider: CloudProvider) => {
    const speech = speechTwin(provider);
    if (!speech) return row(provider, null, keyCard(provider));
    return [row(provider, 'Text', keyCard(provider)), row(speech, 'Speech', keyCard(provider))];
  };

  return (
    <div className="space-y-5">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">On this device</h4>
        <p className="mb-1 text-xs text-gray-500">Runs on your computer. Nothing leaves it.</p>
        <Accordion type="single" collapsible value={open} onValueChange={onOpenChange}>
          {row('parakeet', 'Speech', <ParakeetModelManager onModelsChange={() => refresh(['parakeet'])} />)}
          {row('localWhisper', 'Speech', <WhisperModelManager onModelsChange={() => refresh(['localWhisper'])} />)}
          {row('builtin-ai', 'Text', <BuiltInModelManager onModelsChange={() => refresh(['builtin-ai'])} />)}
        </Accordion>
      </div>
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">AI services</h4>
        <p className="mb-1 text-xs text-gray-500">Needs a server or internet. Speech models get your audio, the others get your transcript.</p>
        <Accordion type="single" collapsible value={open} onValueChange={onOpenChange}>
          {row('ollama', null, <OllamaCard state={catalog.ollama} onChanged={() => refresh(['ollama'])} />)}
          {CLOUD_PROVIDERS.map(cloudRows)}
          {row('custom-openai', null, <CustomServerCard onSaved={onCustomServerSaved} />)}
          {CLI_AGENTS.map((provider) => row(provider, null, <CliAgentCard provider={provider} state={catalog[provider]} onRecheck={() => refresh([provider])} />))}
        </Accordion>
      </div>
    </div>
  );
}
