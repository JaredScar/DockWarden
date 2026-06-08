import { Injectable, signal, computed, inject } from '@angular/core';
import { VaultService, Folder } from './vault.service';

export interface FolderNode {
  id: string | null;       // actual Bitwarden folder id; null = virtual intermediate node
  name: string;            // last path segment only (display label)
  fullPath: string;        // full "/" delimited BW folder name
  children: FolderNode[];
  depth: number;
}

export interface FolderTreeRow {
  id: string | null;
  label: string;           // display name (last segment)
  fullPath: string;        // full path used for BW CLI
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  directCount: number;     // items directly in this folder
  totalCount: number;      // items in this folder + all descendants
}

@Injectable({ providedIn: 'root' })
export class FolderService {
  private readonly vaultService = inject(VaultService);

  /** Paths that are currently collapsed in the sidebar */
  private readonly _collapsed = signal<Set<string>>(new Set());

  // ── Tree ────────────────────────────────────────────────────────────────────

  readonly tree = computed<FolderNode[]>(() =>
    this._buildTree(this.vaultService.folders())
  );

  // ── Sidebar rows (flat, depth-annotated, visibility-filtered) ──────────────

  readonly sidebarRows = computed<FolderTreeRow[]>(() => {
    const collapsed = this._collapsed();
    const items = this.vaultService.items();
    const tree = this.tree();

    const countTotal = (node: FolderNode): number => {
      const direct = node.id ? items.filter(i => i.folderId === node.id).length : 0;
      return direct + node.children.reduce((s, c) => s + countTotal(c), 0);
    };

    const rows: FolderTreeRow[] = [];

    const flatten = (nodes: FolderNode[], depth: number) => {
      for (const node of nodes) {
        const expanded = !collapsed.has(node.fullPath);
        rows.push({
          id: node.id,
          label: node.name,
          fullPath: node.fullPath,
          depth,
          hasChildren: node.children.length > 0,
          expanded,
          directCount: node.id ? items.filter(i => i.folderId === node.id).length : 0,
          totalCount: countTotal(node),
        });
        if (expanded && node.children.length > 0) {
          flatten(node.children, depth + 1);
        }
      }
    };

    flatten(tree, 0);
    return rows;
  });

  // ── Collapse / expand ───────────────────────────────────────────────────────

  toggle(fullPath: string): void {
    this._collapsed.update(s => {
      const next = new Set(s);
      if (next.has(fullPath)) next.delete(fullPath);
      else next.add(fullPath);
      return next;
    });
  }

  expand(fullPath: string): void {
    this._collapsed.update(s => { const n = new Set(s); n.delete(fullPath); return n; });
  }

  expandAll(): void { this._collapsed.set(new Set()); }

  collapseAll(): void {
    const all = new Set(this.vaultService.folders().map(f => f.name));
    this._collapsed.set(all);
  }

  // ── Folder queries ──────────────────────────────────────────────────────────

  /** Get all descendant folder IDs (not including self) */
  getDescendantIds(folderId: string): string[] {
    const folder = this.vaultService.folders().find(f => f.id === folderId);
    if (!folder) return [];
    const prefix = folder.name + '/';
    return this.vaultService.folders()
      .filter(f => f.name.startsWith(prefix))
      .map(f => f.id);
  }

  /** Get all folder IDs in a subtree (self + descendants) */
  getSubtreeIds(folderId: string): Set<string> {
    return new Set([folderId, ...this.getDescendantIds(folderId)]);
  }

  getById(id: string): Folder | undefined {
    return this.vaultService.folders().find(f => f.id === id);
  }

  getByPath(fullPath: string): Folder | undefined {
    return this.vaultService.folders().find(f => f.name === fullPath);
  }

  /** Returns just the last segment of a folder's full path name */
  getDisplayName(fullPath: string): string {
    const parts = fullPath.split('/');
    return parts[parts.length - 1];
  }

  getParentPath(fullPath: string): string | null {
    const parts = fullPath.split('/');
    return parts.length > 1 ? parts.slice(0, -1).join('/') : null;
  }

  // ── CRUD (delegates to VaultService which calls IPC) ───────────────────────

  async createFolder(fullPath: string): Promise<{ success: boolean; folder?: Folder; error?: string }> {
    return this.vaultService.createFolder(fullPath);
  }

  /** Rename a single folder (does NOT cascade — use renameWithCascade for parent renames) */
  async renameFolder(id: string, newFullPath: string): Promise<{ success: boolean; error?: string }> {
    return this.vaultService.renameFolder(id, newFullPath);
  }

  /**
   * Rename a virtual (intermediate) folder node by full path — no BW id needed.
   * Replaces all BW folders whose name starts with oldPath.
   */
  async renameWithCascadeByPath(oldPath: string, newLastSegment: string): Promise<{ success: boolean; error?: string }> {
    const parts = oldPath.split('/');
    parts[parts.length - 1] = newLastSegment.trim();
    const newPath = parts.join('/');
    if (oldPath === newPath) return { success: true };
    return this.vaultService.moveFolderTree(oldPath, newPath);
  }

  /**
   * Rename a folder AND all its descendants in one operation.
   * Used when changing a parent folder name so children stay valid.
   */
  async renameWithCascade(folderId: string, newLastSegment: string): Promise<{ success: boolean; error?: string }> {
    const folder = this.vaultService.folders().find(f => f.id === folderId);
    if (!folder) return { success: false, error: 'Folder not found' };

    const parts = folder.name.split('/');
    const oldPath = folder.name;
    parts[parts.length - 1] = newLastSegment.trim();
    const newPath = parts.join('/');

    if (oldPath === newPath) return { success: true };

    // Check if there are descendants that also need renaming
    const hasDescendants = this.vaultService.folders().some(f => f.name.startsWith(oldPath + '/'));

    if (hasDescendants) {
      return this.vaultService.moveFolderTree(oldPath, newPath);
    } else {
      return this.vaultService.renameFolder(folderId, newPath);
    }
  }

  /** Move a folder subtree to a new parent path */
  async moveFolder(folderId: string, newParentPath: string | null): Promise<{ success: boolean; error?: string }> {
    const folder = this.vaultService.folders().find(f => f.id === folderId);
    if (!folder) return { success: false, error: 'Folder not found' };

    const oldPath = folder.name;
    const lastName = this.getDisplayName(oldPath);
    const newPath = newParentPath ? `${newParentPath}/${lastName}` : lastName;

    return this.vaultService.moveFolderTree(oldPath, newPath);
  }

  async deleteFolder(id: string): Promise<{ success: boolean; error?: string }> {
    return this.vaultService.deleteFolder(id);
  }

  // ── Tree builder ────────────────────────────────────────────────────────────

  private _buildTree(folders: Folder[]): FolderNode[] {
    if (folders.length === 0) return [];

    const root: FolderNode[] = [];
    const nodeMap = new Map<string, FolderNode>();

    // Sort so parents are always encountered before children
    const sorted = [...folders].sort((a, b) => a.name.localeCompare(b.name));

    for (const folder of sorted) {
      const parts = folder.name.split('/');

      for (let depth = 0; depth < parts.length; depth++) {
        const fullPath = parts.slice(0, depth + 1).join('/');

        if (nodeMap.has(fullPath)) {
          // Node already exists (created as virtual for a deeper child) — update id if needed
          if (depth === parts.length - 1) {
            const node = nodeMap.get(fullPath)!;
            if (!node.id) node.id = folder.id;
          }
          continue;
        }

        // Actual BW folder for this exact path?
        const actualFolder = sorted.find(f => f.name === fullPath);
        const node: FolderNode = {
          id: depth === parts.length - 1 ? folder.id : (actualFolder?.id ?? null),
          name: parts[depth],
          fullPath,
          children: [],
          depth,
        };

        nodeMap.set(fullPath, node);

        if (depth === 0) {
          root.push(node);
        } else {
          const parentPath = parts.slice(0, depth).join('/');
          nodeMap.get(parentPath)?.children.push(node);
        }
      }
    }

    return root;
  }
}
