import React from 'react';
import { Download, ExternalLink } from 'lucide-react';
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
import { UpdateInfo } from '@/services/updateService';
import { toast } from 'sonner';

interface UpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  updateInfo: UpdateInfo | null;
}

export function UpdateDialog({ open, onOpenChange, updateInfo }: UpdateDialogProps) {
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
    <Dialog open={open} onOpenChange={onOpenChange}>
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Later
          </Button>
          <Button onClick={openReleasePage} className="bg-blue-600 hover:bg-blue-700">
            <ExternalLink className="h-4 w-4 mr-2" />
            Open Download Page
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
