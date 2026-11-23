import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';

// Vitest uppercases the Windows drive letter in test-file URLs. Node keeps the
// casing of the path used to launch the process. Those become two copies of
// @vitest/runner, and every spec fails before it runs. Launching from the
// canonical drive letter keeps both on the same module instance.
const upperDrive = (value) => value.replace(/^[a-z]:/, (letter) => letter.toUpperCase());
const cwd = upperDrive(realpathSync.native(process.cwd()));
const ng = upperDrive(createRequire(import.meta.url).resolve('@angular/cli/bin/ng.js'));

const child = spawn(process.execPath, [ng, 'test', ...process.argv.slice(2)], {
  cwd,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
