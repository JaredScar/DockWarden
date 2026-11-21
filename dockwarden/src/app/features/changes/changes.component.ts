import { Component, OnInit, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { ChangeRecord } from '../../shared/models';
import { PowerService } from '../../core/power.service';

@Component({
  selector: 'app-changes',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './changes.component.html',
  styleUrl: './changes.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChangesComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly power = inject(PowerService);

  readonly records = signal<ChangeRecord[]>([]);
  readonly loading = signal(true);

  async ngOnInit(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.records.set(window.electronAPI?.power ? await window.electronAPI.power.getChanges() : []);
    await this.power.refresh();
    this.loading.set(false);
  }

  async markAll(): Promise<void> {
    await window.electronAPI?.power.markSeen();
    await this.reload();
  }

  async open(record: ChangeRecord): Promise<void> {
    await window.electronAPI?.power.markSeen([record.id]);
    await this.power.refresh();
    if (record.kind !== 'deleted') {
      this.router.navigate(['/items'], { queryParams: { select: record.itemId } });
    }
  }

  describe(record: ChangeRecord): string {
    if (record.kind === 'added') return 'Added';
    if (record.kind === 'deleted') return 'Removed';
    if (!record.fields.length) return 'Modified';
    return record.fields.map(field => {
      if (field.secret) return `${field.field} changed`;
      if (field.before || field.after) return `${field.field}: ${field.before || '∅'} → ${field.after || '∅'}`;
      return field.field;
    }).join(' · ');
  }
}
