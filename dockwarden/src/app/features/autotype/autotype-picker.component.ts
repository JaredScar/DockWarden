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
  readonly windowTitle = signal('');
  readonly matches = signal<{ itemId: string; sequence: string }[]>([]);

  readonly results = computed(() => {
    const q = this.query().toLowerCase().trim();
    const matchIds = new Set(this.matches().map(match => match.itemId));
    let all = this.allItems().filter(i => i.type === 'login' && (i.username || i.password));
    if (!q && matchIds.size) all = all.filter(item => matchIds.has(item.id));
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
      const context = await window.electronAPI.autotype?.getContext();
      if (context) {
        this.windowTitle.set(context.title || '');
        this.matches.set(context.matches || []);
      }
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
    const matched = this.matches().find(match => match.itemId === item.id);
    const sequence = matched?.sequence || item.defaultSequence || undefined;
    const result = await window.electronAPI.autotype.send(
      item.username ?? '',
      item.password ?? '',
      this.pressEnter() && !sequence,
      sequence
    );
    this.sending.set(false);
    if (result.success) {
      window.electronAPI.launcher?.close();
    } else {
      this.error.set(result.error ?? 'Auto-Type failed.');
    }
  }

  async remember(item: VaultItem, event: Event): Promise<void> {
    event.stopPropagation();
    if (!window.electronAPI?.power || !this.windowTitle()) return;
    const value = this.suggestWindow(this.windowTitle());
    const result = await window.electronAPI.power.saveAutotypeRule(item.id, {
      value,
      sequence: item.defaultSequence || '{USERNAME}{TAB}{PASSWORD}{ENTER}',
      match: 'contains',
    });
    this.error.set(result.success ? `Remembered “${value}” for ${item.name}` : (result.error || 'Could not save the rule'));
  }

  private suggestWindow(title: string): string {
    const stripped = title
      .replace(/\s[–—-]\s*(Google Chrome|Mozilla Firefox|Firefox|Microsoft Edge|Safari|Brave|Opera|Arc)\s*$/i, '')
      .trim();
    const parts = stripped.split(/\s[–—-]\s/).map(part => part.trim()).filter(Boolean);
    return (parts[0] || stripped).slice(0, 60);
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
