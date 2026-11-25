#!/usr/bin/env node
// Fetches Lovdata's packages now and rebuilds the index if they are newer than the local copy.
import { ensureFresh, ensureLocalFresh, dataDir } from "./store.mjs";

// Each index is tried, also when the other one fails.
let failed = false;
for (const [what, ensure] of [["Current law", ensureFresh], ["Local regulations", ensureLocalFresh]]) {
  try {
    const result = await ensure(dataDir(), { force: true });
    if (result.warning) throw new Error(result.warning);
    console.log(`${what}: up to date with Lovdata (checked ${result.checkedAt}).`);
  } catch (err) {
    failed = true;
    console.error(`${what}: ${err.message}`);
  }
}
console.log(`Data: ${dataDir()}`);
if (failed) process.exit(1);
