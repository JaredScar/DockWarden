import { Component, signal, inject, OnInit, OnDestroy, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { VaultService } from '../../core/vault.service';
import { App } from '../../app';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsComponent implements OnInit, OnDestroy {
  private readonly vaultService = inject(VaultService);
  private readonly router = inject(Router);

  // ── BW connection ──────────────────────────────────────────────────────────
  readonly bwEmail = signal('');
  readonly bwServerUrl = signal('https://bitwarden.com');
  readonly bwCliPath = signal('bw');
  readonly bwCliVersion = signal<string | null>(null);
  readonly bwCliAvailable = signal<boolean | null>(null);
  readonly bwCheckingCli = signal(false);

  // ── General settings ───────────────────────────────────────────────────────
  readonly serverUrl = signal('vault.bitwarden.com');
  readonly syncInterval = signal('5 minutes');
  readonly launcherShortcut = signal('Ctrl+Alt+\\');
  readonly autotypeShortcut = signal('Ctrl+Alt+A');
  readonly lockShortcut = signal('Ctrl+L');
  readonly keystrokeDelay = signal(30);
  readonly autoSubmit = signal(true);
  readonly clearClipboard = signal(30);
  readonly expiryReminders = signal(true);
  readonly backupAlerts = signal(true);
  readonly syncStatus = signal(true);
  readonly autoLock = signal('15 minutes');
  readonly lockOnSleep = signal(true);
  readonly biometricUnlock = signal(false);
  readonly theme = signal('Dark');
  readonly startMinimized = signal(true);
  readonly startWithSystem = signal(true);
  readonly savingCliPath = signal(false);

  readonly syncIntervals = ['1 minute', '5 minutes', '15 minutes', '30 minutes', '1 hour'];
  readonly autoLockOptions = ['1 minute', '5 minutes', '15 minutes', '30 minutes', '1 hour', 'Never'];
  readonly themes = ['Dark', 'Light', 'System'];

  // ── Custom CSS ─────────────────────────────────────────────────────────────
  readonly customCss = signal('');
  readonly cssLivePreview = signal(true);
  readonly cssDirty = signal(false);
  readonly cssSaving = signal(false);
  readonly cssSaved = signal(false);
  readonly showVarRef = signal(true);
  private _cssDebounce?: ReturnType<typeof setTimeout>;

  readonly cssPresets: { label: string; icon: string; css: string }[] = [
    {
      label: 'Wider sidebar',
      icon: 'fas fa-left-right',
      css: ':root { --sidebar-width: 260px; }',
    },
    {
      label: 'Purple accent',
      icon: 'fas fa-circle',
      css: ':root {\n  --accent-blue: #8b5cf6;\n  --bg-selected: rgba(139, 92, 246, 0.15);\n}',
    },
    {
      label: 'Rose accent',
      icon: 'fas fa-circle',
      css: ':root {\n  --accent-blue: #f43f5e;\n  --bg-selected: rgba(244, 63, 94, 0.15);\n}',
    },
    {
      label: 'Compact density',
      icon: 'fas fa-compress',
      css: '.nav-item { padding: 5px 8px !important; }\n.nav-item-sm { padding: 3px 6px !important; }',
    },
    {
      label: 'Larger text',
      icon: 'fas fa-text-height',
      css: ':root { font-size: 15px; }',
    },
    {
      label: 'Custom border radius',
      icon: 'fas fa-vector-square',
      css: ':root {\n  --radius-sm: 2px;\n  --radius-md: 4px;\n  --radius-lg: 6px;\n}',
    },
  ];

  /** Array 1..N for the line-number gutter */
  cssLineNumbers = () => {
    const count = Math.max(this.customCss().split('\n').length, 10);
    return Array.from({ length: count }, (_, i) => i + 1);
  };

  readonly cssVarGroups: { label: string; vars: { name: string; desc: string }[] }[] = [
    {
      label: 'Backgrounds',
      vars: [
        { name: '--bg-primary',    desc: 'Main content background' },
        { name: '--bg-secondary',  desc: 'Secondary background' },
        { name: '--bg-sidebar',    desc: 'Sidebar background' },
        { name: '--bg-card',       desc: 'Card / panel background' },
        { name: '--bg-card-hover', desc: 'Card hover state' },
        { name: '--bg-selected',   desc: 'Selected item background' },
        { name: '--bg-tertiary',   desc: 'Tertiary / input background' },
      ],
    },
    {
      label: 'Text',
      vars: [
        { name: '--text-primary',   desc: 'Primary text' },
        { name: '--text-secondary', desc: 'Secondary / muted text' },
        { name: '--text-muted',     desc: 'Placeholder / disabled' },
      ],
    },
    {
      label: 'Accent colours',
      vars: [
        { name: '--accent-blue',   desc: 'Primary actions (#3b82f6)' },
        { name: '--accent-green',  desc: 'Success (#22c55e)' },
        { name: '--accent-red',    desc: 'Danger (#ef4444)' },
        { name: '--accent-yellow', desc: 'Warning (#f59e0b)' },
        { name: '--accent-purple', desc: 'Highlight (#a855f7)' },
      ],
    },
    {
      label: 'Layout',
      vars: [
        { name: '--sidebar-width', desc: 'Sidebar width (default 220px)' },
        { name: '--border',        desc: 'Border / divider colour' },
        { name: '--radius-sm',     desc: 'Small border-radius' },
        { name: '--radius-md',     desc: 'Medium border-radius' },
        { name: '--radius-lg',     desc: 'Large border-radius' },
        { name: '--transition',    desc: 'Default transition speed' },
      ],
    },
  ];

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async ngOnInit(): Promise<void> {
    if (window.electronAPI) {
      const config = await window.electronAPI.bw.getConfig();
      if (config.bwEmail) this.bwEmail.set(config.bwEmail);
      if (config.bwServerUrl) this.bwServerUrl.set(config.bwServerUrl);
      if (config.bwCliPath) this.bwCliPath.set(config.bwCliPath);

      const saved = await window.electronAPI.app.getStore('customCSS') as string | null;
      if (saved) this.customCss.set(saved);
    }
    await this.checkCli();
  }

  ngOnDestroy(): void {
    clearTimeout(this._cssDebounce);
  }

  // ── BW methods ─────────────────────────────────────────────────────────────

  async checkCli(): Promise<void> {
    if (!window.electronAPI) return;
    this.bwCheckingCli.set(true);
    try {
      const result = await window.electronAPI.bw.checkCli();
      this.bwCliAvailable.set(result.success);
      this.bwCliVersion.set(result.version);
    } catch {
      this.bwCliAvailable.set(false);
    } finally {
      this.bwCheckingCli.set(false);
    }
  }

  async saveCliPath(): Promise<void> {
    if (!window.electronAPI) return;
    this.savingCliPath.set(true);
    try {
      await window.electronAPI.bw.setCliPath(this.bwCliPath());
      await this.checkCli();
    } finally {
      this.savingCliPath.set(false);
    }
  }

  async lockVault(): Promise<void> {
    await this.vaultService.lock();
    this.router.navigate(['/unlock']);
  }

  async logoutVault(): Promise<void> {
    await this.vaultService.logout();
    this.router.navigate(['/unlock']);
  }

  // ── CSS methods ────────────────────────────────────────────────────────────

  onCssChange(value: string): void {
    this.customCss.set(value);
    this.cssDirty.set(true);
    this.cssSaved.set(false);
    if (this.cssLivePreview()) {
      clearTimeout(this._cssDebounce);
      this._cssDebounce = setTimeout(() => App.injectCSS(value), 400);
    }
  }

  onCssKeydown(e: KeyboardEvent): void {
    // Tab → insert 2 spaces instead of tabbing out
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.target as HTMLTextAreaElement;
      const s = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = ta.value.substring(0, s) + '  ' + ta.value.substring(end);
      ta.value = next;
      ta.selectionStart = ta.selectionEnd = s + 2;
      this.onCssChange(next);
    }
    // Ctrl+S → save
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      this.saveCustomCss();
    }
  }

  async saveCustomCss(): Promise<void> {
    if (!window.electronAPI) return;
    this.cssSaving.set(true);
    await window.electronAPI.app.setStore('customCSS', this.customCss());
    App.injectCSS(this.customCss());
    this.cssSaving.set(false);
    this.cssDirty.set(false);
    this.cssSaved.set(true);
    setTimeout(() => this.cssSaved.set(false), 2500);
  }

  async resetCustomCss(): Promise<void> {
    this.customCss.set('');
    this.cssDirty.set(false);
    this.cssSaved.set(false);
    App.injectCSS('');
    if (window.electronAPI) await window.electronAPI.app.setStore('customCSS', '');
  }

  insertPreset(css: string): void {
    const current = this.customCss().trim();
    const next = current ? `${current}\n\n${css}` : css;
    this.customCss.set(next);
    this.cssDirty.set(true);
    if (this.cssLivePreview()) App.injectCSS(next);
  }

  copyVarName(name: string): void {
    navigator.clipboard?.writeText(`var(${name})`);
  }
}
