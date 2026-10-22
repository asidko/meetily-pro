export type SuggestionKind = 'question' | 'tip';

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  text: string;
  why: string;
  at_seconds: number;
  sequence_id: number;
  pinned: boolean;
  dismissed: boolean;
  missed_ticks?: number;
  after_chat?: number | null;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'summary' | 'recap' | 'key_terms';
  text: string;
  error: boolean;
}

export interface ChatContext {
  used: number;
  limit: number;
}

export const COMPACT_FROM_PERCENT = 60;

export function contextPercent(context: ChatContext): number {
  return context.limit > 0 ? Math.round((context.used / context.limit) * 100) : 0;
}

export type AssistantStatus = 'idle' | 'waiting' | 'generating' | 'paused' | 'error';

export interface LiveAssistantState {
  active: boolean;
  status: AssistantStatus;
  provider: string;
  model: string;
  is_cloud: boolean;
  last_tick_at: string | null;
  error: string | null;
  tick_no: number;
  progress: number;
  state: string;
  suggestions: Suggestion[];
  chat: ChatMessage[];
  chat_pending: boolean;
  chat_context: ChatContext | null;
}

export interface MeetingChat {
  messages: ChatMessage[];
  answering: boolean;
  context: ChatContext | null;
}

export interface AssistantSettings {
  enabled: boolean;
}

export const KIND_META: Record<SuggestionKind, { label: string; badge: string; text: string }> = {
  question: { label: 'Ask', badge: 'bg-blue-50 text-blue-700', text: 'text-blue-700' },
  tip: { label: 'Tip', badge: 'bg-amber-50 text-amber-700', text: 'text-amber-700' },
};

const STALE_AFTER_MS = 3 * 60 * 1000;

const PANEL_OPEN_KEY = 'assistant_panel_open';

export function readPanelOpen(): boolean {
  try {
    return localStorage.getItem(PANEL_OPEN_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writePanelOpen(open: boolean): void {
  try {
    localStorage.setItem(PANEL_OPEN_KEY, String(open));
  } catch {
    return;
  }
}

function idNumber(id: string): number {
  const parsed = Number.parseInt(id.replace(/^s/, ''), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function suggestionQuestion(item: Suggestion): string {
  return item.kind === 'tip' ? `Tell me more about this tip and how it applies here: ${item.text}` : item.text;
}

export function sortSuggestions(items: Suggestion[]): Suggestion[] {
  const visible = items.filter((item) => !item.dismissed);
  const pinned = visible.filter((item) => item.pinned).sort((a, b) => idNumber(a.id) - idNumber(b.id));
  const rest = visible.filter((item) => !item.pinned).sort((a, b) => idNumber(b.id) - idNumber(a.id));
  return [...pinned, ...rest];
}

export function chatTimeline(items: Suggestion[], chatLength: number): Suggestion[][] {
  const slots: Suggestion[][] = Array.from({ length: chatLength + 1 }, () => []);
  items
    .filter((item) => !item.dismissed)
    .sort((a, b) => idNumber(a.id) - idNumber(b.id))
    .forEach((item) => slots[Math.min(item.after_chat ?? 0, chatLength)].push(item));
  return slots;
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = minutes.toString().padStart(2, '0');
  const ss = secs.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export type ChatPart = { text: string } | { clock: string; seconds: number };

const CITATION = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;

export function splitCitations(text: string): ChatPart[] {
  const parts: ChatPart[] = [];
  let last = 0;
  for (const match of text.matchAll(CITATION)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: text.slice(last, index) });
    const seconds = match[1].split(':').reduce((total, unit) => total * 60 + Number(unit), 0);
    parts.push({ clock: match[1], seconds });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export function describeAge(lastTickAt: string | null, now: number = Date.now()): { label: string; stale: boolean } {
  if (!lastTickAt) return { label: 'No suggestions yet', stale: false };
  const elapsed = now - new Date(lastTickAt).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return { label: 'Updated just now', stale: false };
  const stale = elapsed >= STALE_AFTER_MS;
  if (elapsed < 10_000) return { label: 'Updated just now', stale };
  if (elapsed < 60_000) return { label: `Updated ${Math.round(elapsed / 1000)} s ago`, stale };
  return { label: `Updated ${Math.round(elapsed / 60_000)} min ago`, stale };
}

export function buildPinnedPromptSection(items: Suggestion[]): string {
  const pinned = items.filter((item) => item.pinned && !item.dismissed);
  if (pinned.length === 0) return '';
  const lines = pinned.map((item) => `- [${formatClock(item.at_seconds)}] ${item.kind}: ${item.text}`);
  return `Pinned during the call by the user (give these extra attention):\n${lines.join('\n')}`;
}
