# WardenDeck — Project Plan
> Stack: Electron + Angular 21 | Integrates via Bitwarden CLI & REST API

---

## Project Overview

A cross-platform (Mac, Windows, Linux) system tray companion app for Bitwarden power users. It fills the gaps Bitwarden has left open for years: tags, auto-type, quick access, expiry reminders, smart views, and automated backups — all in one cohesive desktop app.

**Name:** WardenDeck
**License:** MIT (open source, Goldwarden-style)
**Distribution:** GitHub Releases, Homebrew (Mac), winget (Windows), AUR (Linux)

---

## Angular 21 Standards & Coding Philosophy

All Angular code in WardenDeck must follow Angular 21 best practices. Every developer and AI agent working on this project must adhere to these rules without exception.

### Mandatory Angular 21 Patterns

**Signals everywhere — no RxJS for state.**
All component and service state must use Angular signals (`signal()`, `computed()`, `effect()`). Do not use `BehaviorSubject` or `ReplaySubject` for local state. RxJS is permitted only for event streams that are inherently push-based (e.g. IPC message streams), and must be converted to signals at the boundary via `toSignal()`.

```typescript
// ✅ Correct
readonly vaultItems = signal<VaultItem[]>([]);
readonly filteredItems = computed(() =>
  this.vaultItems().filter(i => i.tags.includes(this.activeTag()))
);

// ❌ Wrong
vaultItems$ = new BehaviorSubject<VaultItem[]>([]);
```

**Zoneless change detection — required for all components.**
Every component must use `ChangeDetectionStrategy.OnPush`. New projects must be scaffolded with `--experimental-zoneless`. Zone.js is not used in this project.

```typescript
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  ...
})
```

**Standalone components only — no NgModules.**
Every component, directive, and pipe must be standalone (`standalone: true`). NgModules are forbidden. Lazy-load feature routes using `loadComponent`.

```typescript
// ✅ Correct
@Component({
  standalone: true,
  imports: [CommonModule, ItemCardComponent],
  ...
})

// ❌ Wrong — no NgModules
@NgModule({ declarations: [...] })
```

**Modern control flow syntax — no structural directives.**
Use the built-in `@if`, `@for`, `@switch` template control flow syntax. Do not use `*ngIf`, `*ngFor`, or `*ngSwitch`.

```html
<!-- ✅ Correct -->
@if (isLoading()) {
  <app-spinner />
} @else {
  @for (item of filteredItems(); track item.id) {
    <app-item-card [item]="item" />
  }
}

<!-- ❌ Wrong -->
<app-spinner *ngIf="isLoading"></app-spinner>
<app-item-card *ngFor="let item of items" [item]="item"></app-item-card>
```

**`inject()` function — no constructor injection.**
Use the `inject()` function for dependency injection in all components and services. Constructor injection is not used.

```typescript
// ✅ Correct
export class TagsComponent {
  private readonly vaultService = inject(VaultService);
  private readonly tagService = inject(TagService);
}

// ❌ Wrong
constructor(private vaultService: VaultService) {}
```

**Typed reactive forms (Signal Forms).**
Use Angular 21's Signal Forms API for all forms. Do not use `FormBuilder` or `ReactiveFormsModule` with the old `FormGroup`/`FormControl` pattern.

**`input()` and `output()` signals — no decorators.**
Use the new signal-based `input()` and `output()` APIs for all component I/O. Do not use `@Input()` or `@Output()` decorators.

```typescript
// ✅ Correct
export class ItemCardComponent {
  item = input.required<VaultItem>();
  tagClicked = output<string>();
}

// ❌ Wrong
@Input() item!: VaultItem;
@Output() tagClicked = new EventEmitter<string>();
```

**`resource()` for async data loading.**
Use Angular 21's `resource()` API for all async data fetching. Do not use `ngOnInit` + subscribe patterns.

```typescript
readonly vaultResource = resource({
  request: () => ({ tag: this.activeTag() }),
  loader: ({ request }) => this.vaultService.getItemsByTag(request.tag)
});
```

**`viewChild()` / `viewChildren()` signals — no `@ViewChild`.**

```typescript
// ✅ Correct
readonly searchInput = viewChild.required<ElementRef>('searchInput');

// ❌ Wrong
@ViewChild('searchInput') searchInput!: ElementRef;
```

### Modularity Rules

Every feature must be self-contained. These rules apply to all modules:

- **One responsibility per file.** Components handle only template logic. Services handle only business logic. No fat components.
- **No cross-feature imports.** Features may only import from `shared/` or `core/`. Features must never import directly from other feature folders.
- **Shared components must be generic.** Any component used in more than one feature lives in `shared/components/` and must have no feature-specific logic.
- **Services are `providedIn: 'root'` unless scoped.** Feature-specific services that should not be global use `providers: []` on the route or component.
- **Barrel files (`index.ts`) for every folder.** Every `components/`, `services/`, and `pipes/` folder exports via a barrel file to keep imports clean.
- **Lazy-load every feature route.** No feature is eagerly loaded. All routes use `loadComponent` or `loadChildren`.

```typescript
// app.routes.ts
export const routes: Routes = [
  {
    path: 'tags',
    loadComponent: () =>
      import('./features/tags/tags.component').then(m => m.TagsComponent)
  },
  {
    path: 'expiry',
    loadComponent: () =>
      import('./features/expiry/expiry.component').then(m => m.ExpiryComponent)
  }
];
```

### Testing Standards

- **Vitest** is the test runner (default in Angular 21). No Karma, no Jasmine.
- Every service must have unit tests covering its public API.
- Every component must have at least one smoke test confirming it renders.
- Signal-based state must be tested by verifying computed values after signal mutations — do not test implementation internals.

---

## Core Integration Strategy

All features are built on top of the **Bitwarden CLI** (`bw`) and optionally the **Bitwarden Public API**. The app:

1. Detects an installed `bw` CLI on first launch, or bundles a pinned version
2. Authenticates once; encrypts the session token with `safeStorage.encryptString()` and persists it to `app.getPath('userData')`
3. Syncs the vault on launch and on a configurable interval
4. Caches a local decrypted snapshot in memory only — never written to disk unencrypted
5. Persists metadata (tags, expiry dates, backup config) in a local SQLite database using `better-sqlite3`

---

## Feature Modules

---

### Module 1 — Tag / Label Manager

**What it solves:** Bitwarden only supports one folder per item and has no tagging system. Users with large vaults have nowhere to go.

**How it works:**
- Tags are stored in a dedicated Bitwarden custom field named `_bwc_tags` (pipe-delimited string)
- The app reads and writes this field via `bw edit` — vault entries are never duplicated or moved
- Tags are indexed locally in SQLite for fast filtering

**UI Components (Angular — all standalone):**
- `TagSidebarComponent` — tag cloud + folder tree, collapsible
- `ItemListComponent` — filterable, sortable item list (shared)
- `TagChipInputComponent` — inline chip input on each item card (shared)
- `BulkTagModalComponent` — select multiple items → assign/remove tags at once
- `TagManagerComponent` — rename, merge, delete tags globally

**Key Routes (lazy-loaded):**
- `/tags` — full tag browser
- `/items?tag=work&folder=Finance` — combined filter view
- `/settings/tags` — global tag management

**Signals pattern:**
```typescript
// tag.service.ts
export class TagService {
  private readonly _allTags = signal<string[]>([]);
  readonly allTags = this._allTags.asReadonly();
  readonly activeTag = signal<string | null>(null);
  readonly taggedItems = computed(() =>
    this.vaultService.items().filter(i =>
      this.activeTag() ? i.tags.includes(this.activeTag()!) : true
    )
  );
}
```

**Technical Notes:**
- Use `bw list items` then parse `fields[]` for `_bwc_tags`
- Write back with `bw edit item <id>` passing updated JSON
- Debounce writes; batch edits where possible to avoid CLI rate hammering

---

### Module 2 — Auto-Type (Mac & Windows)

**What it solves:** Bitwarden's own roadmap lists this as still in development as of January 2026. KeePass users consider it non-negotiable.

**How it works:**
- User focuses a login field in any native app
- Triggers global hotkey (configurable, default: `Ctrl+Alt+A` / `Cmd+Alt+A`)
- A borderless Electron overlay appears with fuzzy vault search
- User selects an entry; the app types username, Tab, password into the previously focused window
- Optionally appends Enter to submit

**Sequence:**
1. `globalShortcut.register()` captures the hotkey even when app is in tray
2. Record the previously focused window/process using `active-win` npm package
3. Show frameless `BrowserWindow` (Angular component) for search
4. On selection, hide the overlay and restore focus to the target window
5. Use `@nut-tree/nut-js` (cross-platform) for keyboard simulation

**UI Components (Angular — all standalone):**
- `AutoTypeOverlayComponent` — frameless search popup host
- `VaultSearchInputComponent` — fuzzy search input (shared with launcher)
- `AutoTypeResultRowComponent` — item row with favicon, username, URL
- `SequencePickerComponent` — `user+pass`, `pass only`, `user only`, `user+pass+Enter`

**Config Options:**
- Global hotkey (remappable)
- Type delay between keystrokes (default 30ms)
- Auto-clear clipboard after N seconds if copy mode is used instead
- Exclude certain vault folders from auto-type results

**Technical Notes:**
- `@nut-tree/nut-js` handles typing on Mac, Windows, Linux
- On Wayland (Linux), fall back to `wtype` CLI if nut-js unavailable
- App must be signed on Mac for accessibility permissions (`AXIsProcessTrusted`)
- Prompt user to grant Accessibility permission on first use (Mac)

---

### Module 3 — Smart Views / Saved Filters

**What it solves:** Users can't save complex filter combinations in Bitwarden. Every session starts from scratch.

**How it works:**
- Any combination of tags, folders, item types, URI matches, age ranges, and TOTP presence can be saved as a named "Smart View"
- Smart Views appear in the sidebar like folders
- Views auto-update on vault sync

**Filter Criteria (combinable with AND/OR):**
- Tag = X
- Folder = Y
- Item type = Login / Card / Identity / Note
- URI contains / starts with / matches domain
- Last modified before/after date
- Password age > N days
- Has TOTP: yes/no
- Has attachment: yes/no
- Created by (org vaults)

**UI Components (Angular — all standalone):**
- `SmartViewBuilderComponent` — drag-and-drop condition rows (Angular CDK)
- `FilterConditionRowComponent` — individual condition (operator + value) — reusable
- `SmartViewSidebarEntryComponent` — sidebar entry with item count badge
- `SmartViewListComponent` — full list of saved views, pinnable

**Technical Notes:**
- Store Smart View definitions as JSON in SQLite `smart_views` table
- Re-evaluate on every vault sync cycle via `effect()` watching `vaultService.lastSynced`
- Views are local only — not synced to Bitwarden

---

### Module 4 — Password Expiry Reminders

**What it solves:** KeePass has had expiry date support since its first release. Bitwarden has never shipped it. IT users managing service accounts, API keys, and certificates constantly request this.

**How it works:**
- Expiry dates are stored in a Bitwarden custom field named `_bwc_expires` (ISO 8601 date string)
- The app reads these on vault sync and schedules OS notifications via Electron's `Notification` API
- A dedicated "Expiring Soon" Smart View is auto-created showing items expiring within the configured window

**Reminder Rules (configurable):**
- Notify N days before expiry (default: 30, 7, 1)
- Notify on the expiry date itself
- Notify for already-expired items on each app launch
- Snooze a reminder for N days

**UI Components (Angular — all standalone):**
- `ExpiryDatePickerComponent` — date picker on each item detail view (shared)
- `ExpiryDashboardWidgetComponent` — "Expiring Soon" widget for home screen
- `ExpiryBadgeComponent` — inline badge (yellow = soon, red = expired) (shared)
- `BulkExpiryEditorComponent` — set expiry on multiple items at once
- `ExpiryReportComponent` — items grouped by: Expired / This Week / This Month / OK

**Notification Format:**
- Title: `⚠️ Password Expiring Soon`
- Body: `[Item Name] expires in 7 days. Click to open.`
- Click action: opens item detail in app

**Technical Notes:**
- Schedule checks on app launch and every 12 hours via `setInterval`
- Use `electron-store` to persist "snoozed" notification state between sessions
- Respect OS Do Not Disturb via Electron's notification API
- `ExpiryService` exposes a `computed()` that groups items by expiry status — consumed by both the widget and the report screen

---

### Module 5 — Global Quick-Access Launcher

**What it solves:** Users want a 1Password-style global popup (`Ctrl+Alt+\`) to search their vault and copy credentials without opening a browser or the full Bitwarden app. Heavily requested in the community for years.

**How it works:**
- Global hotkey (distinct from auto-type hotkey) summons a launcher popup from the tray
- User types to fuzzy-search the vault
- Arrow keys navigate; Enter copies the password; Tab cycles through copy targets (username / password / TOTP / URL)
- Esc dismisses with no action
- Popup auto-dismisses after 30 seconds of inactivity

**Distinct from Auto-Type:**
| | Quick Launcher | Auto-Type |
|---|---|---|
| Trigger | Global hotkey | Global hotkey |
| Output | Copies to clipboard | Types into focused window |
| Use case | Browser/terminal copy-paste | Native app login forms |
| Focus required | None | Must have target window |

**UI Components (Angular — all standalone):**
- `LauncherWindowComponent` — frameless popup host, ~480px wide (Alfred/Raycast aesthetic)
- `VaultSearchInputComponent` — shared with auto-type overlay
- `LauncherResultRowComponent` — favicon + site name + username + item type chip
- `TotpCountdownRingComponent` — live TOTP countdown ring + refreshing code (shared)
- `LauncherHintBarComponent` — footer: `Enter` copy pw · `Tab` cycle · `⌘C` copy user · `Esc` close

**Config Options:**
- Hotkey (remappable)
- Max results shown (default: 8)
- Prefer username copy vs password copy on Enter
- Auto-clear clipboard after N seconds (default: 30)
- Show/hide TOTP codes in results

**Technical Notes:**
- Separate `BrowserWindow` from auto-type overlay — different sizing and behavior
- Use `alwaysOnTop: true` and `skipTaskbar: true`
- Position window near cursor using `screen.getCursorScreenPoint()`
- Fuzzy search powered by `fuse.js` against in-memory vault cache
- `VaultSearchInputComponent` is shared between the launcher and auto-type overlay — parameterised by `mode` input signal

---

### Module 6 — Scheduled Encrypted Backup

**What it solves:** Bitwarden has no automated backup system. Users must manually export. For self-hosters especially, losing vault access without a backup is catastrophic.

**How it works:**
- App runs `bw export --format encrypted_json` on a configurable schedule
- Exports are saved to one or more configured destinations
- Each backup file is independently encrypted (Bitwarden's own export encryption)
- Old backups are pruned based on retention policy

**Backup Destinations:**
- Local folder (always available)
- Network share / mapped drive (any path the OS can write to)
- Amazon S3 / Cloudflare R2 (via `@aws-sdk/client-s3`)
- Backblaze B2 (S3-compatible, same SDK)
- Custom WebDAV endpoint (via `webdav` npm package)

**Schedule Options:**
- Every N hours
- Daily at specific time
- Weekly on specific day + time
- On vault sync (every sync triggers a backup check — backs up if vault changed)
- Manual trigger (button in UI)

**Retention Policy:**
- Keep last N backups (default: 10)
- Keep daily backups for N days
- Keep weekly backups for N weeks
- Never delete (manual mode)

**UI Components (Angular — all standalone):**
- `BackupSettingsComponent` — destination config, schedule config, retention config
- `BackupDestinationCardComponent` — reusable card per destination (local / S3 / WebDAV)
- `BackupHistoryTableComponent` — timestamp, destination, file size, status
- `BackupProgressIndicatorComponent` — shared progress indicator (shared)
- `BackupStatusBadgeComponent` — inline success/fail badge (shared)

**Filename Format:**
```
wardendeck-backup-2026-05-28T14-30-00.json
```

**Technical Notes:**
- Run `bw export` as a child process; capture stdout
- Use `node-cron` for scheduling
- Store backup config and history in SQLite `backups` table
- Never log vault contents — log only metadata (timestamp, size, destination, status)
- On cloud destinations, verify write access on config save (test upload)

---

## App Shell & Infrastructure

### System Tray
- App lives entirely in the tray — no persistent window in the taskbar
- Tray icon states: Locked (grey), Synced (color), Syncing (spinner), Error (red dot)
- Tray menu: Quick Lock · Sync Now · Open App · Settings · Quit
- Tray tooltip: `WardenDeck — Last synced: 2 min ago · Next backup: 6h`

### Main Window
- Angular SPA inside Electron `BrowserWindow`
- Side navigation: Home · Items · Tags · Smart Views · Expiring · Backup · Settings
- Home dashboard: vault health summary, expiry widget, last backup status, recent items

### Authentication Flow
1. First launch: prompt for Bitwarden server URL (cloud or self-hosted)
2. Run `bw login` via child process; capture session key
3. Encrypt session key with `safeStorage.encryptString()` and persist to `app.getPath('userData')`
4. On subsequent launches: `bw unlock` using stored master password hash or biometric (where available)
5. Session expiry handled gracefully — re-prompt without losing app state

### Angular Architecture

Every folder has a barrel `index.ts`. Features are lazy-loaded. No NgModules anywhere.

```
src/
  app/
    core/                         # Singleton services, providedIn: 'root'
      bw-cli.service.ts           # CLI wrapper (spawn, parse, typed outputs)
      vault.service.ts            # In-memory vault cache + sync — signal-based
      keychain.service.ts         # electron safeStorage integration
      notification.service.ts     # Electron Notification API wrapper
      db.service.ts               # better-sqlite3 wrapper
      electron-api.service.ts     # Typed wrapper around contextBridge API
      index.ts
    features/
      tags/                       # Module 1 — lazy-loaded
        components/
          tag-sidebar/
          tag-manager/
          bulk-tag-modal/
          index.ts
        services/
          tag.service.ts
          index.ts
        tags.component.ts         # Route entry point
        tags.routes.ts
      auto-type/                  # Module 2 — loaded in overlay window
        components/
          auto-type-overlay/
          sequence-picker/
          index.ts
        services/
          auto-type.service.ts
          index.ts
        auto-type.component.ts
      smart-views/                # Module 3 — lazy-loaded
        components/
          smart-view-builder/
          filter-condition-row/
          smart-view-list/
          index.ts
        services/
          smart-view.service.ts
          filter-engine.service.ts
          index.ts
        smart-views.component.ts
        smart-views.routes.ts
      expiry/                     # Module 4 — lazy-loaded
        components/
          expiry-report/
          bulk-expiry-editor/
          index.ts
        services/
          expiry.service.ts
          index.ts
        expiry.component.ts
        expiry.routes.ts
      launcher/                   # Module 5 — loaded in launcher window
        components/
          launcher-window/
          launcher-result-row/
          launcher-hint-bar/
          index.ts
        services/
          launcher.service.ts
          index.ts
        launcher.component.ts
      backup/                     # Module 6 — lazy-loaded
        components/
          backup-settings/
          backup-destination-card/
          backup-history-table/
          index.ts
        services/
          backup.service.ts
          backup-scheduler.service.ts
          index.ts
        backup.component.ts
        backup.routes.ts
    shared/
      components/
        item-card/                # Used across tags, smart-views, expiry
        item-list/                # Generic filterable list
        vault-search-input/       # Shared by launcher + auto-type
        totp-countdown-ring/      # Shared by launcher + item detail
        expiry-badge/             # Shared by item-card + expiry report
        expiry-date-picker/       # Shared by item detail + bulk editor
        backup-progress-indicator/
        backup-status-badge/
        favicon/                  # Favicon resolver + img component
        index.ts
      pipes/
        password-age.pipe.ts
        time-until.pipe.ts
        index.ts
      directives/
        auto-focus.directive.ts
        keyboard-nav.directive.ts
        index.ts
      models/
        vault-item.model.ts
        smart-view.model.ts
        backup-job.model.ts
        index.ts
    app.component.ts              # Root standalone component
    app.routes.ts                 # All routes lazy-loaded
    app.config.ts                 # provideRouter, provideHttpClient, etc.
```

### Electron Main Process
```
electron/
  main.ts                         # App lifecycle, tray, window management
  preload.ts                      # contextBridge — typed ElectronAPI surface
  ipc/
    vault.ipc.ts                  # IPC handlers for vault operations
    backup.ipc.ts                 # IPC handlers for backup jobs
    autotype.ipc.ts               # IPC handlers for keyboard simulation
    index.ts
  shortcuts/
    global-shortcuts.ts           # globalShortcut registrations
  tray/
    tray-manager.ts               # Tray icon + menu
  windows/
    main-window.ts                # Main BrowserWindow factory
    launcher-window.ts            # Frameless launcher popup factory
    autotype-window.ts            # Frameless auto-type overlay factory
```

### IPC Pattern

Angular renderer → `window.electronAPI.invoke('vault:sync')` → Electron main → CLI → typed response back to renderer. Use `contextBridge` with a fully typed `ElectronAPI` interface — never expose `ipcRenderer` directly.

```typescript
// shared/models/electron-api.model.ts
export interface ElectronAPI {
  vault: {
    sync: () => Promise<SyncResult>;
    getItems: () => Promise<VaultItem[]>;
    editItem: (id: string, patch: Partial<VaultItem>) => Promise<void>;
  };
  backup: {
    runNow: () => Promise<BackupResult>;
    getHistory: () => Promise<BackupJob[]>;
  };
  autotype: {
    type: (sequence: TypeSequence) => Promise<void>;
  };
}
```

---

## Key Dependencies

| Package | Purpose |
|---|---|
| `electron` | App shell |
| `@angular/core` v21 | UI framework — signals, zoneless, standalone |
| `better-sqlite3` | Local metadata storage |
| `electron safeStorage` (built-in) | OS credential encryption — replaces deprecated `keytar` |
| `@nut-tree/nut-js` | Keyboard simulation (auto-type) |
| `active-win` | Detect previously focused window |
| `fuse.js` | Fuzzy search for launcher |
| `node-cron` | Backup scheduling |
| `electron-store` | Simple key/value app config |
| `@aws-sdk/client-s3` | S3 / R2 / B2 backup destinations |
| `webdav` | WebDAV backup destination |
| `electron-updater` | Auto-update via GitHub Releases |
| `vitest` | Unit testing (Angular 21 default) |
| `@angular/cdk` | Drag-and-drop for Smart View builder |

---

## Build & Distribution

- **Bundler:** `electron-builder`
- **Mac:** `.dmg` + Homebrew cask; requires code signing + notarization for Accessibility permission
- **Windows:** `.exe` NSIS installer + winget manifest
- **Linux:** `.AppImage` + `.deb` + AUR PKGBUILD
- **Auto-update:** `electron-updater` pointing to GitHub Releases
- **CI:** GitHub Actions — build matrix for mac/win/linux on every tagged release

---

## Phased Rollout

### Phase 1 — Foundation (Weeks 1–4)
- Electron + Angular 21 scaffold (zoneless, standalone, signals)
- `ElectronAPI` contextBridge surface + typed IPC handlers
- Bitwarden CLI integration service (signal-based vault cache)
- Session management + `safeStorage` encryption
- System tray shell + main/launcher/autotype window factories
- Basic item list UI using `ItemListComponent` + `ItemCardComponent`

### Phase 2 — Tag Manager (Weeks 5–8)
- `TagService` with signal-based tag index
- Custom field read/write for `_bwc_tags`
- `TagSidebarComponent`, `TagChipInputComponent`, `BulkTagModalComponent`
- SQLite tag index
- **First public release (alpha)**

### Phase 3 — Quick Launcher + Auto-Type (Weeks 9–13)
- Global hotkey registration
- `LauncherWindowComponent` + `VaultSearchInputComponent` (shared)
- Clipboard copy with auto-clear
- `AutoTypeOverlayComponent` + nut-js keyboard simulation (Mac + Windows)
- Mac Accessibility permission flow
- **Beta release**

### Phase 4 — Smart Views + Expiry (Weeks 14–18)
- `FilterEngineService` + `SmartViewBuilderComponent` with Angular CDK drag-and-drop
- SQLite persistence for Smart View definitions
- `ExpiryService` with computed grouping by expiry status
- `ExpiryDashboardWidgetComponent` + `ExpiryReportComponent`
- OS notification scheduling

### Phase 5 — Backup + Polish (Weeks 19–24)
- `BackupService` + `BackupSchedulerService` (node-cron)
- Local + S3 + WebDAV destination adapters
- `BackupHistoryTableComponent` + `BackupSettingsComponent`
- Auto-updater
- App signing (Mac notarization, Windows EV cert)
- Vitest coverage to 80%+
- **v1.0 public release**

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Bitwarden ships auto-type before Phase 3 | Launcher popup still fills a gap; pivot to deeper smart views |
| `bw` CLI changes its output format | Pin a bundled CLI version; test against multiple versions in CI |
| Mac Accessibility permission friction | First-launch wizard with screenshots; link to Apple support doc |
| nut-js compatibility issues | Fallback to `robotjs` or native AppleScript/PowerShell per platform |
| Bitwarden adds native tags | Differentiate on backup + expiry + launcher; tags become a sync bridge |
| Signal Forms still experimental in v21 | Use standard form controls for now; migrate to Signal Forms when stable in v22 |

---

## What Makes This Defensible

Bitwarden is a large company that moves deliberately. They add features on 12–18 month cycles and always prioritize the browser extension over the desktop app. WardenDeck targets the desktop-first power user — IT professionals, developers, and security-conscious individuals — who will not wait and will pay for or star a polished open source tool that respects their workflow today.

The combination of **tags + auto-type + launcher + expiry + backups** in a single app with a coherent UX is something no existing third-party Bitwarden tool offers. Built on Angular 21's signal-first architecture and Electron's cross-platform shell, the codebase stays lean, modular, and maintainable as features are added over time.
