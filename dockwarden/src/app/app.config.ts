import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';
import { providePrimeNG } from 'primeng/config';
import { definePreset } from '@primeuix/themes';
import Nora from '@primeuix/themes/nora';
import { routes } from './app.routes';

// Bake DockWarden's dark palette into the PrimeNG theme so components render
// correctly without requiring CSS variable overrides at runtime.
const DockWardenPreset = definePreset(Nora, {
  semantic: {
    primary: {
      // Maps to {primary.color} — used for the "on" state of toggles, etc.
      50:  '#e6f0ff',
      100: '#bdd4ff',
      200: '#90b8ff',
      300: '#5c9bff',
      400: '#3585ff',
      500: '#58a6ff', // accent-blue
      600: '#4090e0',
      700: '#2c76c8',
      800: '#1a5caa',
      900: '#0d3d80',
      950: '#061e40',
    },
    colorScheme: {
      dark: {
        primary: {
          color: '#58a6ff',
          inverseColor: '#fff',
          hoverColor: '#79b8ff',
          activeColor: '#4d97f0',
        },
        highlight: {
          background: 'rgba(88, 166, 255, 0.16)',
          focusBackground: 'rgba(88, 166, 255, 0.24)',
          color: '#fff',
          focusColor: '#fff',
        },
      },
    },
  },
  components: {
    toggleswitch: {
      root: {
        width: '2.5rem',
        height: '1.375rem',
        borderRadius: '11px',
        gap: '0.1875rem',
        background: '#30363d',
        borderColor: '#444c56',
        hoverBackground: '#3c4451',
        hoverBorderColor: '#545d6b',
        checkedBackground: '#58a6ff',
        checkedBorderColor: '#58a6ff',
        checkedHoverBackground: '#79b8ff',
        checkedHoverBorderColor: '#79b8ff',
        shadow: 'none',
        transitionDuration: '0.2s',
        slideDuration: '0.15s',
        borderWidth: '1px',
      },
      handle: {
        size: '1rem',
        borderRadius: '50%',
        background: '#6e7681',
        hoverBackground: '#8b949e',
        checkedBackground: '#ffffff',
        checkedHoverBackground: '#ffffff',
      },
    },
  },
});

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withHashLocation()),
    providePrimeNG({
      theme: {
        preset: DockWardenPreset,
        options: {
          darkModeSelector: ':root',
        },
      },
    }),
  ]
};
