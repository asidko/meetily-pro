import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { LiveAssistantState, Suggestion } from '../../src/lib/live-assistant';

const originalCore = { ...await import('@tauri-apps/api/core') };
const originalEvent = { ...await import('@tauri-apps/api/event') };
const originalToast = { ...await import('sonner') };
afterAll(() => {
  mock.module('@tauri-apps/api/core', () => originalCore);
  mock.module('@tauri-apps/api/event', () => originalEvent);
  mock.module('sonner', () => originalToast);
});

type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Listener[]>();
const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
let backendState: LiveAssistantState;
let stateGate: Promise<void> | null = null;

const suggestion = (id: string, overrides: Partial<Suggestion> = {}): Suggestion => ({
  id, kind: 'question', text: `Ask ${id}`, why: '', at_seconds: 5, sequence_id: 1, pinned: false, dismissed: false, ...overrides,
});

const invoke = mock(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
  calls.push({ command, args });
  if (command === 'get_live_assistant_state') {
    const snapshot = backendState;
    if (stateGate) await stateGate;
    return snapshot;
  }
  if (command === 'update_live_suggestion') {
    backendState.suggestions = backendState.suggestions.map((item) => item.id === args?.id
      ? { ...item, pinned: (args?.pinned as boolean | null) ?? item.pinned, dismissed: (args?.dismissed as boolean | null) ?? item.dismissed }
      : item);
    return null;
  }
  if (command === 'refresh_live_assistant' || command === 'pause_live_assistant' || command === 'ask_live_assistant' || command === 'start_live_assistant') return null;
  throw new Error(`Unexpected command: ${command}`);
});
mock.module('@tauri-apps/api/core', () => ({ invoke }));
mock.module('@tauri-apps/api/event', () => ({
  listen: async (name: string, callback: Listener) => {
    listeners.set(name, [...(listeners.get(name) ?? []), callback]);
    return () => listeners.set(name, (listeners.get(name) ?? []).filter((l) => l !== callback));
  },
}));
const notify = mock(() => {});
mock.module('sonner', () => ({ toast: { info: notify, error: notify, success: notify, warning: notify } }));

const { useLiveAssistant } = await import('../../src/hooks/useLiveAssistant');

let hook: ReturnType<typeof useLiveAssistant>;
let renderer: ReactTestRenderer | undefined;
function View() {
  hook = useLiveAssistant();
  return null;
}
async function mount() {
  await act(async () => { renderer = create(<View />); });
  await act(async () => {});
}
function emit(name: string, payload: unknown) {
  (listeners.get(name) ?? []).forEach((listener) => listener({ payload }));
}
const idle = (): LiveAssistantState => ({
  active: false, status: 'idle', provider: '', model: '', is_cloud: false, last_tick_at: null, last_tick_added: null, cards_full: false,
  error: null, tick_no: 0, progress: 0, state: '', suggestions: [], chat: [], chat_pending: false, chat_context: null,
});

beforeEach(() => {
  listeners.clear();
  calls.length = 0;
  invoke.mockClear();
  notify.mockClear();
  backendState = idle();
  stateGate = null;
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
});

describe('useLiveAssistant', () => {
  test('resyncs from the backend on mount so a reload keeps suggestions', async () => {
    backendState = { ...idle(), active: true, status: 'waiting', suggestions: [suggestion('s1')] };
    await mount();
    expect(hook.state.active).toBe(true);
    expect(hook.state.suggestions.map((s) => s.id)).toEqual(['s1']);
    expect(calls[0].command).toBe('get_live_assistant_state');
  });

  test('applies status events including the suggestion list', async () => {
    await mount();
    await act(async () => { emit('assistant-status', { ...idle(), active: true, status: 'generating' }); });
    expect(hook.state.status).toBe('generating');
    await act(async () => { emit('assistant-status', { ...idle(), active: true, status: 'waiting', tick_no: 1, suggestions: [suggestion('s1'), suggestion('s2')] }); });
    expect(hook.state.suggestions).toHaveLength(2);
    expect(hook.state.tick_no).toBe(1);
  });

  test('a new session clears suggestions left from the previous recording', async () => {
    backendState = { ...idle(), suggestions: [suggestion('old')] };
    await mount();
    expect(hook.state.suggestions.map((s) => s.id)).toEqual(['old']);
    await act(async () => { emit('assistant-status', { ...idle(), active: true, status: 'waiting', tick_no: 0 }); });
    expect(hook.state.suggestions).toEqual([]);
  });

  test('status events carry the progress so a remount starts from the current fill', async () => {
    backendState = { ...idle(), active: true, status: 'waiting', progress: 42 };
    await mount();
    expect(hook.state.progress).toBe(42);
    await act(async () => { emit('assistant-status', { ...idle(), active: true, status: 'waiting', tick_no: 1, progress: 0 }); });
    expect(hook.state.progress).toBe(0);
  });

  test('ask sends the question and the chat arrives through status events', async () => {
    backendState = { ...idle(), active: true, status: 'waiting' };
    await mount();
    let sent = false;
    await act(async () => { sent = await hook.ask('Who owns the migration?'); });
    expect(sent).toBe(true);
    expect(calls.find((c) => c.command === 'ask_live_assistant')?.args).toEqual({ question: 'Who owns the migration?' });
    const chat = [
      { id: 'c1', role: 'user' as const, text: 'Who owns the migration?', error: false },
      { id: 'c2', role: 'assistant' as const, text: 'Nobody yet [01:00].', error: false },
    ];
    await act(async () => { emit('assistant-status', { ...idle(), active: true, status: 'waiting', chat }); });
    expect(hook.state.chat.map((m) => m.id)).toEqual(['c1', 'c2']);
    expect(hook.state.chat_pending).toBe(false);
  });

  test('dismiss and pin update locally before the backend confirms', async () => {
    backendState = { ...idle(), active: true, status: 'waiting', suggestions: [suggestion('s1'), suggestion('s2')] };
    await mount();
    await act(async () => { await hook.dismiss('s1'); });
    expect(hook.state.suggestions.find((s) => s.id === 's1')?.dismissed).toBe(true);
    expect(calls.some((c) => c.command === 'update_live_suggestion' && c.args?.id === 's1' && c.args?.dismissed === true)).toBe(true);
    await act(async () => { await hook.pin('s2', true); });
    expect(hook.state.suggestions.find((s) => s.id === 's2')?.pinned).toBe(true);
  });

  test('refresh resumes a paused or errored session before asking for a tick', async () => {
    backendState = { ...idle(), active: true, status: 'error', error: 'boom' };
    await mount();
    await act(async () => { await hook.refresh(); });
    const commands = calls.map((c) => c.command);
    expect(commands.indexOf('pause_live_assistant')).toBeLessThan(commands.indexOf('refresh_live_assistant'));
    expect(calls.find((c) => c.command === 'pause_live_assistant')?.args).toEqual({ paused: false });
  });

  test('a slow snapshot does not overwrite a newer status event', async () => {
    let release = () => {};
    stateGate = new Promise<void>((resolve) => { release = resolve; });
    backendState = { ...idle(), active: true, status: 'generating', tick_no: 1 };
    await act(async () => { renderer = create(<View />); });
    await act(async () => { emit('assistant-status', { ...idle(), active: true, status: 'waiting', tick_no: 2 }); });
    await act(async () => { release(); });
    expect(hook.state.tick_no).toBe(2);
    expect(hook.state.status).toBe('waiting');
  });

  test('errors surface once as a toast', async () => {
    await mount();
    await act(async () => { emit('assistant-error', { message: 'Confirm sending first' }); });
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
