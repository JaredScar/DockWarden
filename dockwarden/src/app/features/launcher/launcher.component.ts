import { Component, OnInit, OnDestroy, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { VaultItem } from '../../shared/models';

@Component({
  selector: 'app-launcher',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './launcher.component.html',
  styleUrl: './launcher.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LauncherComponent implements OnInit, OnDestroy {
  readonly query       = signal('');
  readonly allItems    = signal<VaultItem[]>([]);
  readonly selectedIdx = signal(0);
  readonly loading     = signal(true);

  // TOTP state
  readonly totpCopiedId  = signal<string | null>(null);
  readonly totpCopying   = signal(false);
  readonly totpCountdown = signal(30 - (Math.floor(Date.now() / 1000) % 30));

  readonly results = computed(() => {
    const q = this.query().toLowerCase().trim();
    const all = this.allItems();
    if (!q) return all.slice(0, 10);
    return all.filter(i =>
      i.name.toLowerCase().includes(q) ||
      (i.username || '').toLowerCase().includes(q) ||
      (i.website || '').toLowerCase().includes(q)
    ).slice(0, 10);
  });

  readonly selectedItem = computed(() => this.results()[this.selectedIdx()] ?? null);
  readonly selectedHasTotp = computed(() => !!this.selectedItem()?.totp);

  private _kbHandler?: (e: KeyboardEvent) => void;
  private _countdownInterval?: ReturnType<typeof setInterval>;
  private _copiedTimer?: ReturnType<typeof setTimeout>;

  async ngOnInit(): Promise<void> {
    if (window.electronAPI) {
      const items = await window.electronAPI.vault.getCachedItems();
      this.allItems.set(items);
    }
    this.loading.set(false);

    // Live TOTP countdown — tick every second
    this._countdownInterval = setInterval(() => {
      this.totpCountdown.set(30 - (Math.floor(Date.now() / 1000) % 30));
    }, 1000);

    this._kbHandler = (e: KeyboardEvent) => {
      const len = this.results().length;
      if (e.key === 'ArrowDown') { e.preventDefault(); this.selectedIdx.update(i => Math.min(i + 1, len - 1)); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); this.selectedIdx.update(i => Math.max(i - 1, 0)); }
      if (e.key === 'Enter')     { const item = this.results()[this.selectedIdx()]; if (item) this.select(item); }
      if (e.key === 'Escape')    { window.electronAPI?.launcher?.close(); }
      if (e.key === 'Tab') {
        e.preventDefault();
        const item = this.selectedItem();
        if (item?.totp) this.copyTotp(item);
      }
    };
    document.addEventListener('keydown', this._kbHandler);
  }

  ngOnDestroy(): void {
    if (this._kbHandler) document.removeEventListener('keydown', this._kbHandler);
    if (this._countdownInterval) clearInterval(this._countdownInterval);
    if (this._copiedTimer) clearTimeout(this._copiedTimer);
  }

  onQueryChange(val: string): void {
    this.query.set(val);
    this.selectedIdx.set(0);
  }

  select(item: VaultItem): void {
    window.electronAPI?.launcher?.navigateToItem(item.id);
  }

  async copyTotp(item: VaultItem): Promise<void> {
    if (this.totpCopying()) return;
    this.totpCopying.set(true);
    try {
      const result = await window.electronAPI!.vault.getTotp(item.id);
      if (result.success && result.code) {
        await navigator.clipboard.writeText(result.code);
        this.totpCopiedId.set(item.id);
        if (this._copiedTimer) clearTimeout(this._copiedTimer);
        this._copiedTimer = setTimeout(() => this.totpCopiedId.set(null), 2000);
      }
    } finally {
      this.totpCopying.set(false);
    }
  }

  close(): void { window.electronAPI?.launcher?.close(); }

  getColor(name: string): string {
    const palette = ['#ef4444','#3b82f6','#f59e0b','#22c55e','#a855f7','#ec4899','#06b6d4'];
    return palette[name.charCodeAt(0) % palette.length];
  }

  getInitials(name: string): string {
    return name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
  }

  getIcon(type: string): string {
    switch (type) {
      case 'login':    return 'fas fa-key';
      case 'card':     return 'fas fa-credit-card';
      case 'note':     return 'fas fa-note-sticky';
      case 'identity': return 'fas fa-id-card';
      default:         return 'fas fa-key';
    }
  }
}
