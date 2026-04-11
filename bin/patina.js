#!/usr/bin/env node
// This file is the installed bin entry point.
// During development, use: npx tsx src/index.ts
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Try compiled dist first, fall back to tsx for development
import(join(__dirname, '../dist/index.js')).catch(() => {
  console.error('Run `npm run build` first, or use `npx tsx src/index.ts` for development.');
  process.exit(1);
});
