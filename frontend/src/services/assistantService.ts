import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import type { AssistantSettings, LiveAssistantState, MeetingChat, Suggestion } from '@/lib/live-assistant';

export interface AssistantErrorEvent {
  message: string | null;
}

export class AssistantService {
  async start(): Promise<void> {
    return invoke('start_live_assistant');
  }

  async ask(question: string): Promise<void> {
    return invoke('ask_live_assistant', { question });
  }

  async compact(): Promise<void> {
    return invoke('compact_live_assistant');
  }

  async refresh(): Promise<void> {
    return invoke('refresh_live_assistant');
  }

  async setPaused(paused: boolean): Promise<void> {
    return invoke('pause_live_assistant', { paused });
  }

  async updateSuggestion(id: string, changes: { pinned?: boolean; dismissed?: boolean }): Promise<void> {
    return invoke('update_live_suggestion', {
      id,
      pinned: changes.pinned ?? null,
      dismissed: changes.dismissed ?? null,
    });
  }

  async getState(): Promise<LiveAssistantState> {
    return invoke<LiveAssistantState>('get_live_assistant_state');
  }

  async getSettings(): Promise<AssistantSettings> {
    return invoke<AssistantSettings>('api_get_assistant_settings');
  }

  async saveSettings(settings: AssistantSettings): Promise<void> {
    return invoke('api_save_assistant_settings', { settings });
  }

  async getMeetingSuggestions(meetingId: string): Promise<Suggestion[]> {
    return invoke<Suggestion[]>('api_get_meeting_suggestions', { meetingId });
  }

  async dismissMeetingSuggestion(meetingId: string, id: string): Promise<void> {
    return invoke('api_dismiss_meeting_suggestion', { meetingId, id });
  }

  async saveMeetingAssistant(meetingId: string): Promise<void> {
    return invoke('api_save_meeting_assistant', { meetingId });
  }

  async importSnapshot(meetingId: string, folder: string): Promise<void> {
    return invoke('api_import_assistant_snapshot', { meetingId, folder });
  }

  async getMeetingChat(meetingId: string): Promise<MeetingChat> {
    return invoke<MeetingChat>('api_get_meeting_chat', { meetingId });
  }

  async askAboutMeeting(meetingId: string, question: string): Promise<MeetingChat> {
    return invoke<MeetingChat>('api_ask_meeting_assistant', { meetingId, question });
  }

  async compactMeetingChat(meetingId: string): Promise<MeetingChat> {
    return invoke<MeetingChat>('api_compact_meeting_chat', { meetingId });
  }

  async dismissMeetingChatError(meetingId: string, messageId: string): Promise<void> {
    return invoke('api_dismiss_meeting_chat_error', { meetingId, messageId });
  }

  async onStatus(callback: (state: LiveAssistantState) => void): Promise<UnlistenFn> {
    return listen<LiveAssistantState>('assistant-status', (event) => callback(event.payload));
  }

  async onProgress(callback: (progress: number) => void): Promise<UnlistenFn> {
    return listen<{ progress: number }>('assistant-progress', (event) => callback(event.payload.progress));
  }

  async onError(callback: (event: AssistantErrorEvent) => void): Promise<UnlistenFn> {
    return listen<AssistantErrorEvent>('assistant-error', (event) => callback(event.payload));
  }
}

export const assistantService = new AssistantService();
