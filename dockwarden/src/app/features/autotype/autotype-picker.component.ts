import { Component, OnInit, OnDestroy, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { VaultItem } from '../../shared/models';

@Component({
  selector: 'app-autotype-picker',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './autotype-picker.component.html',
  styleUrl: './autotype-picker.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AutotypePickerComponent implements OnInit, OnDestroy {
  readonly query = signal('');
  readonly allItems = signal<VaultItem[]>([]);
  readonly pressEnter = signal(true);
  readonly loading = signal(true);
  readonly sending = signal(false);
  readonly error = signal('');

  readonly results = computed(() => {
    const q = this.query().toLowerCase().trim();
    const all = this.allItems().filter(i => i.type === 'login' && (i.username || i.password));
    if (!q) return all.slice(0, 10);
    return all.filter(i =>
      i.name.toLowerCase().includes(q) ||
      (i.username || '').toLowerCase().includes(q) ||
      (i.website || '').toLowerCase().includes(q)
    ).slice(0, 10);
  });

  private _kbHandler?: (e: KeyboardEvent) => void;

  async ngOnInit(): Promise<void> {
    if (window.electronAPI) {
      const items = await window.electronAPI.vault.getCachedItems();
      this.allItems.set(items);
    }
    this.loading.set(false);

    this._kbHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.electronAPI?.launcher?.close();
    };
    document.addEventListener('keydown', this._kbHandler);
  }

  ngOnDestroy(): void {
    if (this._kbHandler) document.removeEventListener('keydown', this._kbHandler);
  }

  async runAutotype(item: VaultItem): Promise<void> {
    if (!window.electronAPI?.autotype) {
      this.error.set('Auto-Type requires the Electron runtime.');
      return;
    }
    this.sending.set(true);
    this.error.set('');
    const result = await window.electronAPI.autotype.send(
      item.username ?? '',
      item.password ?? '',
      this.pressEnter()
    );
    this.sending.set(false);
    if (result.success) {
      window.electronAPI.launcher?.close();
    } else {
      this.error.set(result.error ?? 'Auto-Type failed.');
    }
  }

  close(): void {
    window.electronAPI?.launcher?.close();
  }

  getColor(name: string): string {
    const palette = ['#ef4444','#3b82f6','#f59e0b','#22c55e','#a855f7','#ec4899','#06b6d4'];
    return palette[name.charCodeAt(0) % palette.length];
  }

  getInitials(name: string): string {
    return name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
  }
}
