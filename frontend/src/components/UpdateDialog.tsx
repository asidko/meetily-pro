import React, { useState } from 'react';
import { Download, ExternalLink, RefreshCw } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { UpdateInfo, updateService } from '@/services/updateService';
import { useRecordingState, RecordingStatus } from '@/contexts/RecordingStateContext';
import { toast } from 'sonner';

interface UpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  updateInfo: UpdateInfo | null;
}

export function UpdateDialog({ open, onOpenChange, updateInfo }: UpdateDialogProps) {
  const { status } = useRecordingState();
  const recordingBusy = ![RecordingStatus.IDLE, RecordingStatus.COMPLETED, RecordingStatus.ERROR].includes(status);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  const installUpdate = async () => {
    setInstalling(true);
    setProgress(null);
    try {
      await updateService.installUpdate(setProgress);
      toast.success('Update installed', { description: 'It takes effect the next time Meetily Pro starts.' });
      onOpenChange(false);
    } catch (error) {
      toast.error('Could not update', { description: String(error) });
    } finally {
      setInstalling(false);
    }
  };

  const installLabel = !installing ? 'Update and Restart' : progress === 100 ? 'Installing...' : progress === null ? 'Downloading...' : `Downloading ${progress}%`;

  const handleOpenChange = (next: boolean) => {
    if (!installing) onOpenChange(next);
  };

  const openReleasePage = async () => {
    if (!updateInfo?.url) return;
    try {
      await invoke('open_external_url', { url: updateInfo.url });
      onOpenChange(false);
    } catch (error) {
      toast.error('Could not open the release page', { description: String(error) });
    }
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return '';
    try {
      return new Date(dateString).toLocaleDateString();
    } catch {
      return dateString;
    }
  };

  if (!updateInfo?.available) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5 text-blue-600" />
            Update Available
          </DialogTitle>
          <DialogDescription>
            {`A new version (${updateInfo.version}) is available`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Current Version:</span>
              <span className="font-medium">{updateInfo.currentVersion}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">New Version:</span>
              <span className="font-medium text-blue-600">{updateInfo.version}</span>
            </div>
            {updateInfo.date && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Release Date:</span>
                <span className="font-medium">{formatDate(updateInfo.date)}</span>
              </div>
            )}
          </div>

          {updateInfo.body && (
            <div className="bg-gray-50 rounded-lg p-3 max-h-48 overflow-y-auto prose prose-sm max-w-none dark:prose-invert prose-headings:mb-1 prose-headings:mt-0 prose-headings:text-sm prose-p:my-1 prose-ul:my-1 prose-li:my-0">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{updateInfo.body}</ReactMarkdown>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={installing}>
            Later
          </Button>
          {updateInfo.canInstall ? (
            <>
              <Button variant="outline" onClick={openReleasePage} disabled={installing}>
                <ExternalLink className="h-4 w-4 mr-2" />
                Release Page
              </Button>
              <Button
                onClick={installUpdate}
                disabled={installing || recordingBusy}
                title={recordingBusy ? 'Wait until the recording is stopped and saved' : undefined}
                className="bg-blue-600 hover:bg-blue-700"
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${installing ? 'animate-spin' : ''}`} />
                {installLabel}
              </Button>
            </>
          ) : (
            <Button onClick={openReleasePage} className="bg-blue-600 hover:bg-blue-700">
              <ExternalLink className="h-4 w-4 mr-2" />
              Open Download Page
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
