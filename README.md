<div align="center">

# 🛡️ DockWarden

### A power-user companion app built on top of Bitwarden.

**Tags · Auto-Type · Smart Views · Expiry Reminders · Quick Launcher · Automated Backups**

[![Electron](https://img.shields.io/badge/Electron-42-47848F?style=flat-square&logo=electron&logoColor=white)](https://electronjs.org)
[![Angular](https://img.shields.io/badge/Angular-21-DD0031?style=flat-square&logo=angular&logoColor=white)](https://angular.dev)
[![Bitwarden CLI](https://img.shields.io/badge/Bitwarden-CLI-175DDC?style=flat-square&logo=bitwarden&logoColor=white)](https://bitwarden.com/help/cli/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](./LICENSE)

<br/>

![Home Dashboard](docs/screenshots/home-dashboard.png)

</div>

---

## 🤔 What is DockWarden?

Bitwarden is an exceptional password manager — open-source, self-hostable, and trusted by millions. DockWarden is a desktop companion app that builds directly on top of it, adding a layer of power-user workflows that close the gap with tools like **1Password** — without asking you to leave Bitwarden.

Everything DockWarden does uses the **official Bitwarden CLI** under the hood. Your vault stays in Bitwarden, your credentials stay encrypted by Bitwarden, and your account stays under your control. DockWarden simply extends what you can do with it.

### Why not just switch to 1Password?

1Password has a strong feature set, but it is a **closed-source, proprietary SaaS product**. Bitwarden is open-source and self-hostable. For many users — individuals, businesses, and security-conscious teams — those properties are non-negotiable. DockWarden lets you keep all of Bitwarden's advantages and gain the desktop experience quality you'd expect from 1Password.

| Feature | 1Password | Bitwarden (native) | DockWarden + Bitwarden |
|---|:---:|:---:|:---:|
| Tag / label system | ✅ | ❌ | ✅ |
| Auto-Type into native apps | ✅ | ❌ | ✅ |
| Global quick-search launcher | ✅ | ❌ | ✅ |
| Auto-select top search result | ✅ | ❌ | ✅ |
| Click any field box to copy | ✅ | ❌ | ✅ |
| Smart filters / saved searches | ✅ | ❌ | ✅ |
| Password expiry alerts | ✅ | ❌ | ✅ |
| Scheduled encrypted backups | ❌ | ❌ | ✅ |
| Open source | ❌ | ✅ | ✅ |
| Self-hostable vault | ❌ | ✅ | ✅ |
| Custom CSS / theming | ❌ | ❌ | ✅ |

> Your **vault data never leaves Bitwarden**. Tags, expiry dates, and other metadata are written to Bitwarden's own custom fields — encrypted at rest in your Bitwarden vault.

---

## ✨ Features

### 🏷️ Tag & Label Manager

Bitwarden's folder system is great for broad organisation, but power users often want to cross-reference items with multiple labels. DockWarden adds a **multi-tag system** stored transparently in custom fields (`_dw_tags`), so your tags are preserved in your Bitwarden vault regardless of what app you use to access them.

- **Bulk editor** — select multiple items, apply or remove tags in one action
- **Tag cloud sidebar** — click any tag to instantly filter the item list
- **Smart tag suggestions** — see existing tags as you type
- **Merge & rename** — combine duplicate tags across your entire vault

![Tag Manager bulk editor](docs/screenshots/tag-manager.png)

---

### ⌨️ Auto-Type *(Windows — Mac coming)*

Press `Ctrl+Alt+A` from **any application**. A floating picker appears on the monitor you're working on. Select the entry — DockWarden minimises itself and types **username → Tab → password → Enter** directly into whatever window had focus before you pressed the shortcut.

- Works with any native app: SSH terminals, legacy desktop apps, RDP sessions, anything
- No browser extension required
- Configurable: type only password, only username, with or without Enter
- Powered by Windows `SendKeys` (no extra dependencies to install)

![Auto-Type picker window](docs/screenshots/auto-type.png)

---

### 🔍 Global Quick Launcher

A **Spotlight/Alfred-style popup** triggered by `Ctrl+Alt+\` that floats on whatever monitor your cursor is on, completely independent of the DockWarden main window.

- Instant fuzzy search across your entire vault (cached in memory — no CLI round-trip)
- `↑↓` to navigate, `Enter` to open the item in the main vault view
- Dismisses when you click away
- Opens on **the monitor you're working on**, not on the DockWarden window

![Quick Launcher floating popup](docs/screenshots/quick-launcher.png)

---

### 🔎 Auto-Select Top Search Result

One of the most-cited quality-of-life differences between 1Password and Bitwarden's desktop app is how search behaves. In 1Password, the best match is selected and its details opened automatically as you type. DockWarden brings the same behaviour to the Bitwarden vault browser.

- Start typing in the search box — the top fuzzy-matched result is **automatically selected and shown** in the detail panel on the right
- No need to click the result first
- Clearing the search returns to your previous selection
- Works the same way in the Quick Launcher floating window

![Item Browser](docs/screenshots/items-browser.png)

---

### ◈ Smart Views

Save complex filter combinations as named "Smart Views" that act like dynamic folders. **Pin any Smart View to the sidebar** to see its live item count and jump straight to the filtered list.

- Filter by: tag, folder, item type, expiry window, favourite status, TOTP presence
- **AND / OR operators** — build precise queries
- **Pinned views** appear in the sidebar with live counts, exactly like folders
- Used as the backbone of the expiry dashboard and tag-based workflows

![Smart Views page](docs/screenshots/smart-views.png)

---

### ⏰ Password Expiry Reminders

DockWarden stores expiry dates in `_dw_expires` custom fields and fires **OS desktop notifications** on a configurable schedule.

- **Dashboard** — grouped view: Expired · Expiring This Week · Expiring This Month
- **System tray notifications** — 30, 7, and 1 day before expiry
- **Configurable reminder rules** — adjust lead times per item type
- Edit expiry dates inline in the item detail panel

![Password Expiry dashboard](docs/screenshots/expiry-dashboard.png)

---

### 💾 Scheduled Encrypted Backup

DockWarden wraps `bw export --format encrypted_json` in a configurable cron job that runs silently in the background.

- **Destinations:** Local folder · AWS S3 · Cloudflare R2 · Backblaze B2 · WebDAV
- **Schedule:** Hourly · Daily · Weekly · On every vault sync
- **Retention policy** — automatically prune old backups
- **Backup history** with file size, status, and destination path
- One-click restore verification

![Encrypted Backup page](docs/screenshots/backup.png)

---

### 🖱️ Click-to-Copy Fields

A small but frequently requested UX improvement: clicking anywhere on a username, password, website, or card number field box copies the value to your clipboard instantly — no need to aim for the small copy icon.

- The entire field row is the click target
- A copy icon appears on hover as a visual hint
- The row flashes green and the icon turns to a checkmark to confirm the copy
- The eye/reveal button for passwords is intentionally separate and does **not** trigger a copy

![Item Browser](docs/screenshots/items-browser.png)

---

### 🎨 Custom CSS Editor *(unique to DockWarden)*

A fully-featured in-app CSS editor under **Settings → Advanced**. Retheme the entire application without touching any source files — changes persist across restarts and are applied live as you type.

- **Live preview** — 400 ms debounce applies CSS as you type
- **Quick presets** — one-click to try wider sidebar, purple/rose accent, compact density
- **CSS variables reference** — collapsible panel listing every `--variable` with a click-to-copy
- Line-number gutter · Tab indentation · `Ctrl+S` to save · `Reset` to undo all changes

![Custom CSS Editor](docs/screenshots/custom-css.png)

---

## 🖥️ Screenshots Gallery

| Home Dashboard | Item Browser |
|:---:|:---:|
| ![Home Dashboard](docs/screenshots/home-dashboard.png) | ![Item Browser](docs/screenshots/items-browser.png) |

| Quick Launcher | Auto-Type Picker |
|:---:|:---:|
| ![Quick Launcher](docs/screenshots/quick-launcher.png) | ![Auto-Type Picker](docs/screenshots/auto-type.png) |

| Tag Manager | Smart Views |
|:---:|:---:|
| ![Tag Manager](docs/screenshots/tag-manager.png) | ![Smart Views](docs/screenshots/smart-views.png) |

| Expiry Dashboard | Encrypted Backup |
|:---:|:---:|
| ![Expiry Dashboard](docs/screenshots/expiry-dashboard.png) | ![Encrypted Backup](docs/screenshots/backup.png) |

| Custom CSS Editor | Settings |
|:---:|:---:|
| ![Custom CSS Editor](docs/screenshots/custom-css.png) | ![Settings](docs/screenshots/settings.png) |

---

## ⚡ Quick Start

### Prerequisites

- **Node.js** 18+
- **Bitwarden CLI** — install once:
  ```bash
  npm install -g @bitwarden/cli
  bw --version   # should print e.g. 2024.x.x
  ```

### Development (hot reload)

```bash
# 1. Clone
git clone https://github.com/JaredScar/DockWarden.git
cd DockWarden/dockwarden

# 2. Install
npm install

# 3. Build Angular in watch mode + launch Electron
npm run electron:dev
```

### Production build

```bash
npm run electron:build
# → packaged installer in dockwarden/release/
```

### Run against an existing build

```bash
npm run build        # Angular production build
npm run electron     # Launch Electron against dist/
```

---

## 🔑 Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+\` | Open Quick Launcher (on active monitor) |
| `Ctrl+Alt+A` | Open Auto-Type picker (on active monitor) |
| `Ctrl+N` | New vault item |
| `Ctrl+E` | Edit selected item |
| `Ctrl+S` | Sync vault with Bitwarden |
| `Ctrl+L` | Lock vault |

> Quick Launcher and Auto-Type open as **independent floating windows on the monitor your cursor is on** — not inside the DockWarden window.

---

## 🔒 Security Model

DockWarden is designed with a minimal attack surface:

- **No credentials stored by DockWarden** — authentication is handled entirely by the official `bw` CLI; the session key lives only in memory for the lifetime of the app process
- **contextBridge isolation** — the Angular renderer has no access to Node.js or IPC directly; it communicates only through a typed, allowlisted surface defined in `preload.js`
- **Metadata in your vault** — tags and expiry dates are written to Bitwarden custom fields (not a local database), so they are encrypted at rest by Bitwarden
- **Open source** — full source available for review

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| App shell | Electron 42 |
| UI framework | Angular 21 (standalone components, signals, OnPush) |
| State management | Angular Signals — `signal()`, `computed()` |
| Vault integration | Bitwarden CLI (`bw`) via `child_process` |
| Fuzzy search | `fuse.js` |
| Config persistence | `electron-store` |
| Keyboard simulation | Windows `SendKeys` via PowerShell (Windows); `nut-js` planned for Mac |
| Build & distribution | `electron-builder` |

---

## 🗂️ Project Structure

```
dockwarden/
├── electron/
│   ├── main.js           # Main process: tray, IPC handlers, global shortcuts,
│   │                     # launcher window management, auto-type execution
│   └── preload.js        # contextBridge — fully typed ElectronAPI surface
└── src/app/
    ├── core/
    │   ├── vault.service.ts        # Items cache, auth state, CRUD operations
    │   └── smart-view.service.ts   # Filter engine, pinned views
    ├── features/
    │   ├── home/           # Dashboard: stats, health score, expiry widget
    │   ├── items/          # Master-detail vault browser, inline edit
    │   ├── launcher/       # Quick Search floating window (dedicated route)
    │   ├── autotype/       # Auto-Type picker window (dedicated route)
    │   ├── tags/           # Tag manager + multi-select bulk editor
    │   ├── smart-views/    # Saved filter builder, pin to sidebar
    │   ├── expiry/         # Expiry dashboard + reminder rules
    │   ├── backup/         # Backup destinations, schedule, history
    │   ├── settings/       # Preferences + Custom CSS editor
    │   └── unlock/         # Login / unlock screen with 2FA support
    └── shared/
        └── models/         # TypeScript interfaces: VaultItem, Tag, SmartView…
```

---

## 🏗️ Angular 21 Architecture

DockWarden follows strict Angular 21 patterns:

- **Signals everywhere** — no `BehaviorSubject`, no RxJS for state management
- **`ChangeDetectionStrategy.OnPush`** on every component
- **Standalone components only** — no NgModules
- **Modern control flow** — `@if`, `@for`, `@switch` (no `*ngIf` / `*ngFor`)
- **`inject()` function** — no constructor injection
- **Lazy-loaded routes** — every feature bundle loaded on demand

```typescript
// Reactive vault state — pure signals
@Injectable({ providedIn: 'root' })
export class VaultService {
  private readonly _items = signal<VaultItem[]>([]);

  readonly items   = this._items.asReadonly();
  readonly stats   = computed(() => deriveStats(this._items()));
  readonly allTags = computed(() => deriveTags(this._items()));
}
```

---

## 🗺️ Roadmap

| Phase | Features | Status |
|---|---|---|
| ✅ Foundation | Electron scaffold, IPC surface, vault browser, tray | **Shipped** |
| ✅ Tag Manager | `_dw_tags` read/write, multi-tag, bulk editor, tag sidebar | **Shipped** |
| ✅ Quick Launcher | Global hotkey, multi-monitor floating window, fuzzy search | **Shipped** |
| ✅ Auto-Type | Global hotkey, picker window, PowerShell keystroke injection (Win) | **Shipped** |
| ✅ Smart Views | Filter builder, AND/OR, sidebar pinning, dynamic counts | **Shipped** |
| ✅ Expiry System | `_dw_expires` field, expiry dashboard, OS notifications | **Shipped** |
| ✅ Encrypted Backup | `bw export` cron, local/S3/Backblaze, retention, history | **Shipped** |
| ✅ Custom CSS | Live-preview CSS editor, variable reference, presets | **Shipped** |
| ✅ Click-to-Copy Fields | Click any field box to copy; green flash confirmation | **Shipped** |
| ✅ Auto-Select Search | Top fuzzy match selected automatically as you type | **Shipped** |
| 🚧 Mac Auto-Type | `nut-js` keystroke injection for macOS | Planned |
| 🚧 TOTP in Launcher | Tab to copy TOTP + live countdown ring | Planned |
| 🚧 Cloud backup adapters | S3, Cloudflare R2, Backblaze B2, WebDAV live | Planned |
| 🚧 Auto-updater | `electron-updater` with GitHub Releases | Planned |

---

## 🤝 Contributing

Contributions are welcome! Please follow the Angular 21 standards defined in [`DockWarden-Plan.md`](./DockWarden-Plan.md): signals over RxJS, standalone components, `inject()` over constructor injection.

```bash
git checkout -b feature/my-feature
# make changes
git commit -m "feat: describe your change"
# open a pull request
```

---

## 📄 License

MIT © DockWarden Contributors

---

<div align="center">

**Built with ❤️ on top of Bitwarden — the best open-source password manager.**

⭐ If DockWarden is useful to you, consider starring the repository.

</div>
