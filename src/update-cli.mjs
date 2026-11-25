#!/usr/bin/env node
// Fetches Lovdata's packages now and rebuilds the index if they are newer than the local copy.
import { ensureFresh, dataDir } from "./store.mjs";

const result = await ensureFresh(dataDir(), { force: true });
if (result.warning) {
  console.error(result.warning);
  process.exit(1);
}
console.log(`Up to date with Lovdata (checked ${result.checkedAt}). Data: ${dataDir()}`);
