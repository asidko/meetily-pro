import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  version?: string;
  date?: string;
  body?: string;
  url?: string;
  canInstall?: boolean;
}

interface ReleaseCheck {
  available: boolean;
  current_version: string;
  version: string;
  url: string;
  date: string | null;
  notes: string | null;
  can_install: boolean;
}

/**
 * Update Service
 * Singleton service for managing app updates
 */
export class UpdateService {
  private updateCheckInProgress = false;
  private lastCheckTime: number | null = null;
  private readonly CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

  /**
   * Check for available updates
   * @param force Force check even if recently checked
   * @returns Promise with update information
   */
  async checkForUpdates(force = false): Promise<UpdateInfo> {
    // Prevent concurrent update checks
    if (this.updateCheckInProgress) {
      throw new Error('Update check already in progress');
    }

    // Skip if checked recently (unless forced)
    if (!force && this.lastCheckTime) {
      const timeSinceLastCheck = Date.now() - this.lastCheckTime;
      if (timeSinceLastCheck < this.CHECK_INTERVAL_MS) {
        console.log('Skipping update check - checked recently');
        return {
          available: false,
          currentVersion: await getVersion(),
        };
      }
    }

    this.updateCheckInProgress = true;
    this.lastCheckTime = Date.now();

    try {
      const release = await invoke<ReleaseCheck>('check_latest_release');
      return {
        available: release.available,
        currentVersion: release.current_version,
        version: release.version,
        date: release.date ?? undefined,
        body: release.notes ?? undefined,
        url: release.url,
        canInstall: release.can_install,
      };
    } catch (error) {
      console.error('Failed to check for updates:', error);
      throw error;
    } finally {
      this.updateCheckInProgress = false;
    }
  }

  getCheckOnStartup(): Promise<boolean> {
    return invoke<boolean>('get_update_check_on_startup');
  }

  setCheckOnStartup(enabled: boolean): Promise<void> {
    return invoke('set_update_check_on_startup', { enabled });
  }

  async installUpdate(onProgress: (percent: number | null) => void): Promise<void> {
    const unlisten = await listen<number | null>('update-download-progress', (event) => onProgress(event.payload));
    try {
      await invoke('install_update');
    } finally {
      unlisten();
    }
  }

  /**
   * Check if an update check was performed recently
   * @returns true if checked within the interval
   */
  wasCheckedRecently(): boolean {
    if (!this.lastCheckTime) return false;
    const timeSinceLastCheck = Date.now() - this.lastCheckTime;
    return timeSinceLastCheck < this.CHECK_INTERVAL_MS;
  }
}

// Export singleton instance
export const updateService = new UpdateService();
