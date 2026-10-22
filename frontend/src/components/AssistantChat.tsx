'use client';

import { Fragment, memo, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Send, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { COMPACT_FROM_PERCENT, contextPercent, splitCitations, type ChatContext, type ChatMessage } from '@/lib/live-assistant';
import { SCROLL_TO_SEGMENT_EVENT } from '@/components/VirtualizedTranscriptView';
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

const ChatBubble = memo(function ChatBubble({ message, onDismiss }: { message: ChatMessage; onDismiss?: (id: string) => void }) {
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
  if (message.role === 'key_terms') {
    return (
      <div className="rounded-lg border border-dashed border-blue-100 px-3 py-1.5 text-xs text-gray-600">
        <span className="font-medium text-gray-700">Topic and key terms: </span>{message.text}
      </div>
    );
  }
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
}

export function ChatThread({ messages, pending, emptyHint, lead, trail, after, followKey, hidden, onDismissError }: ChatThreadProps) {
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
          {!hidden?.has(message.id) && <ChatBubble message={message} onDismiss={onDismissError} />}
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

interface ChatInputProps {
  placeholder: string;
  disabled: boolean;
  canSend: boolean;
  onSend: (question: string) => Promise<boolean>;
  context?: ChatContext | null;
  onCompact?: () => void;
}

const MAX_INPUT_HEIGHT = 160;

export function ChatInput({ placeholder, disabled, canSend, onSend, context, onCompact }: ChatInputProps) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useAutoHeight(inputRef, draft, MAX_INPUT_HEIGHT);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || !canSend) return;
    setDraft('');
    if (!(await onSend(text))) setDraft(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  return (
    <form onSubmit={submit} className="p-3 border-t border-gray-200">
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
        <Button type="submit" size="sm" className="h-9 px-3" disabled={!canSend || !draft.trim()} title="Send (Shift+Enter for a new line)">
          <Send size={14} />
        </Button>
      </div>
    </form>
  );
}
