#!/usr/bin/env node
// Everything adopted but not in force. Usage: npm run radar -- [text to filter on] [--detaljer]
// --json prints every entry as data, with the pinned paragraphs, for the page that draws the radar.
import { readFileSync } from "node:fs";
import { kommende, kommendeData } from "./answers.mjs";

const args = process.argv.slice(2);
if (args.includes("--json")) {
  const pins = JSON.parse(readFileSync(new URL("../pins.json", import.meta.url), "utf8"));
  const festet = pins.map(({ dokument, navn, paragraf, hvorfor }) => ({ dokument, navn, paragraf, hvorfor }));
  console.log(JSON.stringify({ ...(await kommendeData()), festet }));
} else {
  const detaljer = args.includes("--detaljer");
  console.log(await kommende({ tekst: args.filter((a) => a !== "--detaljer").join(" ") || undefined, detaljer }));
}
