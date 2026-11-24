import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

async function start(): Promise<void> {
  const forceDemo = new URLSearchParams(window.location.search).get('demo') === '1';
  if (forceDemo || !window.electronAPI) {
    const { installDemoApi } = await import('./app/demo/install-demo-api');
    installDemoApi();
  }
  await bootstrapApplication(App, appConfig);
}

start().catch((err) => console.error(err));
