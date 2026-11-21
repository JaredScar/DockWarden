import { Injectable, inject, signal } from '@angular/core';
import { VaultService } from './vault.service';
import { ClipboardService } from './clipboard.service';
import { VaultItem } from '../shared/models';

export interface PendingRotation {
  item: VaultItem;
  password: string;
  url: string | null;
}

@Injectable({ providedIn: 'root' })
export class PowerService {
  private readonly vault = inject(VaultService);
  private readonly clipboard = inject(ClipboardService);

  readonly unseen = signal(0);
  readonly rotating = signal<PendingRotation | null>(null);
  readonly rotationError = signal('');

  async refresh(): Promise<void> {
    if (!window.electronAPI?.power) return;
    this.unseen.set(await window.electronAPI.power.unseenCount());
  }

  async beginRotation(item: VaultItem): Promise<void> {
    this.rotationError.set('');
    if (!window.electronAPI?.generator || !window.electronAPI.power) {
      this.rotationError.set('Rotation needs the desktop app.');
      return;
    }
    const password = await window.electronAPI.generator.generate({
      length: 20, upper: true, lower: true, numbers: true, symbols: true, ambiguous: false,
    });
    const url = await window.electronAPI.power.rotateUrl(item.website, item.rotateUrl);
    await this.clipboard.copy(password, 'password');
    if (url && /^https?:\/\//i.test(url)) await window.electronAPI.app.openExternal(url);
    this.rotating.set({ item, password, url });
  }

  async confirmRotation(): Promise<boolean> {
    const pending = this.rotating();
    if (!pending) return false;
    const sourceId = pending.item.links?.password || pending.item.id;
    const saved = sourceId === pending.item.id
      ? await this.vault.updateItemMeta(sourceId, { password: pending.password, expiresAt: null })
      : await this.vault.updateItemMeta(sourceId, { password: pending.password });
    if (!saved.success) {
      this.rotationError.set(saved.error || 'Could not save the new password');
      return false;
    }
    if (sourceId !== pending.item.id) {
      await this.vault.updateItemMeta(pending.item.id, { expiresAt: null });
    }
    this.rotating.set(null);
    return true;
  }

  cancelRotation(): void {
    this.rotating.set(null);
    this.rotationError.set('');
  }
}
