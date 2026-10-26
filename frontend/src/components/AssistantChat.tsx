'use client';

import { Fragment, memo, useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Pencil, Send, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { COMPACT_FROM_PERCENT, contextPercent, splitCitations, type ChatContext, type ChatMessage } from '@/lib/live-assistant';
import { SCROLL_TO_SEGMENT_EVENT, SegmentEditor } from '@/components/VirtualizedTranscriptView';
import { useAutoHeight } from '@/hooks/useAutoHeight';

function scrollToSegment(atSeconds: number) {
  window.dispatchEvent(new CustomEvent(SCROLL_TO_SEGMENT_EVENT, { detail: { atSeconds } }));
}

export function ClockLink({ seconds, label, className }: { seconds: number; label: string; className: string }) {
  return (
    <button type="button" className={`font-mono ${className}`} onClick={() => scrollToSegment(seconds)} title="Show in transcript">
      {label}
    </button>
  );
}

function CitedText({ text }: { text: string }) {
  return (
    <>
      {splitCitations(text).map((part, index) => ('clock' in part ? (
        <ClockLink key={index} seconds={part.seconds} label={`[${part.clock}]`} className="text-blue-600 hover:underline" />
      ) : (
        <span key={index}>{part.text}</span>
      )))}
    </>
  );
}

const REMARK_PLUGINS = [remarkGfm];

export function copyText(text: string) {
  navigator.clipboard?.writeText(text);
  toast.success('Copied');
}

function CopyButton({ text }: { text: string }) {
  return (
    <button
      type="button"
      className="absolute right-1 top-1 rounded p-1 text-gray-400 opacity-0 hover:text-gray-700 focus:opacity-100 group-hover:opacity-100"
      title="Copy"
      aria-label="Copy"
      onClick={() => copyText(text)}
    >
      <Copy size={12} />
    </button>
  );
}

export function ErrorNote({ children, onClose, className = 'text-sm' }: { children: ReactNode; onClose?: () => void; className?: string }) {
  return (
    <div role="alert" className={`relative rounded-lg bg-red-50 py-2 pl-3 pr-7 text-red-700 ${className}`}>
      <div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words">{children}</div>
      {onClose && (
        <button type="button" className="absolute right-1 top-1 rounded p-1 text-red-400 hover:text-red-700" title="Close" aria-label="Close" onClick={onClose}>
          <X size={12} />
        </button>
      )}
    </div>
  );
}

function KeyTermsNote({ text, onEdit }: { text: string; onEdit?: (text: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);

  const save = async (next: string) => {
    if (await onEdit?.(next)) setEditing(false);
  };

  if (editing) {
    return (
      <div className="rounded-lg border border-dashed border-blue-100 px-2 py-1.5">
        <SegmentEditor initialText={text} onSave={save} onCancel={() => setEditing(false)} textClassName="text-xs md:text-xs" />
      </div>
    );
  }
  return (
    <div className="group relative rounded-lg border border-dashed border-blue-100 py-1.5 pl-3 pr-7 text-xs text-gray-600">
      <span className="font-medium text-gray-700">Topic and key terms: </span>{text}
      {onEdit && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="absolute right-1 top-1 rounded-md p-1 text-gray-400 opacity-0 transition-opacity duration-150 hover:bg-blue-50 hover:text-blue-600 group-hover:opacity-100 focus-visible:opacity-100"
          aria-label="Edit topic and key terms"
          title="Edit topic and key terms"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

interface ChatBubbleProps {
  message: ChatMessage;
  onDismiss?: (id: string) => void;
  onEditKeyTerms?: (text: string) => Promise<boolean>;
}

const ChatBubble = memo(function ChatBubble({ message, onDismiss, onEditKeyTerms }: ChatBubbleProps) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] max-h-64 overflow-y-auto rounded-lg bg-blue-600 text-white px-3 py-2 text-sm whitespace-pre-wrap break-words">{message.text}</div>
      </div>
    );
  }
  if (message.role === 'summary') {
    return (
      <details className="rounded-lg border border-dashed border-gray-300 px-3 py-2 text-xs text-gray-500">
        <summary className="cursor-pointer select-none">Chat compacted. The assistant keeps this summary of the messages above.</summary>
        <div className="mt-2 text-sm text-gray-700 whitespace-pre-wrap"><CitedText text={message.text} /></div>
      </details>
    );
  }
  if (message.role === 'key_terms') return <KeyTermsNote text={message.text} onEdit={onEditKeyTerms} />;
  if (message.role === 'recap') {
    return (
      <div className="group relative rounded-lg border border-blue-100 bg-blue-50/70 py-2 pl-3 pr-7 text-sm text-gray-800">
        <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:mb-1 prose-headings:mt-2 prose-p:my-1 prose-ul:my-1 prose-li:my-0">
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{message.text}</ReactMarkdown>
        </div>
        <CopyButton text={message.text} />
      </div>
    );
  }
  if (message.error) {
    return (
      <ErrorNote className="max-w-[90%] text-sm" onClose={onDismiss && (() => onDismiss(message.id))}>
        <CitedText text={message.text} />
      </ErrorNote>
    );
  }
  return (
    <div className="group relative w-fit max-w-[90%] rounded-lg bg-gray-100 py-2 pl-3 pr-7 text-sm text-gray-800 whitespace-pre-wrap break-words">
      <CitedText text={message.text} />
      <CopyButton text={message.text} />
    </div>
  );
}, (previous, next) => (
  previous.message.id === next.message.id
  && previous.message.role === next.message.role
  && previous.message.text === next.message.text
  && previous.message.error === next.message.error
  && previous.onEditKeyTerms === next.onEditKeyTerms
));

interface ChatThreadProps {
  messages: ChatMessage[];
  pending: boolean;
  emptyHint?: string;
  lead?: ReactNode;
  trail?: ReactNode;
  after?: (count: number) => ReactNode;
  followKey?: string | number;
  hidden?: ReadonlySet<string>;
  onDismissError?: (id: string) => void;
  onEditKeyTerms?: (text: string) => Promise<boolean>;
}

export function ChatThread({ messages, pending, emptyHint, lead, trail, after, followKey, hidden, onDismissError, onEditKeyTerms }: ChatThreadProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messages.length === 0 && !pending && !followKey) return;
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, pending, followKey]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
      {lead}
      {emptyHint && messages.length === 0 && !pending && <p className="text-xs text-gray-500 text-center pt-2 px-2">{emptyHint}</p>}
      {after?.(0)}
      {messages.map((message, index) => (
        <Fragment key={message.id}>
          {!hidden?.has(message.id) && <ChatBubble message={message} onDismiss={onDismissError} onEditKeyTerms={onEditKeyTerms} />}
          {after?.(index + 1)}
        </Fragment>
      ))}
      {trail}
      {pending && <div className="w-fit rounded-lg bg-gray-100 text-gray-500 px-3 py-2 text-sm animate-pulse">Thinking...</div>}
      <div ref={endRef} />
    </div>
  );
}

function Speedometer({ percent }: { percent: number }) {
  const shown = Math.min(percent, 100);
  const angle = Math.PI * (1 - shown / 100);
  const color = percent >= 80 ? 'text-red-500' : percent >= COMPACT_FROM_PERCENT ? 'text-amber-500' : 'text-green-500';
  return (
    <svg width="28" height="16" viewBox="0 0 28 16" className={color} aria-hidden>
      <path d="M4 14 A10 10 0 0 1 24 14" fill="none" strokeWidth="3" strokeLinecap="round" className="stroke-gray-200" />
      <path d="M4 14 A10 10 0 0 1 24 14" fill="none" strokeWidth="3" strokeLinecap="round" stroke="currentColor" pathLength={100} strokeDasharray={`${shown} 100`} />
      <line x1="14" y1="14" x2={14 + 8 * Math.cos(angle)} y2={14 - 8 * Math.sin(angle)} strokeWidth="1.5" strokeLinecap="round" className="stroke-gray-700" />
      <circle cx="14" cy="14" r="1.5" className="fill-gray-700" />
    </svg>
  );
}

interface ContextMeterProps {
  context: ChatContext;
  busy: boolean;
  onCompact: () => void;
}

function ContextMeter({ context, busy, onCompact }: ContextMeterProps) {
  const percent = contextPercent(context);
  const title = percent > 100
    ? `Chat memory ${percent}% full: the oldest messages are forgotten. Compact keeps their gist.`
    : `Chat memory ${percent}% full`;
  return (
    <div className="flex h-9 w-12 shrink-0 flex-col items-center justify-center gap-0.5" title={title}>
      <span className="sr-only">{title}</span>
      <Speedometer percent={percent} />
      {percent >= COMPACT_FROM_PERCENT ? (
        <button
          type="button"
          className="text-[10px] font-medium leading-none text-blue-600 enabled:hover:underline disabled:opacity-50"
          disabled={busy}
          onClick={onCompact}
          title="Replace the chat so far with a short summary the assistant keeps"
        >
          Compact
        </button>
      ) : (
        <span className="text-[10px] leading-none text-gray-500">{percent}%</span>
      )}
    </div>
  );
}

export interface ChatComposer {
  canSend: boolean;
  disabled: boolean;
  queue: string[];
  returned: string;
  clearReturned: () => void;
  submit: (text: string) => Promise<void>;
  unqueue: (index: number) => string;
  drainQueue: () => string[];
}

export function useChatComposer(onSend: (question: string) => Promise<boolean>, canSend: boolean, disabled: boolean, initialQueue: () => string[] = () => []): ChatComposer {
  const [queue, setQueue] = useState<string[]>(initialQueue);
  const [returned, setReturned] = useState('');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);

  const send = useCallback(async (text: string) => {
    sendingRef.current = true;
    setSending(true);
    try {
      if (!(await onSend(text))) setReturned((current) => (current ? `${text}\n\n${current}` : text));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [onSend]);

  useEffect(() => {
    if (!canSend || disabled || sending || sendingRef.current || queue.length === 0) return;
    const text = queue.join('\n\n');
    setQueue([]);
    void send(text);
  }, [canSend, disabled, sending, queue, send]);

  const submit = useCallback(async (text: string) => {
    if (canSend && !sendingRef.current && queue.length === 0) await send(text);
    else setQueue((current) => [...current, text]);
  }, [canSend, queue.length, send]);

  const unqueue = useCallback((index: number) => {
    setQueue((current) => current.filter((_, i) => i !== index));
    return queue[index];
  }, [queue]);

  const drainQueue = useCallback(() => {
    setQueue([]);
    return queue;
  }, [queue]);

  const clearReturned = useCallback(() => setReturned(''), []);

  return { canSend, disabled, queue, returned, clearReturned, submit, unqueue, drainQueue };
}

interface ChatInputProps {
  placeholder: string;
  composer: ChatComposer;
  context?: ChatContext | null;
  onCompact?: () => void;
}

const MAX_INPUT_HEIGHT = 160;

export function ChatInput({ placeholder, composer, context, onCompact }: ChatInputProps) {
  const { canSend, disabled, queue, returned, clearReturned } = composer;
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useAutoHeight(inputRef, draft, MAX_INPUT_HEIGHT);

  useEffect(() => {
    if (!returned) return;
    setDraft((current) => (current.trim() ? `${returned}\n\n${current}` : returned));
    clearReturned();
  }, [returned, clearReturned]);

  const unqueue = (index: number) => {
    const text = composer.unqueue(index);
    setDraft((current) => (current.trim() ? `${current}\n\n${text}` : text));
    inputRef.current?.focus();
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || disabled) return;
    setDraft('');
    await composer.submit(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  return (
    <form onSubmit={submit} className="p-3 border-t border-gray-200">
      {queue.length > 0 && (
        <div className="mb-2 space-y-1">
          {queue.map((text, index) => (
            <div key={index} className="group flex items-start gap-2 rounded-md border border-dashed border-gray-300 px-2 py-1 text-xs text-gray-600">
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{text}</span>
              <span className="shrink-0 text-[10px] text-gray-400">Queued</span>
              <button
                type="button"
                onClick={() => unqueue(index)}
                className="shrink-0 text-gray-400 hover:text-gray-700"
                title="Back to the input"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        {context && context.used > 0 && onCompact && <ContextMeter context={context} busy={!canSend} onCompact={onCompact} />}
        <Textarea
          ref={inputRef}
          rows={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          className="min-h-9 resize-none py-2 text-sm"
          style={{ maxHeight: MAX_INPUT_HEIGHT }}
        />
        <Button
          type="submit"
          size="sm"
          className="h-9 px-3"
          disabled={disabled || !draft.trim()}
          title={canSend ? 'Send (Shift+Enter for a new line)' : 'Queue, sent together when the current answer arrives'}
        >
          <Send size={14} />
        </Button>
      </div>
    </form>
  );
}
