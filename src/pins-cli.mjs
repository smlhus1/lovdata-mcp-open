#!/usr/bin/env node
// Pins: check the pinned paragraphs against the current text, add one, or accept the current text.
//   node src/pins-cli.mjs                                  check; exit code 1 if anything differs
//   node src/pins-cli.mjs add <dokument> <paragraf> <hvorfor>
//   node src/pins-cli.mjs accept                           re-pin everything that differs
import { ensureFresh, dataDir } from "./store.mjs";
import { checkPins, createPin, describe, readPins, writePins, pinsFile } from "./pins.mjs";

const [command = "check", ...args] = process.argv.slice(2);
const dir = dataDir();
await ensureFresh(dir);

if (command === "add") {
  const [dokument, paragraf, ...why] = args;
  if (!dokument || !paragraf || !why.length) {
    console.error("Usage: pins add <dokument> <paragraf> <hvorfor>");
    process.exit(2);
  }
  const pin = createPin(dir, dokument, paragraf, why.join(" "));
  const pins = readPins();
  if (pins.some((p) => p.dokument === pin.dokument && p.paragraf === pin.paragraf)) {
    console.error(`${pin.navn} ${pin.paragraf} er allerede festet.`);
    process.exit(2);
  }
  writePins([...pins, pin]);
  console.log(`Festet ${pin.navn} ${pin.paragraf} (${pin.sha256.slice(0, 12)}…, tekstdato ${pin.tekstdato}).`);
} else if (command === "accept") {
  const results = checkPins(dir);
  const gone = results.filter((r) => r.status === "mangler");
  // A pin whose paragraph is gone cannot be re-pinned; it stays until someone removes it by hand.
  writePins(results.map((r) => (r.now ? { ...r.now, hvorfor: r.pin.hvorfor } : r.pin)));
  console.log(`${results.filter((r) => r.status === "endret" || r.status === "varsel").length} pins oppdatert i ${pinsFile()}.`);
  for (const r of gone) console.log("Står igjen: " + describe(r));
} else if (command === "check") {
  const results = checkPins(dir);
  const differing = results.filter((r) => r.status !== "ok");
  for (const r of differing) console.log(describe(r));
  console.log(`${results.length - differing.length} av ${results.length} festede paragrafer er uendret.`);
  if (differing.length) process.exit(1);
} else {
  console.error(`Unknown command «${command}». Use check, add or accept.`);
  process.exit(2);
}
