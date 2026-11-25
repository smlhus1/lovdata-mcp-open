// Local regulations are a source of their own: the text as announced in Norsk Lovtidend,
// never presented as current law, and kept in an index that current law does not depend on.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store, ensureFresh, ensureLocalFresh, LOCAL } from "../src/store.mjs";
import { hentParagraf, sok } from "../src/answers.mjs";
import { FIXTURES, LOVER, buildDataDir, fakeLovdata, pack, tempDir } from "./helpers.mjs";

const dir = buildDataDir();
const NOT_CONSOLIDATED = /KUNNGJORT TEKST, IKKE AJOURFØRT\. .*kan være opphevet/;

test("a local regulation is answered as announced, with the warning and the later announcements that change it", async () => {
  const answer = await hentParagraf({ dokument: "FOR-2026-04-10-582", paragraf: "§ 2" }, dir);
  assert.match(answer, /^Forskrift om fiske med snurrevad innenfor 4 nautiske mil fra grunnlinjene, Finnmark\nLokal forskrift · ID: FOR-2026-04-10-582/);
  assert.match(answer, NOT_CONSOLIDATED);
  assert.match(answer, /slik den ble kunngjort i Norsk Lovtidend 2026-04-13/);
  assert.match(answer, /Senere kunngjøringer som endrer eller opphever denne forskriften .*:\n- FOR-2026-04-30-710, kunngjort 2026-05-04: Forskrift om endring i forskrift om fiske med snurrevad/);
  assert.match(answer, /Gjelder for \(Lovdatas opplysning\): Finnmark/);
  assert.match(answer, /Hjemmel \(.*\): lov\/2008-06-06-37 § 16; forskrift\/2021-12-23-3910 § 50a; forskrift\/2021-12-23-3910 § 74/);
  assert.match(answer, /https:\/\/lovdata\.no\/dokument\/LTII\/forskrift\/2026-04-10-582/);
  // Verbatim, also where the announcement itself lacks the full stop.
  assert.match(answer, /\n§ 2\. Straff\nDen som forsettlig eller uaktsomt overtrer bestemmelser gitt i eller i medhold av forskriften, straffes etter havressurslova §§ 61, 64 og 65\. På samme måte straffes medvirkning og forsøk\n/);
  assert.match(answer, /Tekstdato: Lovdatas pakke lovtidend-avd2-2026\.tar\.bz2/);
  assert.match(answer, /NLOD\) 2\.0/);
  // Nothing that belongs to current law: no claim about amendment notes or regulations issued under it.
  assert.doesNotMatch(answer, /Lovdata har ingen endringsnote|Ingen endringer registrert på dokumentet/);
});

test("without a paragraph the announcement lists its paragraphs", async () => {
  const answer = await hentParagraf({ dokument: "forskrift/2026-04-10-582" }, dir);
  assert.match(answer, NOT_CONSOLIDATED);
  assert.match(answer, /Innhold\. .*\n§ 1\. .*\n§ 2\. Straff\n§ 3\. Ikrafttredelse/);
});

test("an amending regulation says what it changes, and its quoted new wording is its own text", async () => {
  const answer = await hentParagraf({ dokument: "FOR-2026-04-30-710" }, dir);
  assert.match(answer, /Endrer eller opphever \(.*\): Forskrift om fiske med snurrevad innenfor 4 nautiske mil fra grunnlinjene, Finnmark \(FOR-2026-04-10-582\)/);
  assert.match(answer, /Ny § 3 skal lyde:\n§ 3\. Adgang til å fiske med snurrevad i et område på Kongsfjorden\n/);
});

test("a regulation replaced by a new one lists the new one, whatever its title", async () => {
  const replaced = await hentParagraf({ dokument: "FOR-2026-08-26-1964" }, dir);
  assert.match(replaced, /Senere kunngjøringer som endrer eller opphever denne forskriften .*:\n- FOR-2026-11-17-2402, kunngjort 2026-11-18: Forskrift om adgang til jakt/);
});

test("no later announcement is said plainly, and is not taken as proof that the text stands", async () => {
  const answer = await hentParagraf({ dokument: "FOR-2026-11-17-2402" }, dir);
  assert.match(answer, /Ingen senere kunngjøring er registrert som endring eller oppheving .* Det viser ikke at den gjelder uendret\./);
  assert.match(answer, NOT_CONSOLIDATED);
});

test("a title shared by several announcements gives the candidates, newest first", async () => {
  const answer = await hentParagraf({ dokument: "minsteareal" }, dir);
  assert.match(answer, /Fant ingen gjeldende lov eller sentral forskrift som heter «minsteareal»\. Navnet passer på flere lokale forskrifter/);
  const ids = [...answer.matchAll(/^- (FOR-[\d-]+):/gm)].map((m) => m[1]);
  assert.deepEqual(ids, ["FOR-2026-11-17-2402", "FOR-2026-10-22-2184", "FOR-2026-08-26-1964", "FOR-2026-06-03-1082"]);
  const unknown = await hentParagraf({ dokument: "FOR-1999-01-01-1" }, dir);
  assert.match(unknown, /Fant ingen gjeldende lov eller sentral forskrift .* Ingen kunngjort lokal forskrift heter det heller\./);
  const noParagraph = await hentParagraf({ dokument: "FOR-2026-04-10-582", paragraf: "§ 99" }, dir);
  assert.match(noParagraph, /Fant ikke «§ 99» i .*slik den ble kunngjort/);
});

test("search leaves local regulations out unless they are asked for, and marks them when they are", async () => {
  assert.match(await sok({ tekst: "snurrevad" }, dir), /Ingen treff/);
  assert.match(await sok({ tekst: "snurrevad", type: "forskrift" }, dir), /Ingen treff/);

  const local = await sok({ tekst: "snurrevad", type: "lokal", antall: 10 }, dir);
  assert.match(local, NOT_CONSOLIDATED);
  assert.match(local, /\(FOR-2026-04-10-582\) · § 1\. .*\nKunngjort 2026-04-13 · Gjelder for: Finnmark · Endret eller opphevet av 1 senere kunngjøring\n/);
  assert.match(local, /\(FOR-2026-04-30-710\) · I \[paragraf: "KAPITTEL_1"\]\nKunngjort 2026-05-04 · Gjelder for: Finnmark\n/);
  assert.match(local, /Tekstdato: Lovdatas pakke lovtidend-avd2-2026\.tar\.bz2/);

  // The other way round: current law is not in the local index.
  assert.match(await sok({ tekst: "ansettes fast", type: "lokal" }, dir), /Ingen treff på «ansettes fast» i kunngjorte lokale forskrifter\./);
});

test("local search can be limited to a place, as whole words and however it is capitalised", async () => {
  const everywhere = await sok({ tekst: "hjort", type: "lokal", antall: 50 }, dir);
  assert.match(everywhere, /Vik kommune, Vestland/);
  assert.match(everywhere, /Notodden kommune, Telemark/);
  const notodden = await sok({ tekst: "hjort", type: "lokal", sted: "NOTODDEN", antall: 50 }, dir);
  assert.match(notodden, /avgrenset til stedet «NOTODDEN»/);
  assert.match(notodden, /Notodden kommune, Telemark/);
  assert.doesNotMatch(notodden, /Vik kommune/);
  assert.match(await sok({ tekst: "hjort", type: "lokal", sted: "Vik" }, dir), /Vik kommune, Vestland/);
  assert.match(await sok({ tekst: "hjort", type: "lokal", sted: "Notodden kommune" }, dir), /Notodden kommune, Telemark/);
  // Part of a word is not the place: «Not» is not Notodden, «Fin» is not Finnmark.
  for (const [tekst, sted] of [["hjort", "Not"], ["snurrevad", "Fin"], ["hjort", "Ålesund"]]) {
    assert.match(await sok({ tekst, type: "lokal", sted }, dir), new RegExp(`Ingen treff på «${tekst}» i kunngjorte lokale forskrifter, avgrenset til stedet «${sted}»`));
  }
});

test("naming a place asks for local regulations, and is never silently ignored", async () => {
  const implied = await sok({ tekst: "hjort", sted: "Notodden" }, dir);
  assert.match(implied, NOT_CONSOLIDATED);
  assert.match(implied, /Notodden kommune, Telemark/);
  const conflicting = await sok({ tekst: "ansettes fast", type: "lov", sted: "Notodden" }, dir);
  assert.match(conflicting, /^«sted» gjelder bare lokale forskrifter og er ikke brukt i dette søket\.\n\n1 treff på «ansettes fast»/);
});

test("without a local index, a question about current law is answered at once and says what is missing", async () => {
  const bare = buildDataDir();
  for (const file of ["lokal.db", "checked-lokal.json"]) fs.rmSync(path.join(bare, file));
  const started = Date.now();
  const unknown = await hentParagraf({ dokument: "FOR-2026-04-10-582" }, bare);
  assert.equal(Date.now() - started < 2000, true, "must not wait for Lovdata");
  assert.match(unknown, /^Fant ingen gjeldende lov eller sentral forskrift som heter «FOR-2026-04-10-582»\. Prøv verktøyet sok\. Lokale forskrifter er ikke indeksert på denne maskinen ennå\./);
  assert.match(unknown, /NLOD\) 2\.0/);
  assert.match(await sok({ tekst: "snurrevad", type: "lokal" }, bare), /^Lokale forskrifter er ikke indeksert på denne maskinen ennå\./);
  // Current law is untouched by the missing index.
  assert.match(await hentParagraf({ dokument: "aml", paragraf: "§ 14-9" }, bare), /Arbeidstaker skal ansettes fast\./);
  // The failed attempt in the background is remembered and told, not repeated on every question.
  let later = "";
  for (let i = 0; i < 100 && !/Siste forsøk feilet/.test(later); i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    later = await sok({ tekst: "snurrevad", type: "lokal" }, bare);
  }
  assert.match(later, /Siste forsøk feilet: Fikk ikke hentet data fra Lovdata/);
});

test("the two indexes are separate: neither holds the other's documents", () => {
  const current = new Store(dir);
  const local = new Store(dir, LOCAL);
  try {
    assert.equal(current.has("forskrift/2026-04-10-582"), false);
    assert.equal(local.has("lov/2005-06-17-62"), false);
    assert.equal(local.db.prepare("SELECT count(*) AS n FROM docs WHERE type <> 'lokal'").get().n, 0);
    assert.equal(local.db.prepare("SELECT count(*) AS n FROM docs").get().n, 6);
  } finally {
    current.close();
    local.close();
  }
});

const OLDER = "lovtidend-avd2-2001-2025.tar.bz2";
const THIS_YEAR = "lovtidend-avd2-2026.tar.bz2";

/** A package holding only the named announcements. */
function packOf(...files) {
  const content = tempDir();
  fs.mkdirSync(path.join(content, "ltii", "2026"), { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(FIXTURES, "lokale", "ltii", "2026", file), path.join(content, "ltii", "2026", file));
  return pack(content);
}

const has = (data, refid) => {
  const store = new Store(data, LOCAL);
  try {
    const doc = store.document(refid);
    return doc ? { package: doc.package, date: store.packageDate(doc) } : null;
  } finally {
    store.close();
  }
};

test("local regulations are fetched on their own, and follow Lovdata's packages as their names change", async (t) => {
  const lovdata = await fakeLovdata();
  const data = tempDir();
  const options = { api: lovdata.api };
  const forced = { ...options, force: true };
  lovdata.dates[OLDER] = "2026-11-20T02:31:00Z";
  lovdata.dates[THIS_YEAR] = "2026-11-25T02:31:00Z";
  lovdata.files[OLDER] = packOf("lf-20260410-0582.xml");
  lovdata.files[THIS_YEAR] = packOf("lf-20260430-0710.xml");

  await t.test("first use downloads every local package, and nothing else", async () => {
    const result = await ensureLocalFresh(data, options);
    assert.equal(result.warning, undefined);
    assert.deepEqual(lovdata.requests, ["/list", `/get/${OLDER}`, `/get/${THIS_YEAR}`, "/list"]);
    assert.deepEqual(has(data, "forskrift/2026-04-10-582"), { package: OLDER, date: "2026-11-20T02:31:00Z" });
    assert.deepEqual(has(data, "forskrift/2026-04-30-710"), { package: THIS_YEAR, date: "2026-11-25T02:31:00Z" });
    assert.equal(fs.existsSync(path.join(data, "lovdata.db")), false);
    assert.deepEqual(fs.readdirSync(data).filter((name) => name.startsWith("build-")), []);
  });

  await t.test("the announcement in one package is listed as changing the regulation in the other", async () => {
    const answer = await hentParagraf({ dokument: "forskrift/2026-04-10-582" }, await withCurrentLaw(data, lovdata));
    assert.match(answer, /- FOR-2026-04-30-710, kunngjort 2026-05-04/);
  });

  await t.test("unchanged packages are not downloaded again", async () => {
    lovdata.requests.length = 0;
    await ensureLocalFresh(data, options);
    assert.deepEqual(lovdata.requests, []);
    await ensureLocalFresh(data, forced);
    assert.deepEqual(lovdata.requests, ["/list"]);
  });

  await t.test("a new package this year brings the new announcements in", async () => {
    lovdata.requests.length = 0;
    lovdata.dates[THIS_YEAR] = "2026-11-26T02:31:00Z";
    lovdata.files[THIS_YEAR] = packOf("lf-20260430-0710.xml", "lf-20261117-2402.xml");
    assert.equal((await ensureLocalFresh(data, forced)).warning, undefined);
    assert.deepEqual(has(data, "forskrift/2026-11-17-2402"), { package: THIS_YEAR, date: "2026-11-26T02:31:00Z" });
  });

  await t.test("at New Year the packages get new names, and the index follows", async () => {
    const [older, thisYear] = ["lovtidend-avd2-2001-2026.tar.bz2", "lovtidend-avd2-2027.tar.bz2"];
    lovdata.dates[older] = "2027-01-02T02:31:00Z";
    lovdata.dates[thisYear] = "2027-01-02T02:31:00Z";
    lovdata.files[older] = packOf("lf-20260410-0582.xml", "lf-20260430-0710.xml", "lf-20261117-2402.xml");
    lovdata.files[thisYear] = packOf("lf-20260603-1082.xml");
    for (const gone of [OLDER, THIS_YEAR]) {
      delete lovdata.dates[gone];
      delete lovdata.files[gone];
    }
    assert.equal((await ensureLocalFresh(data, forced)).warning, undefined);
    assert.deepEqual(has(data, "forskrift/2026-04-10-582"), { package: older, date: "2027-01-02T02:31:00Z" });
    assert.deepEqual(has(data, "forskrift/2026-06-03-1082"), { package: thisYear, date: "2027-01-02T02:31:00Z" });
    lovdata.requests.length = 0;
    await ensureLocalFresh(data, forced);
    assert.deepEqual(lovdata.requests, ["/list"]);
  });

  const thisYear = "lovtidend-avd2-2027.tar.bz2";
  const working = () => lovdata.files[thisYear];
  const good = packOf("lf-20260603-1082.xml");
  const leftovers = () => fs.readdirSync(data).filter((name) => name.startsWith("build-") || name === "lokal.lock");

  await t.test("a package that cannot be unpacked leaves the old index in place, with a warning", async () => {
    lovdata.dates[thisYear] = "2027-01-03T02:31:00Z";
    lovdata.files[thisYear] = Buffer.from("this is not a bzip2 archive");
    const result = await ensureLocalFresh(data, forced);
    assert.match(result.warning, /nyere pakke, men den lot seg ikke hente og indeksere/);
    assert.equal(has(data, "forskrift/2026-06-03-1082").date, "2027-01-02T02:31:00Z");
    assert.deepEqual(leftovers(), []);
  });

  await t.test("a document the build thread cannot read fails the build, and says which", async () => {
    const broken = tempDir();
    fs.mkdirSync(path.join(broken, "ltii", "2027"), { recursive: true });
    fs.writeFileSync(path.join(broken, "ltii", "2027", "lf-20270102-0001.xml"), "<html><body>not a regulation</body></html>");
    lovdata.files[thisYear] = pack(broken);
    const result = await ensureLocalFresh(data, forced);
    assert.match(result.warning, /Could not index lf-20270102-0001\.xml/);
    assert.equal(has(data, "forskrift/2026-06-03-1082").date, "2027-01-02T02:31:00Z");
    assert.deepEqual(leftovers(), []);
    lovdata.files[thisYear] = good;
    assert.equal(working(), good);
  });

  await t.test("while another process builds the index, this one neither downloads nor waits", async () => {
    fs.writeFileSync(path.join(data, "lokal.lock"), "");
    lovdata.requests.length = 0;
    const result = await ensureLocalFresh(data, forced);
    assert.match(result.warning, /En annen prosess henter og indekserer lokale forskrifter akkurat nå\. Svaret er fra den forrige pakken\./);
    assert.deepEqual(lovdata.requests, ["/list"]);
    assert.equal(has(data, "forskrift/2026-06-03-1082").date, "2027-01-02T02:31:00Z");
  });

  await t.test("a lock left by a killed process does not stop the index from being built", async () => {
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(path.join(data, "lokal.lock"), longAgo, longAgo);
    assert.equal((await ensureLocalFresh(data, forced)).warning, undefined);
    assert.equal(has(data, "forskrift/2026-06-03-1082").date, "2027-01-03T02:31:00Z");
    assert.deepEqual(leftovers(), []);
  });

  await t.test("not found is told together with the warning that current law could not be updated", async () => {
    lovdata.dates[LOVER] = "2027-01-04T02:32:00Z";
    lovdata.files[LOVER] = Buffer.from("this is not a bzip2 archive");
    assert.match((await ensureFresh(data, forced)).warning, /nyere pakke/);
    fs.rmSync(path.join(data, "checked.json")); // as if the check interval had run out
    const answer = await hentParagraf({ dokument: "tulleloven" }, data);
    assert.match(answer, /Fant ingen gjeldende lov eller sentral forskrift som heter «tulleloven»\./);
    assert.match(answer, /ADVARSEL om gjeldende lover og sentrale forskrifter: Lovdata har lagt ut en nyere pakke/);
  });

  await t.test("if Lovdata stops publishing local regulations, the old index is kept, with a warning", async () => {
    fs.rmSync(path.join(data, "checked-lokal.json"));
    for (const name of Object.keys(lovdata.dates)) if (name.startsWith("lovtidend-")) delete lovdata.dates[name];
    const other = tempDir(); // a fresh process would not remember the failure above
    fs.cpSync(data, other, { recursive: true });
    const result = await ensureLocalFresh(other, options);
    assert.match(result.warning, /no longer contains local regulations/);
    assert.notEqual(has(other, "forskrift/2026-04-10-582"), null);
  });

  await lovdata.close();
});

/** The same data directory with current law in place too, so a lookup can fall through to the local index. */
async function withCurrentLaw(data, lovdata) {
  await ensureFresh(data, { api: lovdata.api });
  return data;
}
