import { installLogTimestamps } from './logTimestamps.js';
import { exitIfConfigUnusable } from './configCheck.js';

// The first import of index.ts, so this runs before any module that reads a config
// file at load. A side-effect import rather than calls in index.ts: tsx hoists
// imports above other statements, but keeps their order. The timestamps come first so
// the exit message carries one like every other line.
installLogTimestamps();
exitIfConfigUnusable();
