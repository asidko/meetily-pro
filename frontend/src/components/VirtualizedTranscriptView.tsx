'use client';

import { useCallback, useRef, useReducer, startTransition, useEffect, useState, memo, KeyboardEvent } from "react";
import { Pencil } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useTranscriptStreaming } from "@/hooks/useTranscriptStreaming";
import { useAutoHeight } from "@/hooks/useAutoHeight";
import { ConfidenceIndicator } from "./ConfidenceIndicator";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { RecordingStatusBar } from "./RecordingStatusBar";
import { motion, AnimatePresence } from "framer-motion";
import { TranscriptSegmentData } from "@/types";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";

export interface VirtualizedTranscriptViewProps {
    /** Transcript segments to display */
    segments: TranscriptSegmentData[];
    /** Whether recording is in progress */
    isRecording?: boolean;
    /** Whether recording is paused */
    isPaused?: boolean;
    /** Whether processing/finalizing transcription */
    isProcessing?: boolean;
    /** Whether stopping */
    isStopping?: boolean;
    /** Enable streaming effect for latest segment */
    enableStreaming?: boolean;
    /** Show confidence indicators */
    showConfidence?: boolean;
    /** Completely disable auto-scroll behavior (for meeting details page) */
    disableAutoScroll?: boolean;

    // Pagination props (infinite scroll)
    hasMore?: boolean;
    isLoadingMore?: boolean;
    totalCount?: number;
    loadedCount?: number;
    onLoadMore?: (all?: boolean) => void;
    onEditSegment?: (id: string, text: string) => Promise<boolean> | void;
}

// Threshold for enabling virtualization (below this, use simple rendering)
const VIRTUALIZATION_THRESHOLD = 10;

// Helper function to format seconds as recording-relative time [MM:SS]
function formatRecordingTime(seconds: number | undefined): string {
    if (seconds === undefined) return '[--:--]';

    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;

    return `[${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
}

// Helper function to remove filler words and repetitions
function cleanStopWords(text: string): string {
    const stopWords = ['uh', 'um', 'er', 'ah', 'hmm', 'hm', 'eh', 'oh'];

    let cleanedText = text;
    stopWords.forEach(word => {
        const pattern = new RegExp(`\\b${word}\\b[,\\s]*`, 'gi');
        cleanedText = cleanedText.replace(pattern, ' ');
    });

    return cleanedText.replace(/\s+/g, ' ').trim();
}

export const SCROLL_TO_SEGMENT_EVENT = 'meetily:scroll-to-segment';

function SegmentEditor({ initialText, onSave, onCancel }: {
    initialText: string;
    onSave: (text: string) => Promise<void>;
    onCancel: () => void;
}) {
    const [draft, setDraft] = useState(initialText);
    const [saving, setSaving] = useState(false);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const text = draft.trim();

    useAutoHeight(inputRef, draft);

    useEffect(() => {
        const input = inputRef.current;
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
    }, []);

    const save = async () => {
        if (saving || !text) return;
        if (text === initialText.trim()) return onCancel();
        setSaving(true);
        await onSave(text);
        setSaving(false);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
        } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void save();
        }
    };

    return (
        <div className="space-y-2">
            <Textarea
                ref={inputRef}
                rows={1}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onKeyDown}
                disabled={saving}
                className="min-h-0 resize-none overflow-hidden px-2 py-1 text-base md:text-base leading-relaxed text-gray-800"
            />
            <div className="flex items-center justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onCancel} disabled={saving} title="Esc">
                    Cancel
                </Button>
                <Button type="button" size="sm" className="h-7 px-3 text-xs" onClick={() => void save()} disabled={saving || !text} title="Enter">
                    Save
                </Button>
            </div>
        </div>
    );
}

// Memoized transcript segment component
const TranscriptSegment = memo(function TranscriptSegment({
    id,
    timestamp,
    text,
    confidence,
    isStreaming,
    showConfidence,
    highlighted = false,
    onEdit,
}: {
    id: string;
    timestamp: number;
    text: string;
    confidence?: number;
    isStreaming: boolean;
    showConfidence: boolean;
    highlighted?: boolean;
    onEdit?: (id: string, text: string) => Promise<boolean> | void;
}) {
    const [editing, setEditing] = useState(false);
    const displayText = cleanStopWords(text) || (text.trim() === '' ? '[Silence]' : text);
    const canEdit = !!onEdit && !isStreaming;

    const save = async (next: string) => {
        if ((await onEdit?.(id, next)) !== false) setEditing(false);
    };

    return (
        <div id={`segment-${id}`} className={`group mb-3 rounded-md transition-colors ${highlighted ? 'bg-yellow-50 ring-1 ring-yellow-200' : ''}`}>
            <div className="flex items-start gap-2">
                <Tooltip>
                    <TooltipTrigger>
                        <span className="text-xs text-gray-400 mt-1 flex-shrink-0 min-w-[50px]">
                            {formatRecordingTime(timestamp)}
                        </span>
                    </TooltipTrigger>
                    <TooltipContent>
                        {confidence !== undefined && showConfidence && (
                            <ConfidenceIndicator confidence={confidence} showIndicator={showConfidence} />
                        )}
                    </TooltipContent>
                </Tooltip>
                <div className="relative flex-1 min-w-0">
                    {editing ? (
                        <SegmentEditor initialText={text} onSave={save} onCancel={() => setEditing(false)} />
                    ) : isStreaming ? (
                        <div className="bg-gray-100 border border-gray-200 rounded-lg px-3 py-2">
                            <p className="text-base text-gray-800 leading-relaxed">{displayText}</p>
                        </div>
                    ) : (
                        <p className={`text-base text-gray-800 leading-relaxed ${canEdit ? 'pr-7' : ''}`}>{displayText}</p>
                    )}
                    {canEdit && !editing && (
                        <button
                            type="button"
                            onClick={() => setEditing(true)}
                            className="absolute right-0 top-0.5 p-1 rounded-md text-gray-400 opacity-0 transition-opacity duration-150 hover:text-blue-600 hover:bg-blue-50 group-hover:opacity-100 focus-visible:opacity-100"
                            aria-label="Edit this line"
                            title="Edit this line"
                        >
                            <Pencil className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
});

export const VirtualizedTranscriptView: React.FC<VirtualizedTranscriptViewProps> = ({
    segments,
    isRecording = false,
    isPaused = false,
    isProcessing = false,
    isStopping = false,
    enableStreaming = false,
    showConfidence = true,
    disableAutoScroll = false,
    hasMore = false,
    isLoadingMore = false,
    totalCount = 0,
    loadedCount = 0,
    onLoadMore,
    onEditSegment,
}) => {
    // Create scroll ref first - shared between virtualizer and auto-scroll hook
    const scrollRef = useRef<HTMLDivElement>(null);
    // Ref for infinite scroll trigger element
    const loadMoreTriggerRef = useRef<HTMLDivElement>(null);

    // Force re-render without flushSync (avoids React warning)
    const [, rerender] = useReducer((x: number) => x + 1, 0);

    // Setup virtualizer for efficient rendering of large lists
    const virtualizer = useVirtualizer({
        count: segments.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 60, // Estimated height per segment
        overscan: 10, // Render extra items above/below viewport
        onChange: () => {
            startTransition(() => {
                rerender();
            });
        },
    });

    const [highlightedId, setHighlightedId] = useState<string | null>(null);
    const segmentsRef = useRef(segments);
    segmentsRef.current = segments;

    // Custom hook for auto-scrolling (supports both virtualized and non-virtualized)
    useAutoScroll({
        scrollRef,
        segments,
        isRecording,
        isPaused,
        virtualizer,
        virtualizationThreshold: VIRTUALIZATION_THRESHOLD,
        activeSegmentId: highlightedId ?? undefined,
        disableAutoScroll,
    });

    // Streaming text effect hook (typewriter animation for new transcripts)
    const { streamingSegmentId, getDisplayText } = useTranscriptStreaming(
        segments,
        isRecording,
        enableStreaming
    );

    const pendingTargetRef = useRef<{ atSeconds: number; loadedCount: number } | null>(null);
    const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const loadMoreRef = useRef({ hasMore, isLoadingMore, onLoadMore });
    loadMoreRef.current = { hasMore, isLoadingMore, onLoadMore };

    const showSegmentAt = useCallback((atSeconds: number) => {
        const current = segmentsRef.current;
        if (current.length === 0) return;
        const loaded = loadMoreRef.current;
        const last = current[current.length - 1];
        const pending = pendingTargetRef.current;
        const grewSinceLoad = !pending || current.length > pending.loadedCount;
        if (atSeconds > (last.endTime ?? last.timestamp ?? 0) && loaded.hasMore && loaded.onLoadMore && grewSinceLoad) {
            pendingTargetRef.current = { atSeconds, loadedCount: current.length };
            if (!loaded.isLoadingMore) loaded.onLoadMore(true);
            return;
        }
        pendingTargetRef.current = null;
        let index = 0;
        let best = Number.POSITIVE_INFINITY;
        current.forEach((segment, i) => {
            const distance = Math.abs((segment.timestamp ?? 0) - atSeconds);
            if (distance < best) {
                best = distance;
                index = i;
            }
        });
        setHighlightedId(current[index].id);
        if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = setTimeout(() => setHighlightedId(null), 2500);
    }, []);

    useEffect(() => {
        const handler = (event: Event) => {
            const atSeconds = (event as CustomEvent<{ atSeconds: number }>).detail?.atSeconds;
            if (typeof atSeconds === 'number') showSegmentAt(atSeconds);
        };
        window.addEventListener(SCROLL_TO_SEGMENT_EVENT, handler);
        return () => {
            window.removeEventListener(SCROLL_TO_SEGMENT_EVENT, handler);
            if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
        };
    }, [showSegmentAt]);

    useEffect(() => {
        if (pendingTargetRef.current !== null && !isLoadingMore) showSegmentAt(pendingTargetRef.current.atSeconds);
    }, [segments, isLoadingMore, showSegmentAt]);

    // Infinite scroll: IntersectionObserver to trigger loading more
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording || segments.length === 0) {
            return;
        }

        const triggerElement = loadMoreTriggerRef.current;
        if (!triggerElement) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
            },
            {
                root: null,
                rootMargin: '100px',
                threshold: 0,
            }
        );

        observer.observe(triggerElement);

        return () => observer.disconnect();
    }, [hasMore, isLoadingMore, onLoadMore, isRecording, segments.length]);

    // Scroll-based fallback for fast scrolling
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording) return;

        const scrollElement = scrollRef.current;
        if (!scrollElement) return;

        let ticking = false;

        const handleScroll = () => {
            if (ticking || isLoadingMore || !hasMore) return;

            ticking = true;
            requestAnimationFrame(() => {
                const { scrollTop, scrollHeight, clientHeight } = scrollElement;
                const scrollBottom = scrollHeight - scrollTop - clientHeight;

                // Trigger load when within 200px of bottom
                if (scrollBottom < 200 && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
                ticking = false;
            });
        };

        scrollElement.addEventListener('scroll', handleScroll, { passive: true });
        return () => scrollElement.removeEventListener('scroll', handleScroll);
    }, [onLoadMore, hasMore, isLoadingMore, isRecording]);

    // Use simple rendering for small lists, virtualization for large lists
    const useVirtualization = segments.length >= VIRTUALIZATION_THRESHOLD;

    return (
        <div ref={scrollRef} className="flex flex-col h-full overflow-y-auto px-4 py-2">
            {/* Recording Status Bar - Sticky at top, always visible when recording */}
            <AnimatePresence>
                {isRecording && (
                    <div className="sticky top-0 z-10 bg-white pb-2">
                        <RecordingStatusBar isPaused={isPaused} />
                    </div>
                )}
            </AnimatePresence>

            {/* Content - add padding when recording to prevent overlap */}
            <div className={isRecording ? 'pt-2' : ''}>
            {segments.length === 0 ? (
                // Empty state
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-center text-gray-500 mt-8"
                >
                    {isRecording ? (
                        <>
                            <div className="flex items-center justify-center mb-3">
                                <div className={`w-3 h-3 rounded-full ${isPaused ? 'bg-orange-500' : 'bg-blue-500 animate-pulse'}`}></div>
                            </div>
                            <p className="text-sm text-gray-600">
                                {isPaused ? 'Recording paused' : 'Listening for speech...'}
                            </p>
                            <p className="text-xs mt-1 text-gray-400">
                                {isPaused ? 'Click resume to continue recording' : 'Speak to see live transcription'}
                            </p>
                        </>
                    ) : (
                        <>
                            <p className="text-lg font-semibold">Welcome to Meetily Pro!</p>
                            <p className="text-xs mt-1">Start recording to see live transcription</p>
                        </>
                    )}
                </motion.div>
            ) : useVirtualization ? (
                // Virtualized rendering for large lists
                <>
                    <div
                        style={{
                            height: virtualizer.getTotalSize(),
                            width: "100%",
                            position: "relative",
                        }}
                    >
                        {virtualizer.getVirtualItems().map((virtualRow) => {
                            const segment = segments[virtualRow.index];
                            const isStreaming = streamingSegmentId === segment.id;

                            return (
                                <div
                                    key={segment.id}
                                    data-index={virtualRow.index}
                                    ref={virtualizer.measureElement}
                                    style={{
                                        position: "absolute",
                                        top: 0,
                                        left: 0,
                                        width: "100%",
                                        transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                >
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        confidence={segment.confidence}
                                        isStreaming={isStreaming}
                                        showConfidence={showConfidence}
                                        highlighted={highlightedId === segment.id}
                                        onEdit={onEditSegment}
                                    />
                                </div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger and loading indicator */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-gray-500">
                                    <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                                    <span className="text-sm">Loading more...</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-gray-400">
                                    Showing {loadedCount} of {totalCount} segments
                                </span>
                            ) : null}
                        </div>
                    )}

                    {/* Listening indicator when recording */}
                    {!isStopping && isRecording && !isPaused && !isProcessing && segments.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex items-center gap-2 mt-4 text-gray-500"
                        >
                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                            <span className="text-sm">Listening...</span>
                        </motion.div>
                    )}
                </>
            ) : (
                // Simple rendering for small lists (better animations)
                <>
                    <div className="space-y-1">
                        {segments.map((segment) => {
                            const isStreaming = streamingSegmentId === segment.id;

                            return (
                                <motion.div
                                    key={segment.id}
                                    initial={{ opacity: 0, y: 5 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.15 }}
                                >
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        confidence={segment.confidence}
                                        isStreaming={isStreaming}
                                        showConfidence={showConfidence}
                                        highlighted={highlightedId === segment.id}
                                        onEdit={onEditSegment}
                                    />
                                </motion.div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger (for small lists that grow) */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-gray-500">
                                    <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                                    <span className="text-sm">Loading more...</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-gray-400">
                                    Showing {loadedCount} of {totalCount} segments
                                </span>
                            ) : null}
                        </div>
                    )}

                    {/* Listening indicator when recording */}
                    {!isStopping && isRecording && !isPaused && !isProcessing && segments.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex items-center gap-2 mt-4 text-gray-500"
                        >
                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                            <span className="text-sm">Listening...</span>
                        </motion.div>
                    )}
                </>
            )}
            </div>
        </div>
    );
};
