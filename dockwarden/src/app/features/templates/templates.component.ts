import {
  Component, OnInit, inject, signal, computed, ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TemplateService } from '../../core/template.service';
import { VaultService } from '../../core/vault.service';
import { VaultTemplate, TemplateField, TemplateFieldType } from '../../shared/models';

@Component({
  selector: 'app-templates',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './templates.component.html',
  styleUrl: './templates.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplatesComponent implements OnInit {
  private readonly templateService = inject(TemplateService);
  private readonly vaultService = inject(VaultService);
  private readonly router = inject(Router);

  readonly allTemplates = this.templateService.allTemplates;
  readonly builtInTemplates = this.templateService.builtInTemplates;
  readonly userTemplates = this.templateService.userTemplates;
  readonly folders = this.vaultService.folders;

  readonly selectedId = signal<string | null>(null);
  readonly editMode = signal(false);
  readonly saving = signal(false);
  readonly saveError = signal('');
  readonly deleteConfirm = signal<string | null>(null);
  readonly importError = signal('');
  readonly importOpen = signal(false);
  readonly importJson = signal('');
  readonly exportJson = signal('');
  readonly exportOpen = signal(false);

  readonly selectedTemplate = computed<VaultTemplate | null>(() => {
    const id = this.selectedId();
    return id ? (this.allTemplates().find(t => t.id === id) ?? null) : null;
  });

  // Draft being edited (deep-cloned so we don't mutate the signal)
  readonly draft = signal<VaultTemplate | null>(null);

  readonly fieldTypes: { value: TemplateFieldType; label: string; icon: string }[] = [
    { value: 'text', label: 'Text', icon: 'fas fa-font' },
    { value: 'hidden', label: 'Hidden', icon: 'fas fa-eye-slash' },
    { value: 'url', label: 'URL', icon: 'fas fa-link' },
    { value: 'boolean', label: 'Toggle', icon: 'fas fa-toggle-on' },
  ];

  readonly ICON_PRESETS = [
    '🖥️','🔌','🗄️','📋','📶','☁️','🔑','💳','📝','🏠','🚀','🛡️',
    '📁','⚙️','🎮','🔐','💡','🌐','📧','📱','🏢','🔧','📦','🧪',
  ];

  readonly COLOR_PRESETS = [
    '#ef4444','#f97316','#f59e0b','#22c55e','#06b6d4','#3b82f6',
    '#8b5cf6','#a855f7','#ec4899','#64748b',
  ];

  async ngOnInit(): Promise<void> {
    await this.templateService.loadTemplates();
    // Pre-select first built-in
    if (this.allTemplates().length > 0) {
      this.selectTemplate(this.allTemplates()[0].id);
    }
  }

  selectTemplate(id: string): void {
    this.selectedId.set(id);
    this.editMode.set(false);
    this.saveError.set('');
    this.draft.set(null);
  }

  startNew(): void {
    const blank = this.templateService.createBlankTemplate();
    this.draft.set(JSON.parse(JSON.stringify(blank)));
    this.selectedId.set(blank.id);
    this.editMode.set(true);
    this.saveError.set('');
  }

  startEdit(): void {
    const t = this.selectedTemplate();
    if (!t || t.builtIn) return;
    this.draft.set(JSON.parse(JSON.stringify(t)));
    this.editMode.set(true);
    this.saveError.set('');
  }

  cancelEdit(): void {
    const t = this.selectedTemplate();
    if (t && !t.builtIn) {
      this.editMode.set(false);
      this.draft.set(null);
    } else {
      // was a new blank — deselect
      this.selectedId.set(this.allTemplates()[0]?.id ?? null);
      this.editMode.set(false);
      this.draft.set(null);
    }
  }

  async saveEdit(): Promise<void> {
    const d = this.draft();
    if (!d) return;
    if (!d.name.trim()) { this.saveError.set('Template name is required.'); return; }
    this.saving.set(true);
    this.saveError.set('');
    const ok = await this.templateService.saveTemplate({ ...d, name: d.name.trim() });
    this.saving.set(false);
    if (ok) {
      this.selectedId.set(d.id);
      this.editMode.set(false);
      this.draft.set(null);
    } else {
      this.saveError.set('Failed to save template.');
    }
  }

  confirmDelete(id: string): void { this.deleteConfirm.set(id); }
  cancelDelete(): void { this.deleteConfirm.set(null); }

  async doDelete(id: string): Promise<void> {
    await this.templateService.deleteTemplate(id);
    this.deleteConfirm.set(null);
    const remaining = this.allTemplates();
    this.selectedId.set(remaining[0]?.id ?? null);
    this.editMode.set(false);
    this.draft.set(null);
  }

  duplicateTemplate(t: VaultTemplate): void {
    const copy: VaultTemplate = {
      ...JSON.parse(JSON.stringify(t)),
      id: `tpl-${Date.now()}`,
      name: `${t.name} (copy)`,
      builtIn: false,
    };
    this.draft.set(copy);
    this.selectedId.set(copy.id);
    this.editMode.set(true);
    this.saveError.set('');
  }

  // ── Draft field helpers ─────────────────────────────────────────────────────

  updateDraftField(key: keyof VaultTemplate, value: unknown): void {
    this.draft.update(d => d ? { ...d, [key]: value } : d);
  }

  addField(): void {
    const f = this.templateService.createBlankField();
    this.draft.update(d => d ? { ...d, fields: [...d.fields, f] } : d);
  }

  removeField(id: string): void {
    this.draft.update(d => d ? { ...d, fields: d.fields.filter(f => f.id !== id) } : d);
  }

  updateField(fieldId: string, key: keyof TemplateField, value: unknown): void {
    this.draft.update(d => {
      if (!d) return d;
      return {
        ...d,
        fields: d.fields.map(f => f.id === fieldId ? { ...f, [key]: value } : f),
      };
    });
  }

  moveField(idx: number, dir: -1 | 1): void {
    this.draft.update(d => {
      if (!d) return d;
      const fields = [...d.fields];
      const target = idx + dir;
      if (target < 0 || target >= fields.length) return d;
      [fields[idx], fields[target]] = [fields[target], fields[idx]];
      return { ...d, fields };
    });
  }

  // ── Export / Import ─────────────────────────────────────────────────────────

  openExport(t: VaultTemplate): void {
    this.exportJson.set(this.templateService.exportTemplate(t));
    this.exportOpen.set(true);
  }

  closeExport(): void { this.exportOpen.set(false); }

  copyExportJson(): void {
    navigator.clipboard.writeText(this.exportJson()).catch(() => {});
  }

  openImport(): void {
    this.importJson.set('');
    this.importError.set('');
    this.importOpen.set(true);
  }

  closeImport(): void { this.importOpen.set(false); }

  async doImport(): Promise<void> {
    const t = this.templateService.importTemplate(this.importJson());
    if (!t) { this.importError.set('Invalid template JSON. Check the format and try again.'); return; }
    this.saving.set(true);
    const ok = await this.templateService.saveTemplate(t);
    this.saving.set(false);
    if (ok) {
      this.closeImport();
      this.selectedId.set(t.id);
      this.editMode.set(false);
    } else {
      this.importError.set('Failed to save imported template.');
    }
  }

  // ── Quick-create item from template ────────────────────────────────────────

  createItemFromTemplate(id: string): void {
    // Navigate to items with a query param so app shell opens new item modal with this template
    this.router.navigate(['/items'], { queryParams: { newFromTemplate: id } });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  fieldTypeLabel(type: TemplateFieldType): string {
    return this.fieldTypes.find(t => t.value === type)?.label ?? type;
  }

  fieldTypeIcon(type: TemplateFieldType): string {
    return this.fieldTypes.find(t => t.value === type)?.icon ?? 'fas fa-font';
  }

  trackById(_: number, item: { id: string }): string { return item.id; }
}
