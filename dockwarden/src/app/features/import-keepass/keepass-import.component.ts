import { Component, OnInit, OnDestroy, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { KeepassPreview } from '../../shared/models';

@Component({
  selector: 'app-keepass-import',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './keepass-import.component.html',
  styleUrl: './keepass-import.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KeepassImportComponent implements OnInit, OnDestroy {
  readonly filePath = signal('');
  readonly password = signal('');
  readonly entries = signal<KeepassPreview[]>([]);
  readonly selected = signal<Set<number>>(new Set());
  readonly error = signal('');
  readonly result = signal('');
  readonly busy = signal(false);
  readonly progress = signal('');

  ngOnInit(): void {
    window.electronAPI?.keepass.onProgress(progress => {
      this.progress.set(`Importing ${progress.current} of ${progress.total}: ${progress.title}`);
    });
  }

  ngOnDestroy(): void {
    window.electronAPI?.keepass.removeListeners();
  }

  get needsPassword(): boolean {
    return this.filePath().toLowerCase().endsWith('.kdbx');
  }

  async pick(): Promise<void> {
    this.error.set('');
    this.result.set('');
    const picked = await window.electronAPI?.keepass.pick();
    if (!picked || picked.canceled || !picked.path) return;
    this.filePath.set(picked.path);
    this.entries.set([]);
  }

  async preview(): Promise<void> {
    if (!this.filePath()) return;
    this.busy.set(true);
    this.error.set('');
    const response = await window.electronAPI!.keepass.preview(this.filePath(), this.password());
    this.busy.set(false);
    if (!response.success || !response.entries) {
      this.error.set(response.error || 'Could not read that file');
      this.entries.set([]);
      return;
    }
    this.entries.set(response.entries);
    this.selected.set(new Set(response.entries.map(entry => entry.index)));
  }

  toggle(index: number): void {
    const next = new Set(this.selected());
    if (next.has(index)) next.delete(index);
    else next.add(index);
    this.selected.set(next);
  }

  async importSelected(): Promise<void> {
    if (!this.selected().size) return;
    this.busy.set(true);
    this.error.set('');
    this.result.set('');
    const response = await window.electronAPI!.keepass.import(this.filePath(), this.password(), [...this.selected()]);
    this.busy.set(false);
    this.progress.set('');
    if (!response.success) {
      this.error.set(response.error || 'Import failed');
      return;
    }
    const warnings = response.failed?.length ? ` ${response.failed.length} item${response.failed.length === 1 ? '' : 's'} need a look.` : '';
    this.result.set(`Imported ${response.imported} item${response.imported === 1 ? '' : 's'}.${warnings}`);
    if (response.failed?.length) this.error.set(response.failed.slice(0, 5).map(row => `${row.title}: ${row.error}`).join(' '));
  }
}
