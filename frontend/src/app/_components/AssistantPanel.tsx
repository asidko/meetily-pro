'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, RefreshCw, Sparkles, ChevronRight, ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useLiveAssistant } from '@/hooks/useLiveAssistant';
import { catalogLabel } from '@/lib/model-catalog';
import { carryQueue, chatTimeline, clampPanelWidth, describeAge, panelWidthCss, suggestionQuestion, writePanelWidth } from '@/lib/live-assistant';
import { assistantService } from '@/services/assistantService';
import { ChatInput, ChatThread, ErrorNote, useChatComposer } from '@/components/AssistantChat';
import { SuggestionCard } from '@/components/SuggestionCard';

interface AssistantPanelProps {
  open: boolean;
  isRecording: boolean;
  onToggle: () => void;
  width: number;
  onWidthChange: (width: number) => void;
}

interface NextTickBarProps {
  initial: number;
  generating: boolean;
  local: boolean;
  nothingNew: boolean;
  cardsFull: boolean;
  onSuggestNow: () => void;
}

function NextTickBar({ initial, generating, local, nothingNew, cardsFull, onSuggestNow }: NextTickBarProps) {
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
  else if (nothingNew && cardsFull) label = 'Cards full. Close one for new tips';
  else if (nothingNew) label = `Nothing new last check. Next tip ${progress}%`;

  return (
    <div className="space-y-1" title="Fills as the conversation gives the assistant enough to work with">
      <Progress value={generating ? 100 : progress} className={`h-1.5 ${generating ? 'animate-pulse' : ''}`} />
      <div className="flex items-center justify-between gap-2 text-[11px] text-gray-500">
        <span>{label}</span>
        {nothingNew && !cardsFull && !generating && (
          <button type="button" onClick={onSuggestNow} className="shrink-0 rounded px-1.5 py-0.5 font-medium text-blue-600 hover:bg-blue-50">
            Suggest now
          </button>
        )}
      </div>
    </div>
  );
}

export const AssistantPanel = memo(function AssistantPanel({ open, isRecording, onToggle, width, onWidthChange }: AssistantPanelProps) {
  const { state, pin, dismiss, refresh, setPaused, ask, compact, start } = useLiveAssistant();
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ right: number; width: number } | null>(null);
  const suggestions = state.suggestions;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [, setClock] = useState(0);
  const [errorHidden, setErrorHidden] = useState(false);
  const [hiddenChat, setHiddenChat] = useState<ReadonlySet<string>>(() => new Set());
  const chatLength = state.chat.length;
  const canChat = state.active && !state.chat_pending;
  const composer = useChatComposer(ask, canChat, !state.active);
  const { queue, drainQueue } = composer;

  useEffect(() => {
    if (!isRecording && queue.length > 0) carryQueue(drainQueue());
  }, [isRecording, queue, drainQueue]);

  useEffect(() => {
    setErrorHidden(false);
  }, [state.error]);

  useEffect(() => {
    if (chatLength === 0) setHiddenChat(new Set());
  }, [chatLength]);

  const hiddenMessages = useMemo(
    () => new Set([...hiddenChat, ...state.chat.filter((message) => message.cards_note).map((message) => message.id)]),
    [hiddenChat, state.chat],
  );

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

  const onResizeStart = useCallback((event: React.PointerEvent) => {
    if (!panelRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { right: panelRef.current.getBoundingClientRect().right, width: clampPanelWidth(width, window.innerWidth) };
    panelRef.current.parentElement?.setAttribute('data-resizing', '');
  }, [width]);

  const onResizeMove = useCallback((event: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current.width = clampPanelWidth(drag.current.right - event.clientX, window.innerWidth);
    panelRef.current?.parentElement?.style.setProperty('--assistant-width', panelWidthCss(drag.current.width));
  }, []);

  const onResizeEnd = useCallback(() => {
    if (!drag.current) return;
    const finalWidth = drag.current.width;
    drag.current = null;
    panelRef.current?.parentElement?.removeAttribute('data-resizing');
    onWidthChange(finalWidth);
    writePanelWidth(finalWidth);
  }, [onWidthChange]);

  const onResizeKey = useCallback((event: React.KeyboardEvent) => {
    const step = event.key === 'ArrowLeft' ? 32 : event.key === 'ArrowRight' ? -32 : 0;
    if (!step) return;
    event.preventDefault();
    const next = clampPanelWidth(width + step, window.innerWidth);
    onWidthChange(next);
    writePanelWidth(next);
  }, [width, onWidthChange]);

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
    <div ref={panelRef} className="relative w-[var(--assistant-width)] shrink-0 border-l border-gray-200 bg-white flex flex-col h-full">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize assistant"
        aria-valuenow={width}
        tabIndex={0}
        className="group absolute inset-y-0 left-0 z-10 flex w-2 cursor-col-resize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-inset"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onKeyDown={onResizeKey}
      >
        <div className="h-full w-px transition-[width,background-color] duration-150 ease-out group-hover:w-1 group-hover:bg-blue-400 group-active:w-1 group-active:bg-blue-500" />
      </div>
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
          {state.active && !paused && !errored && <NextTickBar initial={state.progress} generating={generating} local={!state.is_cloud} nothingNew={state.last_tick_added === 0} cardsFull={state.cards_full} onSuggestNow={refresh} />}
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
        hidden={hiddenMessages}
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
      <ChatInput placeholder={state.active ? 'Ask the assistant' : 'Start recording to chat'} composer={composer} context={state.chat_context} onCompact={compact} />
    </div>
  );
});
