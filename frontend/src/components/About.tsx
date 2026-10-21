import React, { useState, useEffect } from "react";
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import Image from 'next/image';
import { UpdateDialog } from "./UpdateDialog";
import { updateService, UpdateInfo } from '@/services/updateService';
import { Button } from './ui/button';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';


export function About() {
    const [currentVersion, setCurrentVersion] = useState<string>('');
    const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
    const [isChecking, setIsChecking] = useState(false);
    const [showUpdateDialog, setShowUpdateDialog] = useState(false);

    useEffect(() => {
        // Get current version on mount
        getVersion().then(setCurrentVersion).catch(console.error);
    }, []);

    const openLink = (url: string) => invoke('open_external_url', { url }).catch(console.error);

    const handleCheckForUpdates = async () => {
        setIsChecking(true);
        try {
            const info = await updateService.checkForUpdates(true);
            setUpdateInfo(info);
            if (info.available) {
                setShowUpdateDialog(true);
            } else {
                toast.success('You are running the latest version');
            }
        } catch (error: any) {
            console.error('Failed to check for updates:', error);
            toast.error('Could not check for updates automatically', {
                description: 'Download the latest version from the Releases page.',
                action: {
                    label: 'Open Releases',
                    onClick: () => invoke('open_external_url', { url: 'https://github.com/asidko/meetily-pro/releases/latest' }),
                },
            });
        } finally {
            setIsChecking(false);
        }
    };

    return (
        <div className="p-4 space-y-4">
            {/* Compact Header */}
            <div className="text-center">
                <div className="mb-3">
                    <Image
                        src="icon_128x128.png"
                        alt="Meetily Pro Logo"
                        width={64}
                        height={64}
                        className="mx-auto"
                    />
                </div>
                {/* <h1 className="text-xl font-bold text-gray-900">Meetily</h1> */}
                <span className="text-sm text-gray-500"> v{currentVersion}</span>
                <p className="text-medium text-gray-600 mt-1">
                    Live transcripts, an in-call assistant and meeting summaries. On your device unless you pick a cloud model.
                </p>
                <div className="mt-3">
                    <Button
                        onClick={handleCheckForUpdates}
                        disabled={isChecking}
                        variant="outline"
                        size="sm"
                        className="text-xs"
                    >
                        {isChecking ? (
                            <>
                                <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                                Checking...
                            </>
                        ) : (
                            <>
                                <CheckCircle2 className="h-3 w-3 mr-2" />
                                Check for Updates
                            </>
                        )}
                    </Button>
                    {updateInfo?.available && (
                        <div className="mt-2 text-xs text-blue-600">
                            Update available: v{updateInfo.version}
                        </div>
                    )}
                </div>
            </div>

            <div className="pt-2 border-t border-gray-200 text-center text-xs text-gray-500">
                <p className="mb-1">
                    By{' '}
                    <button type="button" className="text-blue-600 hover:underline" onClick={() => openLink('https://github.com/asidko')}>
                        Alexander Sidko
                    </button>
                </p>
                <button type="button" className="text-blue-600 hover:underline" onClick={() => openLink('https://github.com/asidko/meetily-pro')}>
                    github.com/asidko/meetily-pro
                </button>
                <p className="mt-1">
                    Fork of{' '}
                    <button type="button" className="text-blue-600 hover:underline" onClick={() => openLink('https://github.com/Zackriya-Solutions/meetily')}>
                        Meetily by Zackriya Solutions
                    </button>
                    , MIT license.
                </p>
            </div>

            {/* Update Dialog */}
            <UpdateDialog
                open={showUpdateDialog}
                onOpenChange={setShowUpdateDialog}
                updateInfo={updateInfo}
            />
        </div>

    )
}