import { Component, inject, signal, computed, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SmartViewService } from '../../core/smart-view.service';
import { VaultService } from '../../core/vault.service';
import { SmartView, FilterCondition } from '../../shared/models';

@Component({
  selector: 'app-smart-views',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './smart-views.component.html',
  styleUrl: './smart-views.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SmartViewsComponent implements OnInit {
  private readonly smartViewService = inject(SmartViewService);
  private readonly vaultService = inject(VaultService);

  readonly views = this.smartViewService.views;
  readonly showBuilder = signal(false);
  readonly runningView = signal<string | null>(null);
  readonly viewResults = signal<{ viewId: string; items: ReturnType<VaultService['items']> } | null>(null);

  // New view builder state
  readonly newViewName = signal('');
  readonly newViewOperator = signal<'AND' | 'OR'>('AND');
  readonly newViewConditions = signal<FilterCondition[]>([
    { id: crypto.randomUUID(), field: 'tag', operator: 'equals', value: '' }
  ]);

  readonly fieldOptions = [
    { value: 'tag', label: 'Tag' },
    { value: 'folder', label: 'Folder' },
    { value: 'type', label: 'Item Type' },
    { value: 'expiry', label: 'Expiry Days' },
    { value: 'totp', label: 'Has TOTP' },
  ];

  readonly operatorOptions: Record<string, { value: string; label: string }[]> = {
    tag: [{ value: 'equals', label: 'equals' }],
    folder: [{ value: 'equals', label: 'equals' }],
    type: [{ value: 'equals', label: 'equals' }],
    expiry: [{ value: 'before', label: 'expires within (days)' }],
    totp: [{ value: 'exists', label: 'exists' }, { value: 'not-exists', label: 'does not exist' }],
  };

  runView(view: SmartView): void {
    this.runningView.set(view.id);
    const items = this.smartViewService.evaluateView(view) as never;
    this.viewResults.set({ viewId: view.id, items });
    setTimeout(() => this.runningView.set(null), 400);
  }

  deleteView(id: string): void {
    this.smartViewService.deleteView(id);
    if (this.viewResults()?.viewId === id) this.viewResults.set(null);
  }

  togglePin(id: string): void {
    this.smartViewService.togglePin(id);
  }

  addCondition(): void {
    this.newViewConditions.update(c => [
      ...c,
      { id: crypto.randomUUID(), field: 'tag', operator: 'equals', value: '' }
    ]);
  }

  removeCondition(id: string): void {
    this.newViewConditions.update(c => c.filter(x => x.id !== id));
  }

  saveView(): void {
    if (!this.newViewName().trim()) return;
    this.smartViewService.addView({
      name: this.newViewName(),
      conditions: this.newViewConditions(),
      operator: this.newViewOperator(),
    });
    this.showBuilder.set(false);
    this.newViewName.set('');
    this.newViewConditions.set([{ id: crypto.randomUUID(), field: 'tag', operator: 'equals', value: '' }]);
  }

  ngOnInit(): void { }
}
