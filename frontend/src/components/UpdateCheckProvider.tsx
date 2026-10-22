'use client'

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { useUpdateCheck } from '@/hooks/useUpdateCheck';
import { UpdateInfo } from '@/services/updateService';
import { UpdateDialog } from './UpdateDialog';
import { checkForUpdatesNow, setUpdateDialogCallback, showUpdateNotification } from './UpdateNotification';

interface UpdateCheckContextType {
  updateInfo: UpdateInfo | null;
  isChecking: boolean;
  checkForUpdates: (force?: boolean) => Promise<void>;
  showUpdateDialog: () => void;
}

const UpdateCheckContext = createContext<UpdateCheckContextType | undefined>(undefined);

export function UpdateCheckProvider({ children }: { children: React.ReactNode }) {
  const [showDialog, setShowDialog] = useState(false);
  const [manualInfo, setManualInfo] = useState<UpdateInfo | null>(null);

  const handleShowDialog = useCallback(() => {
    setShowDialog(true);
  }, []);

  const { updateInfo, isChecking, checkForUpdates } = useUpdateCheck({
    checkOnMount: true,
    showNotification: true,
    onUpdateAvailable: (info) => {
      // Show notification, dialog will be shown when user clicks notification
      showUpdateNotification(info, handleShowDialog);
    },
  });

  useEffect(() => {
    // Register the callback so UpdateNotification can trigger the dialog
    setUpdateDialogCallback(handleShowDialog);
    return () => {
      setUpdateDialogCallback(() => {});
    };
  }, [handleShowDialog]);

  // Listen for tray menu events
  useEffect(() => {
    const handleTrayCheck = async () => {
      const info = await checkForUpdatesNow();
      if (!info?.available) return;
      setManualInfo(info);
      setShowDialog(true);
    };

    window.addEventListener('check-updates-from-tray', handleTrayCheck);
    return () => window.removeEventListener('check-updates-from-tray', handleTrayCheck);
  }, []);

  return (
    <UpdateCheckContext.Provider
      value={{
        updateInfo,
        isChecking,
        checkForUpdates,
        showUpdateDialog: handleShowDialog,
      }}
    >
      {children}
      <UpdateDialog
        open={showDialog}
        onOpenChange={setShowDialog}
        updateInfo={manualInfo ?? updateInfo}
      />
    </UpdateCheckContext.Provider>
  );
}

export function useUpdateCheckContext() {
  const context = useContext(UpdateCheckContext);
  if (context === undefined) {
    throw new Error('useUpdateCheckContext must be used within UpdateCheckProvider');
  }
  return context;
}
