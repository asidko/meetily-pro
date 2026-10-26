import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { assistantService } from '@/services/assistantService';
import type { ChatContext, ChatMessage, MeetingChat } from '@/lib/live-assistant';

const ANSWER_POLL_MS = 2000;

export function useMeetingChat(meetingId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [context, setContext] = useState<ChatContext | null>(null);
  const [asking, setAsking] = useState(false);
  const [answeringElsewhere, setAnsweringElsewhere] = useState(false);
  const currentMeeting = useRef(meetingId);
  currentMeeting.current = meetingId;

  const apply = useCallback((chat: MeetingChat) => {
    setMessages(chat.messages);
    setContext(chat.context);
  }, []);

  const load = useCallback(async (id: string) => {
    try {
      const chat = await assistantService.getMeetingChat(id);
      if (currentMeeting.current !== id) return;
      apply(chat);
      setAnsweringElsewhere(chat.answering);
    } catch (error) {
      console.warn('Failed to load meeting chat:', error);
    }
  }, [apply]);

  useEffect(() => {
    setMessages([]);
    setContext(null);
    setAsking(false);
    setAnsweringElsewhere(false);
    void load(meetingId);
  }, [meetingId, load]);

  useEffect(() => {
    if (!answeringElsewhere) return;
    const timer = setInterval(() => void load(meetingId), ANSWER_POLL_MS);
    return () => clearInterval(timer);
  }, [answeringElsewhere, meetingId, load]);

  const run = useCallback(async (request: () => Promise<MeetingChat>, failure: string, pending?: ChatMessage): Promise<boolean> => {
    const id = meetingId;
    if (pending) setMessages((previous) => [...previous, pending]);
    setAsking(true);
    try {
      const chat = await request();
      if (currentMeeting.current === id) apply(chat);
      return true;
    } catch (error) {
      if (currentMeeting.current === id) {
        if (pending) setMessages((previous) => previous.filter((message) => message !== pending));
        toast.error(failure, { description: String(error) });
      }
      return false;
    } finally {
      if (currentMeeting.current === id) setAsking(false);
    }
  }, [meetingId, apply]);

  const ask = useCallback((question: string) => run(
    () => assistantService.askAboutMeeting(meetingId, question),
    'Could not send the question',
    { id: 'pending', role: 'user', text: question, error: false },
  ), [meetingId, run]);

  const compact = useCallback(async () => {
    await run(() => assistantService.compactMeetingChat(meetingId), 'Could not compact the chat');
  }, [meetingId, run]);

  const reload = useCallback(() => load(meetingId), [load, meetingId]);

  const editKeyTerms = useCallback(async (keyTerms: string) => {
    const id = meetingId;
    try {
      const saved = await assistantService.updateMeetingKeyTerms(id, keyTerms);
      if (currentMeeting.current === id) {
        setMessages((previous) => previous.map((message) => (message.role === 'key_terms' ? { ...message, text: saved } : message)));
      }
      return true;
    } catch (error) {
      if (currentMeeting.current === id) toast.error('Could not save the key terms', { description: String(error) });
      return false;
    }
  }, [meetingId]);

  const dismissError = useCallback(async (messageId: string) => {
    try {
      await assistantService.dismissMeetingChatError(meetingId, messageId);
      setMessages((previous) => previous.filter((message) => message.id !== messageId));
    } catch (error) {
      toast.error('Could not remove the message', { description: String(error) });
    }
  }, [meetingId]);

  return { messages, context, answering: asking || answeringElsewhere, ask, compact, reload, dismissError, editKeyTerms };
}
