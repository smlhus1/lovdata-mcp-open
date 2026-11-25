// The text date must come from Lovdata's package, and follow automatically when Lovdata
// publishes a new one. Runs against a local HTTP server that behaves like api.lovdata.no.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Store, ensureFresh } from "../src/store.mjs";
import { FIXTURES, LOVER, FORSKRIFTER, corruptedLover, fakeLovdata, pack, tempDir } from "./helpers.mjs";

const firstSentence = (dir) => {
  const store = new Store(dir);
  try {
    const doc = store.resolveDocument("aml").doc;
    return { date: store.packageDate(doc), text: store.parts(doc.refid, "14-9")[0].text.split("\n")[0] };
  } finally {
    store.close();
  }
};


const ALL = ["/list", `/get/${LOVER}`, `/get/${FORSKRIFTER}`, "/list"];
const buildDirs = (dir) => fs.readdirSync(dir).filter((name) => name.startsWith("build-"));

test("downloads, indexes and follows new packages from Lovdata", async (t) => {
  const lovdata = await fakeLovdata();
  const dir = tempDir();
  const options = { api: lovdata.api };
  const forced = { ...options, force: true };

  await t.test("first use downloads both packages and takes the text date from Lovdata", async () => {
    const result = await ensureFresh(dir, options);
    assert.equal(result.warning, undefined);
    assert.deepEqual(lovdata.requests, ALL);
    assert.equal(firstSentence(dir).date, "2026-11-21T02:32:00Z");
    assert.match(firstSentence(dir).text, /^\(1\) Arbeidstaker skal ansettes fast\. /);
    assert.deepEqual(buildDirs(dir), []);
  });

  await t.test("does not ask Lovdata again within the check interval", async () => {
    lovdata.requests.length = 0;
    await ensureFresh(dir, options);
    assert.deepEqual(lovdata.requests, []);
  });

  await t.test("unchanged packages are not downloaded again", async () => {
    lovdata.requests.length = 0;
    await ensureFresh(dir, forced);
    assert.deepEqual(lovdata.requests, ["/list"]);
  });

  await t.test("a new package from Lovdata replaces the text and the text date", async () => {
    lovdata.requests.length = 0;
    lovdata.dates[LOVER] = "2026-11-22T02:32:00Z";
    lovdata.files[LOVER] = pack(corruptedLover()); // stands in for "the law text changed"
    const result = await ensureFresh(dir, forced);
    assert.equal(result.warning, undefined);
    assert.deepEqual(lovdata.requests, ALL);
    assert.equal(firstSentence(dir).date, "2026-11-22T02:32:00Z");
    assert.match(firstSentence(dir).text, /^\(1\) Arbeidstaker skal ansettes fast Med /);
  });

  await t.test("simultaneous checks in one process share one download", async () => {
    lovdata.requests.length = 0;
    lovdata.dates[LOVER] = "2026-11-23T02:32:00Z";
    await Promise.all([ensureFresh(dir, forced), ensureFresh(dir, forced)]);
    assert.deepEqual(lovdata.requests, ALL);
  });

  const workingLover = lovdata.files[LOVER];

  await t.test("a package that cannot be unpacked leaves the old text and date in place, with a warning", async () => {
    lovdata.dates[LOVER] = "2026-11-24T02:32:00Z";
    lovdata.files[LOVER] = Buffer.from("this is not a bzip2 archive");
    const result = await ensureFresh(dir, forced);
    assert.match(result.warning, /nyere pakke, men den lot seg ikke hente og indeksere/);
    assert.equal(firstSentence(dir).date, "2026-11-23T02:32:00Z");
    assert.deepEqual(buildDirs(dir), []);
  });

  await t.test("a failed update is not attempted again on every question", async () => {
    fs.rmSync(path.join(dir, "checked.json")); // as if the check interval had run out
    lovdata.requests.length = 0;
    const again = await ensureFresh(dir, options);
    assert.deepEqual(lovdata.requests, []);
    assert.match(again.warning, /nyere pakke/);
    lovdata.files[LOVER] = workingLover;
  });

  await t.test("a document that cannot be read fails the build instead of going missing", async () => {
    const good = lovdata.files[LOVER];
    const broken = tempDir();
    fs.cpSync(path.join(FIXTURES, "lover"), broken, { recursive: true });
    fs.writeFileSync(path.join(broken, "nl", "nl-20030523-035.xml"), "<html><body>not a law</body></html>");
    lovdata.files[LOVER] = pack(broken);
    const result = await ensureFresh(dir, forced);
    assert.match(result.warning, /Could not index nl-20030523-035\.xml/);
    assert.equal(firstSentence(dir).date, "2026-11-23T02:32:00Z");
    lovdata.files[LOVER] = good;
  });

  await t.test("a package published during the download is not labelled with the old date", async () => {
    lovdata.onRequest = (url) => {
      if (url === `/get/${FORSKRIFTER}`) lovdata.dates[FORSKRIFTER] = "2026-11-25T02:32:00Z";
    };
    const result = await ensureFresh(dir, forced);
    lovdata.onRequest = undefined;
    assert.match(result.warning, /published a new package during the download/);
    assert.equal(firstSentence(dir).date, "2026-11-23T02:32:00Z");
    assert.equal((await ensureFresh(dir, forced)).warning, undefined);
    assert.equal(firstSentence(dir).date, "2026-11-24T02:32:00Z");
  });

  await t.test("a half-written checked.json only causes a new check", async () => {
    fs.writeFileSync(path.join(dir, "checked.json"), "");
    lovdata.requests.length = 0;
    const result = await ensureFresh(dir, options);
    assert.equal(result.warning, undefined);
    assert.deepEqual(lovdata.requests, ["/list"]);
  });

  await t.test("two server processes starting on an empty data directory both end up with a working index", async () => {
    const shared = tempDir();
    const storeUrl = new URL("../src/store.mjs", import.meta.url).href;
    const script = `const { ensureFresh } = await import(${JSON.stringify(storeUrl)});
      const r = await ensureFresh(${JSON.stringify(shared)}, { api: ${JSON.stringify(lovdata.api)} });
      if (r.warning) { console.error(r.warning); process.exit(1); }`;
    const runs = [1, 2].map(
      () =>
        new Promise((resolve) => {
          const child = execFile(process.execPath, ["--input-type=module", "-e", script], (err, _out, stderr) => resolve({ err, stderr }));
          child.stdin?.end();
        }),
    );
    for (const { err, stderr } of await Promise.all(runs)) assert.equal(err, null, stderr);
    assert.equal(firstSentence(shared).date, "2026-11-24T02:32:00Z");
    assert.deepEqual(buildDirs(shared), []);
  });

  await lovdata.close();

  await t.test("when Lovdata is unreachable the local copy is used, with a warning", async () => {
    const result = await ensureFresh(dir, forced);
    assert.match(result.warning, /Fikk ikke kontakt med Lovdata/);
    assert.equal(firstSentence(dir).date, "2026-11-24T02:32:00Z");
  });

  await t.test("without a local copy an unreachable Lovdata is an error, not an empty answer", async () => {
    await assert.rejects(ensureFresh(tempDir(), options), /no local copy/);
  });
});
