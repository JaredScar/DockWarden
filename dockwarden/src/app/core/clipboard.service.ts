import { Injectable, signal } from '@angular/core';

declare const window: Window & {
  electronAPI?: {
    vault: {
      getSetting: (key: string, defaultValue: unknown) => Promise<unknown>;
      setSetting: (key: string, value: unknown) => Promise<boolean>;
    };
    clipboard?: {
      write: (text: string) => Promise<boolean>;
    };
  };
};

@Injectable({ providedIn: 'root' })
export class ClipboardService {
  readonly activeField = signal<string | null>(null);
  readonly countdown = signal(0);
  readonly clearDelay = signal(30);

  private _totalSeconds = 30;
  private _timer: ReturnType<typeof setInterval> | null = null;

  async init(): Promise<void> {
    if (window.electronAPI) {
      const delay = await window.electronAPI.vault.getSetting('clipboardClearDelay', 30) as number;
      this.clearDelay.set(delay > 0 ? delay : 0);
    }
  }

  async copy(text: string, fieldName: string): Promise<boolean> {
    const wrote = await this.write(text);
    if (!wrote) return false;
    const seconds = this.clearDelay();
    if (seconds <= 0) return true;

    this.cancel();
    this._totalSeconds = seconds;
    this.activeField.set(fieldName);
    this.countdown.set(seconds);

    this._timer = setInterval(() => {
      const next = this.countdown() - 1;
      if (next <= 0) {
        this.write('').catch(() => {});
        this.cancel();
      } else {
        this.countdown.set(next);
      }
    }, 1000);
    return true;
  }

  private async write(text: string): Promise<boolean> {
    if (window.electronAPI?.clipboard) {
      try {
        return await window.electronAPI.clipboard.write(text);
      } catch {
        return false;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  cancel(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.activeField.set(null);
    this.countdown.set(0);
  }

  progressFraction(): number {
    return this._totalSeconds > 0 ? this.countdown() / this._totalSeconds : 0;
  }

  async updateDelay(seconds: number): Promise<void> {
    this.clearDelay.set(seconds);
    if (window.electronAPI) {
      await window.electronAPI.vault.setSetting('clipboardClearDelay', seconds);
    }
  }
}
