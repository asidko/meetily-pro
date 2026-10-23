import React, { useState, useEffect } from "react";
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import Image from 'next/image';
import { UpdateDialog } from "./UpdateDialog";
import { UpdateInfo } from '@/services/updateService';
import { checkForUpdatesNow } from './UpdateNotification';
import { Button } from './ui/button';
import { Loader2, CheckCircle2, Bug } from 'lucide-react';
import { toast } from 'sonner';
import { AUTHOR, CREDITS, REPO_URL, WHATS_NEW } from '@/lib/about';


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

    const reportBug = async () => {
        try {
            await invoke('open_external_url', { url: await invoke<string>('bug_report_url') });
        } catch (error) {
            toast.error('Could not open the issue page', { description: String(error) });
        }
    };

    const handleCheckForUpdates = async () => {
        setIsChecking(true);
        const info = await checkForUpdatesNow();
        setIsChecking(false);
        if (!info) return;
        setUpdateInfo(info);
        if (info.available) setShowUpdateDialog(true);
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
                <div className="mt-3 flex justify-center gap-2">
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
                    <Button onClick={reportBug} variant="outline" size="sm" className="text-xs">
                        <Bug className="h-3 w-3 mr-2" />
                        Report a Bug
                    </Button>
                </div>
                {updateInfo?.available && (
                    <div className="mt-2 text-xs text-blue-600">
                        Update available: v{updateInfo.version}
                    </div>
                )}
            </div>

            <section className="border-t border-gray-200 pt-3">
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">What&apos;s new</h3>
                <div className="space-y-2">
                    {WHATS_NEW.map((release) => (
                        <div key={release.version} className="flex gap-3 text-xs">
                            <span className="w-11 shrink-0 font-medium text-gray-700">v{release.version}</span>
                            <ul className="list-disc space-y-0.5 pl-4 text-gray-600">
                                {release.highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}
                            </ul>
                        </div>
                    ))}
                </div>
            </section>

            <section className="border-t border-gray-200 pt-3">
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Credits and licenses</h3>
                <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    {CREDITS.map((credit) => (
                        <li key={credit.name} className="flex items-baseline justify-between gap-2">
                            <button type="button" className="truncate text-left text-blue-600 hover:underline" onClick={() => openLink(credit.url)}>
                                {credit.name}
                            </button>
                            <span className="shrink-0 text-gray-400">{credit.license}</span>
                        </li>
                    ))}
                </ul>
            </section>

            <div className="border-t border-gray-200 pt-3 text-center text-xs text-gray-500 space-y-1">
                <p>
                    By{' '}
                    <button type="button" className="text-blue-600 hover:underline" onClick={() => openLink(AUTHOR.url)}>
                        {AUTHOR.name}
                    </button>
                    {' - '}
                    <button type="button" className="text-blue-600 hover:underline" onClick={() => openLink(REPO_URL)}>
                        github.com/asidko/meetily-pro
                    </button>
                </p>
                <p>
                    Copyright {new Date().getFullYear()} {AUTHOR.name}.{' '}
                    <button type="button" className="text-blue-600 hover:underline" onClick={() => openLink(`${REPO_URL}/blob/main/LICENSE.md`)}>
                        MIT license
                    </button>
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