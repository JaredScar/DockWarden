import { Routes } from '@angular/router';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { VaultService } from './core/vault.service';

async function authGuard(): Promise<boolean> {
  const vaultService = inject(VaultService);
  const router = inject(Router);

  // Check the in-memory auth state — DO NOT call checkAuthStatus() here,
  // as that re-runs `bw status` and will return "locked" even after we've
  // just unlocked (because bw status doesn't know about our in-memory session).
  if (vaultService.isUnlocked()) return true;
  router.navigate(['/unlock']);
  return false;
}

export const routes: Routes = [
  { path: '', redirectTo: 'unlock', pathMatch: 'full' },
  // Floating launcher windows — no auth guard, load instantly
  {
    path: 'launcher',
    loadComponent: () => import('./features/launcher/launcher.component').then(m => m.LauncherComponent),
  },
  {
    path: 'autotype',
    loadComponent: () => import('./features/autotype/autotype-picker.component').then(m => m.AutotypePickerComponent),
  },
  {
    path: 'unlock',
    loadComponent: () => import('./features/unlock/unlock.component').then(m => m.UnlockComponent),
  },
  {
    path: 'home',
    loadComponent: () => import('./features/home/home.component').then(m => m.HomeComponent),
    canActivate: [authGuard],
  },
  {
    path: 'items',
    loadComponent: () => import('./features/items/items.component').then(m => m.ItemsComponent),
    canActivate: [authGuard],
  },
  {
    path: 'tags',
    loadComponent: () => import('./features/tags/tags.component').then(m => m.TagsComponent),
    canActivate: [authGuard],
  },
  {
    path: 'smart-views',
    loadComponent: () => import('./features/smart-views/smart-views.component').then(m => m.SmartViewsComponent),
    canActivate: [authGuard],
  },
  {
    path: 'expiry',
    loadComponent: () => import('./features/expiry/expiry.component').then(m => m.ExpiryComponent),
    canActivate: [authGuard],
  },
  {
    path: 'backup',
    loadComponent: () => import('./features/backup/backup.component').then(m => m.BackupComponent),
    canActivate: [authGuard],
  },
  {
    path: 'settings',
    loadComponent: () => import('./features/settings/settings.component').then(m => m.SettingsComponent),
    canActivate: [authGuard],
  },
  {
    path: 'totp',
    loadComponent: () => import('./features/totp/totp-panel.component').then(m => m.TotpPanelComponent),
    canActivate: [authGuard],
  },
  {
    path: 'accounts',
    loadComponent: () => import('./features/accounts/accounts.component').then(m => m.AccountsComponent),
    canActivate: [authGuard],
  },
  {
    path: 'templates',
    loadComponent: () => import('./features/templates/templates.component').then(m => m.TemplatesComponent),
    canActivate: [authGuard],
  },
  { path: '**', redirectTo: 'unlock' },
];
