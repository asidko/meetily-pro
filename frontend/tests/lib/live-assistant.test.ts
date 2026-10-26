import { describe, expect, test } from 'bun:test';
import {
  bindCarriedQueue,
  buildPinnedPromptSection,
  carryQueue,
  chatTimeline,
  clampPanelWidth,
  contextPercent,
  describeAge,
  formatClock,
  sortSuggestions,
  panelWidthCss,
  splitCitations,
  suggestionQuestion,
  takeCarriedQueue,
  type Suggestion,
} from '../../src/lib/live-assistant';

const item = (id: string, overrides: Partial<Suggestion> = {}): Suggestion => ({
  id,
  kind: 'question',
  text: `Suggestion ${id}`,
  why: '',
  at_seconds: 12,
  sequence_id: 1,
  pinned: false,
  dismissed: false,
  ...overrides,
});

describe('live assistant helpers', () => {
  test('splits chat answers into text and clickable citations', () => {
    expect(splitCitations('Owner unclear [01:00], deadline [1:02:03].')).toEqual([
      { text: 'Owner unclear ' },
      { clock: '01:00', seconds: 60 },
      { text: ', deadline ' },
      { clock: '1:02:03', seconds: 3723 },
      { text: '.' },
    ]);
    expect(splitCitations('No citations')).toEqual([{ text: 'No citations' }]);
  });

  test('asks about a tip in its own words and passes questions through', () => {
    expect(suggestionQuestion(item('s1', { text: 'Who owns the rollout?' }))).toBe('Who owns the rollout?');
    expect(suggestionQuestion(item('s2', { kind: 'tip', text: 'Rollups keep queries fast.' }))).toBe('Tell me more about this tip and how it applies here: Rollups keep queries fast.');
  });

  test('sorts pinned first, then newest, and hides dismissed', () => {
    const ordered = sortSuggestions([
      item('s1'),
      item('s2', { pinned: true }),
      item('s3', { dismissed: true }),
      item('s4'),
    ]);
    expect(ordered.map((s) => s.id)).toEqual(['s2', 's4', 's1']);
  });

  test('places tips after the chat message that came before them, oldest first', () => {
    const slots = chatTimeline([
      item('s3', { after_chat: 2 }),
      item('s1'),
      item('s2', { after_chat: 2 }),
      item('s4', { after_chat: 9 }),
      item('s5', { dismissed: true }),
    ], 2);
    expect(slots.map((slot) => slot.map((s) => s.id))).toEqual([['s1'], [], ['s2', 's3', 's4']]);
  });

  test('formats clock values', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(754.9)).toBe('12:34');
    expect(formatClock(3723)).toBe('1:02:03');
    expect(formatClock(-5)).toBe('00:00');
  });

  test('describes age and staleness', () => {
    const now = Date.parse('2026-10-12T10:00:00Z');
    expect(describeAge(null, now)).toEqual({ label: 'No suggestions yet', stale: false });
    expect(describeAge('2026-10-12T09:59:58Z', now)).toEqual({ label: 'Updated just now', stale: false });
    expect(describeAge('2026-10-12T09:59:20Z', now)).toEqual({ label: 'Updated 40 s ago', stale: false });
    expect(describeAge('2026-10-12T09:55:00Z', now)).toEqual({ label: 'Updated 5 min ago', stale: true });
  });

  test('builds the pinned section only from pinned, visible items', () => {
    expect(buildPinnedPromptSection([item('s1')])).toBe('');
    const section = buildPinnedPromptSection([
      item('s1', { pinned: true, at_seconds: 65, text: 'Who owns the migration?' }),
      item('s2', { pinned: true, dismissed: true }),
      item('s3', { pinned: true, kind: 'tip', at_seconds: 3, text: 'Confirm Friday' }),
    ]);
    expect(section).toBe('Pinned during the call by the user (give these extra attention):\n- [01:05] question: Who owns the migration?\n- [00:03] tip: Confirm Friday');
  });

  test('context percent rounds and survives an unknown limit', () => {
    expect(contextPercent({ used: 0, limit: 8000 })).toBe(0);
    expect(contextPercent({ used: 4100, limit: 8000 })).toBe(51);
    expect(contextPercent({ used: 12000, limit: 8000 })).toBe(150);
    expect(contextPercent({ used: 50, limit: 0 })).toBe(0);
  });

  test('keeps the assistant panel width between its minimum and 60% of the window', () => {
    expect(clampPanelWidth(500, 1600)).toBe(500);
    expect(clampPanelWidth(100, 1600)).toBe(280);
    expect(clampPanelWidth(1200, 1600)).toBe(960);
    expect(clampPanelWidth(400, 300)).toBe(280);
    expect(panelWidthCss(500)).toBe('min(500px, max(280px, 60vw))');
  });

  test('hands questions still queued at the end of a recording only to the meeting it was saved as, once', () => {
    carryQueue(['First question', 'Second question']);
    expect(takeCarriedQueue('m1')).toEqual([]);
    bindCarriedQueue('m1');
    expect(takeCarriedQueue('m2')).toEqual([]);
    expect(takeCarriedQueue('m1')).toEqual(['First question', 'Second question']);
    expect(takeCarriedQueue('m1')).toEqual([]);
  });

  test('hands the queue over whether the meeting is saved before or after the panel lets go of it', () => {
    bindCarriedQueue('m3');
    carryQueue(['Late question']);
    expect(takeCarriedQueue('m3')).toEqual(['Late question']);
  });
});
