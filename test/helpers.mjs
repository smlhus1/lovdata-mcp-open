import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDatabase } from "../src/store.mjs";

export const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
export const PUBLISHED = fileURLToPath(new URL("./published/", import.meta.url));
export const PACKAGE_DATE = "2026-11-21T02:32:00Z";

// The tests must never reach Lovdata, read the real pins or write to the real agent channel.
// Port 9 (discard) refuses the connection; tests that download pass their own server as `api`.
process.env.LOVDATA_MCP_API = "http://127.0.0.1:9";
process.env.LOVDATA_MCP_PINS = path.join(os.tmpdir(), "lovdata-mcp-test-no-pins.json");
delete process.env.LOVDATA_MCP_MELD;

export const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "lovdata-mcp-test-"));

/**
 * Builds a data directory from extracted package directories, marked as just checked
 * so nothing in the test reaches for the network.
 */
export function buildDataDir({ lover = path.join(FIXTURES, "lover"), forskrifter = path.join(FIXTURES, "forskrifter") } = {}) {
  const dir = tempDir();
  buildDatabase(path.join(dir, "lovdata.db"), [
    { dir: lover, package: "gjeldende-lover.tar.bz2", date: PACKAGE_DATE },
    { dir: forskrifter, package: "gjeldende-sentrale-forskrifter.tar.bz2", date: PACKAGE_DATE },
  ]);
  buildDatabase(path.join(dir, "lokal.db"), [{ dir: path.join(FIXTURES, "lokale"), package: LOKALE_I_AAR, date: PACKAGE_DATE, type: "lokal" }]);
  const checked = JSON.stringify({ checkedAt: new Date().toISOString() });
  for (const file of ["checked.json", "checked-lokal.json"]) fs.writeFileSync(path.join(dir, file), checked);
  return dir;
}

/** Copy of the law fixtures where one character is removed from arbeidsmiljøloven § 14-9. */
export function corruptedLover() {
  const dir = tempDir();
  fs.cpSync(path.join(FIXTURES, "lover"), dir, { recursive: true });
  const file = path.join(dir, "nl", "nl-20050617-062.xml");
  const original = fs.readFileSync(file, "utf8");
  const corrupted = original.replace("Arbeidstaker skal ansettes fast.", "Arbeidstaker skal ansettes fast");
  if (corrupted === original) throw new Error("The sentence to corrupt was not found in the fixture");
  fs.writeFileSync(file, corrupted);
  return dir;
}

export const LOVER = "gjeldende-lover.tar.bz2";
export const FORSKRIFTER = "gjeldende-sentrale-forskrifter.tar.bz2";
export const LOKALE_I_AAR = "lovtidend-avd2-2026.tar.bz2";

/** A directory of documents as the .tar.bz2 Lovdata would serve. */
export function pack(sourceDir) {
  const out = tempDir();
  // Copied in first so tar only sees paths below its own cwd: Git for Windows' tar remaps
  // ".." out of the temp directory.
  fs.cpSync(sourceDir, path.join(out, "content"), { recursive: true });
  execFileSync("tar", ["-cjf", "package.tar.bz2", "-C", "content", "."], { cwd: out });
  return fs.readFileSync(path.join(out, "package.tar.bz2"));
}

/** A local HTTP server that behaves like api.lovdata.no/v1/publicData. */
export async function fakeLovdata() {
  const state = {
    requests: [],
    dates: { [LOVER]: "2026-11-21T02:32:00Z", [FORSKRIFTER]: "2026-11-21T02:32:00Z" },
    files: { [LOVER]: pack(path.join(FIXTURES, "lover")), [FORSKRIFTER]: pack(path.join(FIXTURES, "forskrifter")) },
  };
  const server = http.createServer((req, res) => {
    state.requests.push(req.url);
    state.onRequest?.(req.url);
    if (req.url === "/list") {
      const list = Object.entries(state.dates).map(([filename, lastModified]) => ({ filename, lastModified }));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(list));
    } else if (req.url.startsWith("/get/") && state.files[req.url.slice(5)]) {
      res.end(state.files[req.url.slice(5)]);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.api = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((resolve) => server.close(resolve));
  return state;
}
