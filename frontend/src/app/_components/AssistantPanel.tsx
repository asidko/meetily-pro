'use client';

import { memo, useCallback, useEffect, useState } from 'react';
import { Pause, Play, RefreshCw, Sparkles, ChevronRight, ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useLiveAssistant } from '@/hooks/useLiveAssistant';
import { catalogLabel } from '@/lib/model-catalog';
import { chatTimeline, describeAge, suggestionQuestion } from '@/lib/live-assistant';
import { assistantService } from '@/services/assistantService';
import { ChatInput, ChatThread, ErrorNote } from '@/components/AssistantChat';
import { SuggestionCard } from '@/components/SuggestionCard';

interface AssistantPanelProps {
  open: boolean;
  isRecording: boolean;
  onToggle: () => void;
}

function NextTickBar({ initial, generating, local }: { initial: number; generating: boolean; local: boolean }) {
  const [progress, setProgress] = useState(initial);

  useEffect(() => {
    setProgress(initial);
  }, [initial]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    assistantService.onProgress(setProgress).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    assistantService.getState().then((current) => {
      if (!cancelled) setProgress(current.progress);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  let label = `Next tip ${progress}%`;
  if (generating) label = local ? 'Thinking... the transcript catches up after' : 'Thinking...';
  else if (progress >= 100) label = 'Waiting for a pause in speech';

  return (
    <div className="space-y-1" title="Fills as the conversation gives the assistant enough to work with">
      <Progress value={generating ? 100 : progress} className={`h-1.5 ${generating ? 'animate-pulse' : ''}`} />
      <div className="text-[11px] text-gray-500">{label}</div>
    </div>
  );
}

export const AssistantPanel = memo(function AssistantPanel({ open, isRecording, onToggle }: AssistantPanelProps) {
  const { state, pin, dismiss, refresh, setPaused, ask, compact, start } = useLiveAssistant();
  const suggestions = state.suggestions;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [, setClock] = useState(0);
  const [errorHidden, setErrorHidden] = useState(false);
  const [hiddenChat, setHiddenChat] = useState<ReadonlySet<string>>(() => new Set());
  const chatLength = state.chat.length;

  useEffect(() => {
    setErrorHidden(false);
  }, [state.error]);

  useEffect(() => {
    if (chatLength === 0) setHiddenChat(new Set());
  }, [chatLength]);

  const hideChatError = useCallback((id: string) => {
    setHiddenChat((previous) => new Set(previous).add(id));
  }, []);

  useEffect(() => {
    if (!open) return;
    assistantService.getSettings().then((settings) => setEnabled(settings.enabled)).catch(() => setEnabled(null));
  }, [open, state.active]);

  useEffect(() => {
    if (!open) return;
    const interval = setInterval(() => setClock((n) => n + 1), 10_000);
    return () => clearInterval(interval);
  }, [open]);

  const openCount = suggestions.filter((item) => !item.dismissed).length;

  if (!open) {
    return (
      <div className="w-10 border-l border-gray-200 bg-white flex flex-col items-center pt-3">
        <button type="button" onClick={onToggle} className="p-2 rounded-md text-gray-500 hover:bg-gray-100" title="Show assistant">
          <Sparkles size={18} className={state.active ? 'text-blue-600' : undefined} />
        </button>
        {openCount > 0 && <span className="mt-1 text-[10px] font-semibold text-blue-600">{openCount}</span>}
        <button type="button" onClick={onToggle} className="mt-auto mb-3 p-2 text-gray-400 hover:text-gray-700" title="Expand">
          <ChevronLeft size={16} />
        </button>
      </div>
    );
  }

  const slots = chatTimeline(suggestions, state.chat.length);
  const visible = slots.flat();
  const age = describeAge(state.last_tick_at);
  const generating = state.status === 'generating';
  const paused = state.status === 'paused';
  const errored = state.status === 'error';

  const canChat = state.active && !state.chat_pending;

  let emptyMessage: string | null = null;
  if (visible.length === 0) {
    if (!state.active && enabled === false) emptyMessage = 'Turn on the live assistant in Settings, Models.';
    else if (!state.active && !isRecording) emptyMessage = 'Suggestions appear here while you record.';
    else if (!state.active) emptyMessage = 'Assistant is not running for this recording.';
    else if (paused) emptyMessage = 'Paused. Press play to resume suggestions.';
    else if (errored) emptyMessage = 'Suggestions stopped after an error.';
    else emptyMessage = generating ? 'Reading the conversation...' : 'Listening. Suggestions arrive after enough has been said.';
  }

  return (
    <div className="w-[320px] shrink-0 border-l border-gray-200 bg-white flex flex-col h-full">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 px-3">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-blue-600" />
          <span className="font-semibold text-sm text-gray-800">Assistant</span>
          {state.active && (
            <span className={`inline-block w-2 h-2 rounded-full ${generating ? 'bg-blue-500 animate-pulse' : paused || errored ? 'bg-orange-400' : 'bg-green-500'}`} />
          )}
        </div>
        <div className="flex items-center gap-1">
          {state.active && (
            <>
              <Button variant="ghost" size="sm" className="h-7 px-2" onClick={refresh} title="Suggest now" disabled={generating}>
                <RefreshCw size={14} className={generating ? 'animate-spin' : undefined} />
              </Button>
              <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setPaused(!paused && !errored)} title={paused || errored ? 'Resume' : 'Pause'}>
                {paused || errored ? <Play size={14} /> : <Pause size={14} />}
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onToggle} title="Collapse">
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>
      {(state.active || (state.error && !errorHidden)) && (
        <div className="p-3 border-b border-gray-200 space-y-2">
          {state.active && (
            <div className="flex items-center justify-between text-[11px]">
              <span className={`px-1.5 py-0.5 rounded ${state.is_cloud ? 'bg-orange-50 text-orange-700' : 'bg-green-50 text-green-700'}`} title={`${state.provider} / ${state.model}`}>
                {state.is_cloud ? `Sending to ${catalogLabel(state.provider)}` : 'On device'}
              </span>
              <span className={age.stale ? 'text-orange-600' : 'text-gray-500'}>{age.label}</span>
            </div>
          )}
          {state.active && !paused && !errored && <NextTickBar initial={state.progress} generating={generating} local={!state.is_cloud} />}
          {state.error && !errorHidden && (
            <ErrorNote className="text-xs" onClose={() => setErrorHidden(true)}>
              {state.error}{' '}
              <button type="button" className="underline" onClick={refresh}>Retry</button>
            </ErrorNote>
          )}
        </div>
      )}
      <ChatThread
        messages={state.chat}
        pending={state.chat_pending}
        followKey={visible[visible.length - 1]?.id}
        lead={emptyMessage && (
          <div className="text-xs text-gray-500 text-center pt-2 px-2">
            <p>{emptyMessage}</p>
            {enabled !== false && isRecording && !state.active && (
              <Button variant="outline" size="sm" className="mt-3" onClick={start}>Start assistant</Button>
            )}
          </div>
        )}
        emptyHint={state.active ? 'Ask anything about the conversation. Click a suggestion to ask about it.' : undefined}
        hidden={hiddenChat}
        onDismissError={hideChatError}
        after={(count) => slots[count]?.map((item) => (
          <SuggestionCard
            key={item.id}
            item={item}
            onPin={(pinned) => pin(item.id, pinned)}
            onDismiss={() => dismiss(item.id)}
            onAsk={canChat ? () => ask(suggestionQuestion(item)) : undefined}
          />
        ))}
      />
      <ChatInput placeholder={state.active ? 'Ask the assistant' : 'Start recording to chat'} disabled={!state.active} canSend={canChat} onSend={ask} context={state.chat_context} onCompact={compact} />
    </div>
  );
});
