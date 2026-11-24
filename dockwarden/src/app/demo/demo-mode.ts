interface DemoWindow extends Window {
  __dwDemo?: boolean;
}

export function isDemoSession(): boolean {
  return typeof window !== 'undefined' && Boolean((window as DemoWindow).__dwDemo);
}

export function markDemoSession(): void {
  (window as DemoWindow).__dwDemo = true;
}
