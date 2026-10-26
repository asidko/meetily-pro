import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { assistantService } from '@/services/assistantService';
import type { LiveAssistantState, Suggestion } from '@/lib/live-assistant';

const EMPTY_STATE: LiveAssistantState = {
  active: false,
  status: 'idle',
  provider: '',
  model: '',
  is_cloud: false,
  last_tick_at: null,
  last_tick_added: null,
  cards_full: false,
  error: null,
  tick_no: 0,
  progress: 0,
  state: '',
  suggestions: [],
  chat: [],
  chat_pending: false,
  chat_context: null,
};

export function useLiveAssistant() {
  const [state, setState] = useState<LiveAssistantState>(EMPTY_STATE);
  const mountedRef = useRef(true);
  const eventCountRef = useRef(0);

  const applyState = useCallback((next: LiveAssistantState) => {
    if (mountedRef.current) setState(next);
  }, []);

  const applyEvent = useCallback((next: LiveAssistantState) => {
    eventCountRef.current += 1;
    applyState(next);
  }, [applyState]);

  const resync = useCallback(async () => {
    const eventsBefore = eventCountRef.current;
    try {
      const snapshot = await assistantService.getState();
      if (eventCountRef.current === eventsBefore) applyState(snapshot);
    } catch (error) {
      console.warn('Failed to load live assistant state:', error);
    }
  }, [applyState]);

  useEffect(() => {
    mountedRef.current = true;
    const unlisteners: Array<() => void> = [];
    let cancelled = false;

    (async () => {
      const unlistenStatus = await assistantService.onStatus(applyEvent);
      const unlistenError = await assistantService.onError((event) => {
        if (event.message) toast.error('Live assistant paused', { description: event.message });
      });
      if (cancelled) {
        unlistenStatus();
        unlistenError();
        return;
      }
      unlisteners.push(unlistenStatus, unlistenError);
    })();

    resync();

    return () => {
      mountedRef.current = false;
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [applyEvent, resync]);

  const patchLocal = useCallback((id: string, changes: Partial<Suggestion>) => {
    setState((prev) => ({
      ...prev,
      suggestions: prev.suggestions.map((item) => (item.id === id ? { ...item, ...changes } : item)),
    }));
  }, []);

  const pin = useCallback(async (id: string, pinned: boolean) => {
    patchLocal(id, pinned ? { pinned, dismissed: false } : { pinned });
    try {
      await assistantService.updateSuggestion(id, { pinned });
    } catch (error) {
      console.warn('Failed to pin suggestion:', error);
    }
  }, [patchLocal]);

  const dismiss = useCallback(async (id: string) => {
    patchLocal(id, { dismissed: true, pinned: false });
    try {
      await assistantService.updateSuggestion(id, { dismissed: true });
    } catch (error) {
      console.warn('Failed to dismiss suggestion:', error);
    }
  }, [patchLocal]);

  const refresh = useCallback(async () => {
    try {
      if (state.status === 'error' || state.status === 'paused') {
        await assistantService.setPaused(false);
      }
      await assistantService.refresh();
    } catch (error) {
      toast.error('Could not refresh suggestions', { description: String(error) });
    }
  }, [state.status]);

  const setPaused = useCallback(async (paused: boolean) => {
    try {
      await assistantService.setPaused(paused);
    } catch (error) {
      toast.error('Could not change assistant state', { description: String(error) });
    }
  }, []);

  const ask = useCallback(async (question: string) => {
    try {
      await assistantService.ask(question);
      return true;
    } catch (error) {
      toast.error('Could not ask the assistant', { description: String(error) });
      return false;
    }
  }, []);

  const compact = useCallback(async () => {
    try {
      await assistantService.compact();
    } catch (error) {
      toast.error('Could not compact the chat', { description: String(error) });
    }
  }, []);

  const start = useCallback(async () => {
    try {
      await assistantService.start();
      await resync();
    } catch (error) {
      toast.error('Could not start the live assistant', { description: String(error) });
    }
  }, [resync]);

  return { state, pin, dismiss, refresh, setPaused, ask, compact, start };
}
