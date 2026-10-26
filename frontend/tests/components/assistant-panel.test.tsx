import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { LiveAssistantState, Suggestion } from '../../src/lib/live-assistant';

const originalHook = { ...await import('../../src/hooks/useLiveAssistant') };
const originalService = { ...await import('../../src/services/assistantService') };
afterAll(() => {
  mock.module('@/hooks/useLiveAssistant', () => originalHook);
  mock.module('@/services/assistantService', () => originalService);
});

const suggestion = (id: string): Suggestion => ({
  id, kind: id.endsWith('t') ? 'tip' : 'question', text: `Card ${id}`, why: '', at_seconds: 5, sequence_id: 1, pinned: false, dismissed: false,
});

let state: LiveAssistantState;
const noop = () => undefined;
mock.module('@/hooks/useLiveAssistant', () => ({
  useLiveAssistant: () => ({ state, pin: noop, dismiss: noop, refresh: noop, setPaused: noop, ask: async () => true, compact: noop, start: noop }),
}));
mock.module('@/services/assistantService', () => ({
  assistantService: {
    getSettings: async () => ({ enabled: true }),
    onProgress: async () => noop,
    getState: async () => state,
  },
}));

const { AssistantPanel } = await import('../../src/app/_components/AssistantPanel');

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
});

async function renderWith(suggestions: Suggestion[], cardsFull: boolean): Promise<string> {
  state = {
    active: true, status: 'waiting', provider: 'openai', model: 'test', is_cloud: true, last_tick_at: null, last_tick_added: 0, cards_full: cardsFull,
    error: null, tick_no: 2, progress: 10, state: '', suggestions, chat: [], chat_pending: false, chat_context: null,
  };
  await act(async () => {
    renderer = create(<AssistantPanel open isRecording onToggle={noop} width={320} onWidthChange={noop} />);
  });
  return JSON.stringify(renderer!.toJSON());
}

describe('AssistantPanel next tip bar', () => {
  test('after an empty check with room left it offers to suggest now', async () => {
    const page = await renderWith([suggestion('1q'), suggestion('2t')], false);
    expect(page).toContain('Nothing new last check');
    expect(page).toContain('"children":["Suggest now"]');
  });

  test('after an empty check with every card slot taken it asks to close a card instead', async () => {
    const page = await renderWith(['1q', '2q', '3q', '4t', '5t', '6t'].map(suggestion), true);
    expect(page).toContain('Cards full. Close one for new tips');
    expect(page).not.toContain('"children":["Suggest now"]');
  });
});
