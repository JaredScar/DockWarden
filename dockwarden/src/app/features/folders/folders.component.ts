import {
  Component, OnInit, inject, signal, computed, ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { FolderService, FolderTreeRow } from '../../core/folder.service';
import { VaultService, Folder } from '../../core/vault.service';
import { VaultItem } from '../../shared/models';

@Component({
  selector: 'app-folders',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './folders.component.html',
  styleUrl: './folders.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FoldersComponent implements OnInit {
  readonly folderService = inject(FolderService);
  private readonly vaultService = inject(VaultService);
  private readonly router = inject(Router);

  readonly folderTreeRows = this.folderService.sidebarRows;
  readonly allFolders = this.vaultService.folders;

  // ── Selection ───────────────────────────────────────────────────────────────
  readonly selectedFolderPath = signal<string | null>(null);

  readonly selectedFolder = computed<Folder | null>(() => {
    const path = this.selectedFolderPath();
    return path ? (this.folderService.getByPath(path) ?? null) : null;
  });

  readonly selectedFolderItems = computed<VaultItem[]>(() => {
    const folder = this.selectedFolder();
    if (!folder) return [];
    const subtreeIds = this.folderService.getSubtreeIds(folder.id);
    return this.vaultService.items().filter(i => i.folderId && subtreeIds.has(i.folderId));
  });

  readonly selectedFolderDirectItems = computed<VaultItem[]>(() => {
    const folder = this.selectedFolder();
    if (!folder) return [];
    return this.vaultService.items().filter(i => i.folderId === folder.id);
  });

  // ── Inline rename ───────────────────────────────────────────────────────────
  readonly renamingPath = signal<string | null>(null);
  readonly renameValue = signal('');
  readonly renameSaving = signal(false);
  readonly renameError = signal('');

  // ── New folder ──────────────────────────────────────────────────────────────
  readonly newParentPath = signal<string | null>(null);
  readonly newName = signal('');
  readonly newSaving = signal(false);
  readonly newError = signal('');
  readonly newOpen = signal(false);

  // ── Delete ──────────────────────────────────────────────────────────────────
  readonly deleteConfirmPath = signal<string | null>(null);
  readonly deleteSaving = signal(false);

  // ── Move (reparent) ─────────────────────────────────────────────────────────
  readonly movingPath = signal<string | null>(null);
  readonly moveTargetPath = signal<string>('');
  readonly moveSaving = signal(false);
  readonly moveError = signal('');

  // ── Drag-to-reparent ────────────────────────────────────────────────────────
  readonly dragSourcePath = signal<string | null>(null);
  readonly dragOverPath = signal<string | null>(null);

  // ── Item move ───────────────────────────────────────────────────────────────
  readonly itemMovingId = signal<string | null>(null);
  readonly itemMoveTargetId = signal<string>('');
  readonly itemMoveSaving = signal(false);

  async ngOnInit(): Promise<void> {
    await this.vaultService.loadFolders();
  }

  selectFolder(fullPath: string): void {
    this.selectedFolderPath.set(
      this.selectedFolderPath() === fullPath ? null : fullPath
    );
    this.cancelAll();
  }

  private cancelAll(): void {
    this.cancelRename();
    this.cancelNew();
    this.cancelDelete();
    this.cancelMove();
  }

  // ── Rename ──────────────────────────────────────────────────────────────────

  startRename(row: FolderTreeRow, event?: MouseEvent): void {
    event?.stopPropagation();
    this.cancelAll();
    this.renameValue.set(row.label);
    this.renameError.set('');
    this.renamingPath.set(row.fullPath);
  }

  cancelRename(): void {
    this.renamingPath.set(null);
    this.renameValue.set('');
    this.renameError.set('');
  }

  async commitRename(): Promise<void> {
    const path = this.renamingPath();
    const newSegment = this.renameValue().trim();
    if (!path || !newSegment) return;

    const folder = this.folderService.getByPath(path);
    if (!folder) { this.cancelRename(); return; }

    this.renameSaving.set(true);
    const result = await this.folderService.renameWithCascade(folder.id, newSegment);
    this.renameSaving.set(false);

    if (result.success) {
      // Update selection to reflect new path
      const parts = path.split('/');
      parts[parts.length - 1] = newSegment;
      const newPath = parts.join('/');
      this.selectedFolderPath.set(newPath);
      this.cancelRename();
    } else {
      this.renameError.set(result.error ?? 'Rename failed');
    }
  }

  // ── New folder ──────────────────────────────────────────────────────────────

  startNew(parentPath: string | null, event?: MouseEvent): void {
    event?.stopPropagation();
    this.cancelAll();
    this.newParentPath.set(parentPath);
    this.newName.set('');
    this.newError.set('');
    this.newOpen.set(true);
    if (parentPath) this.folderService.expand(parentPath);
  }

  cancelNew(): void {
    this.newOpen.set(false);
    this.newName.set('');
    this.newError.set('');
    this.newParentPath.set(null);
  }

  async commitNew(): Promise<void> {
    const rawName = this.newName().trim();
    if (!rawName) return;

    const parentPath = this.newParentPath();
    const fullPath = parentPath ? `${parentPath}/${rawName}` : rawName;

    this.newSaving.set(true);
    const result = await this.folderService.createFolder(fullPath);
    this.newSaving.set(false);

    if (result.success) {
      this.cancelNew();
      this.selectedFolderPath.set(fullPath);
    } else {
      this.newError.set(result.error ?? 'Could not create folder');
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  confirmDelete(fullPath: string, event?: MouseEvent): void {
    event?.stopPropagation();
    this.cancelAll();
    this.deleteConfirmPath.set(fullPath);
  }

  cancelDelete(): void { this.deleteConfirmPath.set(null); }

  async commitDelete(fullPath: string): Promise<void> {
    const folder = this.folderService.getByPath(fullPath);
    if (!folder) { this.cancelDelete(); return; }

    this.deleteSaving.set(true);
    const result = await this.folderService.deleteFolder(folder.id);
    this.deleteSaving.set(false);

    if (result.success) {
      if (this.selectedFolderPath() === fullPath) this.selectedFolderPath.set(null);
      this.cancelDelete();
    }
  }

  // ── Move / reparent ─────────────────────────────────────────────────────────

  startMove(fullPath: string, event?: MouseEvent): void {
    event?.stopPropagation();
    this.cancelAll();
    const parentPath = this.folderService.getParentPath(fullPath);
    this.moveTargetPath.set(parentPath ?? '');
    this.moveError.set('');
    this.movingPath.set(fullPath);
  }

  cancelMove(): void {
    this.movingPath.set(null);
    this.moveTargetPath.set('');
    this.moveError.set('');
  }

  async commitMove(): Promise<void> {
    const oldPath = this.movingPath();
    if (!oldPath) return;
    const rawTarget = this.moveTargetPath().trim();
    const newParent = rawTarget || null;
    const lastName = this.folderService.getDisplayName(oldPath);
    const newPath = newParent ? `${newParent}/${lastName}` : lastName;

    if (newPath === oldPath) { this.cancelMove(); return; }

    // Guard against making a folder its own ancestor
    if (newPath.startsWith(oldPath + '/')) {
      this.moveError.set('Cannot move a folder into one of its own subfolders.');
      return;
    }

    this.moveSaving.set(true);
    const result = await this.vaultService.moveFolderTree(oldPath, newPath);
    this.moveSaving.set(false);

    if (result.success) {
      this.selectedFolderPath.set(newPath);
      this.cancelMove();
    } else {
      this.moveError.set(result.error ?? 'Move failed');
    }
  }

  // ── Drag-to-reparent ────────────────────────────────────────────────────────

  onDragStart(event: DragEvent, fullPath: string): void {
    event.dataTransfer?.setData('dw-folder-path', fullPath);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    this.dragSourcePath.set(fullPath);
  }

  onDragOver(event: DragEvent, targetPath: string): void {
    if (!event.dataTransfer?.types.includes('dw-folder-path')) return;
    const sourcePath = this.dragSourcePath();
    if (!sourcePath || targetPath === sourcePath || targetPath.startsWith(sourcePath + '/')) return;
    event.preventDefault();
    this.dragOverPath.set(targetPath);
  }

  onDragLeave(): void { this.dragOverPath.set(null); }

  async onDrop(event: DragEvent, targetRow: FolderTreeRow): Promise<void> {
    event.preventDefault();
    this.dragOverPath.set(null);
    const sourcePath = event.dataTransfer?.getData('dw-folder-path');
    if (!sourcePath || !targetRow.id) return;
    if (sourcePath === targetRow.fullPath) return;

    const lastName = this.folderService.getDisplayName(sourcePath);
    const newPath = `${targetRow.fullPath}/${lastName}`;

    if (newPath.startsWith(sourcePath + '/')) return; // would create a cycle

    await this.vaultService.moveFolderTree(sourcePath, newPath);
    this.dragSourcePath.set(null);
    this.selectedFolderPath.set(newPath);
  }

  onDragEnd(): void { this.dragSourcePath.set(null); this.dragOverPath.set(null); }

  // ── Item move ───────────────────────────────────────────────────────────────

  startItemMove(itemId: string): void {
    this.itemMovingId.set(itemId);
    const item = this.vaultService.items().find(i => i.id === itemId);
    this.itemMoveTargetId.set(item?.folderId ?? '');
  }

  cancelItemMove(): void { this.itemMovingId.set(null); }

  async commitItemMove(): Promise<void> {
    const id = this.itemMovingId();
    if (!id) return;
    const folderId = this.itemMoveTargetId() || null;
    this.itemMoveSaving.set(true);
    await this.vaultService.updateItemMeta(id, { folderId });
    this.itemMoveSaving.set(false);
    this.cancelItemMove();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  navigateToFolder(folderId: string | null): void {
    if (folderId) this.router.navigate(['/items'], { queryParams: { folder: folderId } });
  }

  getItemTypeIcon(type: string): string {
    switch (type) {
      case 'login': return 'fas fa-key';
      case 'card': return 'fas fa-credit-card';
      case 'note': return 'fas fa-note-sticky';
      case 'identity': return 'fas fa-id-card';
      default: return 'fas fa-key';
    }
  }

  getParentOptions(excludePath: string): Folder[] {
    return this.allFolders().filter(f =>
      f.name !== excludePath && !f.name.startsWith(excludePath + '/')
    );
  }

  totalItemCount(): number { return this.vaultService.items().length; }
}
