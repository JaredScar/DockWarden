#!/usr/bin/env node
'use strict';

// Resolves dw://Item/field references from an unlocked DockWarden vault and
// starts a command with those values in its environment. Secrets are never printed.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

function candidateFiles() {
  const files = [];
  if (process.env.DW_RUN_FILE) files.push(process.env.DW_RUN_FILE);
  if (process.env.APPDATA) {
    files.push(path.join(process.env.APPDATA, 'DockWarden', 'dw-run.json'));
    files.push(path.join(process.env.APPDATA, 'dockwarden', 'dw-run.json'));
  }
  if (process.env.HOME) {
    files.push(path.join(process.env.HOME, '.config', 'DockWarden', 'dw-run.json'));
    files.push(path.join(process.env.HOME, 'Library', 'Application Support', 'DockWarden', 'dw-run.json'));
  }
  return files;
}

function readEndpoint() {
  for (const file of candidateFiles()) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && data.port && data.token) return data;
    } catch { /* try the next location */ }
  }
  return null;
}

function usage() {
  console.error('Usage: dw-run run [--env NAME=dw://Item/field] [-f file] -- command [args]');
  console.error('Unlock DockWarden first. References are read from the running app and never printed.');
  process.exit(1);
}

function parseEnvFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const pairs = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    pairs.push([trimmed.slice(0, eq).trim(), value]);
  }
  return pairs;
}

function resolveRefs(endpoint, refs) {
  const body = JSON.stringify({ token: endpoint.token, refs });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: endpoint.port,
      path: '/resolve',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let payload = {};
        try { payload = JSON.parse(text || '{}'); } catch { /* keep empty */ }
        if (res.statusCode !== 200) reject(new Error(payload.error || 'DockWarden refused the request'));
        else resolve(payload.values || {});
      });
    });
    req.on('error', () => reject(new Error('DockWarden is locked or not running. Unlock the vault and try again.')));
    req.write(body);
    req.end();
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== 'run') usage();
  const pairs = [];
  const command = [];
  let seenSeparator = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!seenSeparator && arg === '--') {
      seenSeparator = true;
      continue;
    }
    if (seenSeparator) {
      command.push(arg);
      continue;
    }
    if (arg === '--env') {
      const spec = args[++i];
      if (!spec || !spec.includes('=')) usage();
      const eq = spec.indexOf('=');
      pairs.push([spec.slice(0, eq), spec.slice(eq + 1)]);
      continue;
    }
    if (arg === '-f' || arg === '--file') {
      const file = args[++i];
      if (!file) usage();
      pairs.push(...parseEnvFile(file));
      continue;
    }
    usage();
  }
  if (!command.length) usage();

  const refs = [...new Set(pairs.map(([, value]) => value).filter(value => value.startsWith('dw://')))];
  let resolved = {};
  if (refs.length) {
    const endpoint = readEndpoint();
    if (!endpoint) {
      console.error('DockWarden is locked or not running. Unlock the vault and try again.');
      process.exit(1);
    }
    try {
      resolved = await resolveRefs(endpoint, refs);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  const env = { ...process.env };
  for (const [key, value] of pairs) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      console.error(`Invalid environment name: ${key}`);
      process.exit(1);
    }
    env[key] = value.startsWith('dw://') ? resolved[value] : value;
  }

  const child = spawn(command[0], command.slice(1), { env, stdio: 'inherit', shell: false });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code == null ? 1 : code);
  });
  child.on('error', (err) => {
    console.error(err.message);
    process.exit(1);
  });
}

main();
