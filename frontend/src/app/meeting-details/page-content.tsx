"use client";
import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { MeetingSummary, SummaryProcessResponse } from '@/types';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { TranscriptPanel } from '@/components/MeetingDetails/TranscriptPanel';
import { MeetingAssistantPanel } from '@/components/MeetingDetails/MeetingAssistantPanel';
import { MeetingDetailsSplitView, type MeetingDetailsTab } from '@/components/MeetingDetails/MeetingDetailsSplitView';

// Custom hooks
import { useMeetingData } from '@/hooks/meeting-details/useMeetingData';
import { useSummaryGeneration } from '@/hooks/meeting-details/useSummaryGeneration';
import { useCopyOperations } from '@/hooks/meeting-details/useCopyOperations';
import { useMeetingOperations } from '@/hooks/meeting-details/useMeetingOperations';
import { useConfig } from '@/contexts/ConfigContext';

export default function PageContent({
  meeting,
  summaryData,
  initialSummary,
  onMeetingUpdated,
  onRefetchTranscripts,
  // Pagination props for efficient transcript loading
  segments,
  hasMore,
  isLoadingMore,
  totalCount,
  loadedCount,
  onLoadMore,
}: {
  meeting: any;
  summaryData: MeetingSummary | null;
  initialSummary: SummaryProcessResponse | null;
  onMeetingUpdated?: () => Promise<void>;
  onRefetchTranscripts?: () => Promise<void>;
  // Pagination props
  segments?: any[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: (all?: boolean) => void;
}) {
  console.log('📄 PAGE CONTENT: Initializing with data:', {
    meetingId: meeting.id,
    summaryDataKeys: summaryData ? Object.keys(summaryData) : null,
    transcriptsCount: meeting.transcripts?.length
  });

  // State
  const isRecording = false;
  const [activeTab, setActiveTab] = useState<MeetingDetailsTab>('transcript');

  const autoSwitchedSummaryMeetingIdsRef = useRef(new Set<string>());
  const manuallySelectedTabMeetingIdsRef = useRef(new Set<string>());
  const autoGenerationStartedMeetingIdRef = useRef<string | null>(null);

  // Sidebar context
  const { serverAddress } = useSidebar();

  // Get model config from ConfigContext
  const { modelConfig, isModelConfigLoading } = useConfig();

  // Custom hooks
  const meetingData = useMeetingData({ meeting, summaryData, onMeetingUpdated });
  const summaryGeneration = useSummaryGeneration({
    initialSummary,
    meeting,
    transcripts: meetingData.transcripts,
    modelConfig: modelConfig,
    isModelConfigLoading,
    onMeetingUpdated,
    updateMeetingTitle: meetingData.updateMeetingTitle,
    setAiSummary: meetingData.setAiSummary,
  });

  const hasTranscript = (totalCount ?? meetingData.transcripts.length) > 0;
  const hasModel = !!modelConfig.model;

  const copyOperations = useCopyOperations({
    meeting,
    transcripts: meetingData.transcripts,
    meetingTitle: meetingData.meetingTitle,
  });

  const meetingOperations = useMeetingOperations({
    meeting,
  });

  useEffect(() => {
    if (
      (meetingData.aiSummary || summaryGeneration.summaryStatus === 'completed')
      && !autoSwitchedSummaryMeetingIdsRef.current.has(meeting.id)
      && !manuallySelectedTabMeetingIdsRef.current.has(meeting.id)
    ) {
      autoSwitchedSummaryMeetingIdsRef.current.add(meeting.id);
      setActiveTab('assistant');
    }
  }, [meeting.id, meetingData.aiSummary, summaryGeneration.summaryStatus]);

  const { summaryStatus, handleGenerateSummary } = summaryGeneration;
  useEffect(() => {
    if (
      isModelConfigLoading
      || !hasModel
      || !hasTranscript
      || meetingData.aiSummary
      || summaryStatus !== 'idle'
      || autoGenerationStartedMeetingIdRef.current === meeting.id
    ) {
      return;
    }
    autoGenerationStartedMeetingIdRef.current = meeting.id;
    void handleGenerateSummary();
  }, [isModelConfigLoading, hasModel, hasTranscript, meeting.id, meetingData.aiSummary, summaryStatus, handleGenerateSummary]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="flex flex-col h-screen min-w-0 bg-gray-50"
    >
      <div className="flex flex-1 min-w-0 overflow-hidden">
        <MeetingDetailsSplitView
          activeTab={activeTab}
          onTabChange={(tab) => {
            manuallySelectedTabMeetingIdsRef.current.add(meeting.id);
            setActiveTab(tab);
          }}
          transcript={
            <TranscriptPanel
              transcripts={meetingData.transcripts}
              onCopyTranscript={copyOperations.handleCopyTranscript}
              onOpenMeetingFolder={meetingOperations.handleOpenMeetingFolder}
              isRecording={isRecording}
              disableAutoScroll={true}
              usePagination={true}
              segments={segments}
              hasMore={hasMore}
              isLoadingMore={isLoadingMore}
              totalCount={totalCount}
              loadedCount={loadedCount}
              onLoadMore={onLoadMore}
              meetingId={meeting.id}
              meetingFolderPath={meeting.folder_path}
              hasKeyTerms={typeof (meetingData.aiSummary as { key_terms?: unknown } | null)?.key_terms === 'string'}
              onRefetchTranscripts={onRefetchTranscripts}
            />
          }
          assistant={
            <MeetingAssistantPanel
              meetingId={meeting.id}
              hasTranscript={hasTranscript}
              summaryStatus={summaryGeneration.summaryStatus}
              summaryError={summaryGeneration.summaryError}
              hasModel={isModelConfigLoading || hasModel}
              onRetrySummary={summaryGeneration.handleGenerateSummary}
            />
          }
        />
      </div>
    </motion.div>
  );
}
