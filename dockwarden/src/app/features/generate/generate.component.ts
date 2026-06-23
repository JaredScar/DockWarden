import {
  Component, OnInit, OnDestroy, signal, computed, ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { VaultService, GeneratorSettings, GeneratorOptions, SiteHint, Folder } from '../../core/vault.service';

type SaveMode = 'autotype' | 'copy' | 'save';
type SaveState = 'idle' | 'saving' | 'done' | 'error';

const DEFAULT_SETTINGS: GeneratorSettings = {
  defaultUsername: '',
  length: 20,
  upper: true,
  lower: true,
  numbers: true,
  symbols: true,
  ambiguous: false,
};

@Component({
  selector: 'app-generate',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './generate.component.html',
  styleUrls: ['./generate.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GenerateComponent implements OnInit, OnDestroy {
  readonly siteName    = signal('');
  readonly siteUrl     = signal('');
  readonly username    = signal('');
  readonly password    = signal('');
  readonly showPw      = signal(false);
  readonly generating  = signal(false);
  readonly saveState   = signal<SaveState>('idle');
  readonly saveError   = signal('');
  readonly saveMode    = signal<SaveMode>('save');
  readonly folders     = signal<Folder[]>([]);
  readonly selectedFolder = signal<string>('');
  readonly vaultLocked = signal(false);

  readonly settings = signal<GeneratorSettings>({ ...DEFAULT_SETTINGS });

  readonly strengthLabel = computed(() => {
    const pw = this.password();
    if (!pw) return '';
    const len = pw.length;
    const hasUpper   = /[A-Z]/.test(pw);
    const hasLower   = /[a-z]/.test(pw);
    const hasNumber  = /[0-9]/.test(pw);
    const hasSymbol  = /[^A-Za-z0-9]/.test(pw);
    const variety = [hasUpper, hasLower, hasNumber, hasSymbol].filter(Boolean).length;
    if (len >= 16 && variety >= 3) return 'strong';
    if (len >= 12 && variety >= 2) return 'good';
    if (len >= 8) return 'fair';
    return 'weak';
  });

  readonly canSave = computed(() =>
    !!this.siteName().trim() && !!this.password() && !this.vaultLocked()
  );

  constructor(private vault: VaultService) {}

  async ngOnInit(): Promise<void> {
    if (!window.electronAPI) return;

    // Load persisted generator settings
    const saved = await window.electronAPI.generator.getSettings();
    this.settings.set({ ...DEFAULT_SETTINGS, ...saved });
    this.username.set(saved.defaultUsername || '');

    // Load folders for the selector
    try {
      const folders = await window.electronAPI.vault.getFolders();
      this.folders.set(folders);
    } catch { /* non-critical */ }

    // Check vault state
    try {
      const status = await window.electronAPI.vault.status();
      this.vaultLocked.set(status?.status?.status !== 'unlocked');
    } catch { this.vaultLocked.set(true); }

    // Generate an initial password
    await this.regenerate();

    // Listen for the site hint pushed by the main process
    window.electronAPI.generator.onSiteHint((hint: SiteHint) => {
      if (hint.name && !this.siteName()) this.siteName.set(hint.name);
      if (hint.url  && !this.siteUrl())  this.siteUrl.set(hint.url);
    });

    // Keyboard: Escape → close, Ctrl+Enter → Save & Auto-Type
    this._onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { this.close(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { this.save('autotype'); }
    };
    document.addEventListener('keydown', this._onKey);
  }

  ngOnDestroy(): void {
    document.removeEventListener('keydown', this._onKey!);
    window.electronAPI?.generator.removeListeners();
  }

  private _onKey?: (e: KeyboardEvent) => void;

  async regenerate(): Promise<void> {
    if (!window.electronAPI) return;
    this.generating.set(true);
    try {
      const s = this.settings();
      const pw = await window.electronAPI.generator.generate({
        length: s.length,
        upper: s.upper,
        lower: s.lower,
        numbers: s.numbers,
        symbols: s.symbols,
        ambiguous: s.ambiguous,
      } as GeneratorOptions);
      this.password.set(pw);
    } finally {
      this.generating.set(false);
    }
  }

  async onSettingChange(): Promise<void> {
    // Re-generate whenever options change, and persist settings
    await this.regenerate();
    await this.persistSettings();
  }

  async persistSettings(): Promise<void> {
    if (!window.electronAPI) return;
    await window.electronAPI.generator.setSettings(this.settings());
  }

  async save(mode: SaveMode = this.saveMode()): Promise<void> {
    if (!this.canSave()) return;
    this.saveState.set('saving');
    this.saveError.set('');

    try {
      const result = await this.vault.createItem({
        type: 'login',
        name: this.siteName().trim(),
        username: this.username() || undefined,
        password: this.password(),
        website: this.siteUrl() || undefined,
        folderId: this.selectedFolder() || null,
      });

      if (!result.success) {
        this.saveState.set('error');
        this.saveError.set(result.error || 'Failed to save item.');
        return;
      }

      this.saveState.set('done');

      if (mode === 'copy') {
        await window.electronAPI!.vault.getSetting('clipboardClearDelay', 30);  // warm up
        navigator.clipboard.writeText(this.password()).catch(() => {});
      } else if (mode === 'autotype') {
        setTimeout(async () => {
          await window.electronAPI!.autotype.send(
            this.username(), this.password(), false
          );
        }, 300);
      }

      // Close after a short success flash
      setTimeout(() => { this.close(); }, 1200);
    } catch (err: unknown) {
      this.saveState.set('error');
      this.saveError.set(err instanceof Error ? err.message : 'Unexpected error.');
    }
  }

  close(): void {
    window.electronAPI?.launcher?.close();
    // Fallback for when opened from the main window
    window.close();
  }

  get sliderMin() { return 8; }
  get sliderMax() { return 64; }
}
