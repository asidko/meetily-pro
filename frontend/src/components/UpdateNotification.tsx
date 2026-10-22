import React from 'react';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { invoke } from '@tauri-apps/api/core';
import { updateService, UpdateInfo } from '@/services/updateService';

const RELEASES_URL = 'https://github.com/asidko/meetily-pro/releases/latest';

export async function checkForUpdatesNow(): Promise<UpdateInfo | null> {
  try {
    const info = await updateService.checkForUpdates(true);
    if (!info.available) toast.success('You are running the latest version');
    return info;
  } catch (error) {
    console.error('Failed to check for updates:', error);
    toast.error('Could not check for updates', {
      description: String(error),
      action: {
        label: 'Open Releases',
        onClick: () => void invoke('open_external_url', { url: RELEASES_URL }),
      },
    });
    return null;
  }
}

let globalShowDialogCallback: (() => void) | null = null;

export function setUpdateDialogCallback(callback: () => void) {
  globalShowDialogCallback = callback;
}

export function showUpdateNotification(updateInfo: UpdateInfo, onUpdateClick?: () => void) {
  const handleClick = () => {
    if (onUpdateClick) {
      onUpdateClick();
    } else if (globalShowDialogCallback) {
      globalShowDialogCallback();
    }
  };

  toast.info(
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <Download className="h-4 w-4" />
        <div>
          <p className="font-medium">Update Available</p>
          <p className="text-sm text-muted-foreground">
            Version {updateInfo.version} is now available
          </p>
        </div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          handleClick();
        }}
        className="text-sm font-medium text-blue-600 hover:text-blue-700 underline"
      >
        View Details
      </button>
    </div>,
    {
      duration: 10000,
      position: 'bottom-center',
    }
  );
}
