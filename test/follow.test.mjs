// What follows a paragraph around: who points to it, what it said before, and whether the
// paragraphs we have pinned still read the way they did.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ensureFresh } from "../src/store.mjs";
import { parseLovdataDocument } from "../src/parse.mjs";
import { hentParagraf, henvisninger, historikk } from "../src/answers.mjs";
import { checkPins, createPin, readPins, writePins } from "../src/pins.mjs";
import { FIXTURES, LOVER, buildDataDir, corruptedLover, fakeLovdata, pack, tempDir } from "./helpers.mjs";

test("a paragraph lists the provisions that point to it, with where in it they point", async () => {
  const dir = buildDataDir();
  const answer = await henvisninger({ dokument: "aml", paragraf: "§ 14-9" }, dir);
  assert.match(answer, /^5 bestemmelser viser til denne paragrafen \(slik Lovdata har lenket det, ikke nødvendigvis fullstendig\)/m);
  assert.match(answer, /^- Arbeidsmiljøloven – aml \(LOV-2005-06-17-62\) · § 14-11\. Virkninger av brudd/m);
  assert.doesNotMatch(answer, /· § 14-9\. /, "a paragraph does not point to itself");
  assert.match(answer, /NLOD\) 2\.0/);

  const limited = await henvisninger({ dokument: "aml", paragraf: "§ 14-9", antall: 2 }, dir);
  assert.match(limited, /\(Viser 2 av 5\. Øk antall for å se flere\.\)/);

  const article = await henvisninger({ dokument: "personopplysningsloven", paragraf: "artikkel 6" }, dir);
  assert.match(article, /· § 8\. Behandling av personopplysninger for arkivformål/);

  assert.match(await hentParagraf({ dokument: "aml", paragraf: "§ 14-9" }, dir), /5 andre bestemmelser viser til denne paragrafen/);
  assert.match(await henvisninger({ dokument: "aml", paragraf: "§ 999" }, dir), /Fant ikke «§ 999»/);
});

test("links in Lovdata's notes are not counted as the law pointing somewhere", () => {
  const { parts } = parseLovdataDocument(
    '<html><body><dl class="data-document-key-info"><dd class="title">T</dd><dd class="refid">lov/2001-01-01-9</dd></dl>' +
      '<main class="documentBody"><article class="legalArticle" data-name="§1">' +
      '<article class="legalP">Se <a href="lov/2005-06-17-62/§14-9/ledd/2">§ 14-9 andre ledd</a>.</article>' +
      '<article class="changesToParent">Endret ved <a href="lov/2005-06-17-62/§14-2">lov</a>.</article>' +
      "</article></main></body></html>",
  );
  assert.deepEqual(parts.find((p) => p.name === "§1").links, ["lov/2005-06-17-62/§14-9/ledd/2"]);
});

/** A stand-in for the agent channel's meld.mjs that writes each message to a file. */
function fakeChannel() {
  const dir = tempDir();
  const out = path.join(dir, "sent.jsonl");
  const module = path.join(dir, "meld.mjs");
  fs.writeFileSync(
    module,
    `import fs from "node:fs";
     export const adresse = (role) => role + "@test";
     export const nyId = () => "id";
     export const valider = (m) => (m.tittel.length > 80 ? ["tittel"] : m.detaljer.length > 600 ? ["detaljer"] : []);
     export const skriv = (m) => fs.appendFileSync(${JSON.stringify(out)}, JSON.stringify(m) + "\\n");`,
  );
  return { module, sent: () => (fs.existsSync(out) ? fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
}

test("a new package keeps the old wording, and reports the pinned paragraphs that changed", async (t) => {
  const lovdata = await fakeLovdata();
  const dir = tempDir();
  const options = { api: lovdata.api, force: true };
  const channel = fakeChannel();
  const pins = path.join(tempDir(), "pins.json");
  const before = { pins: process.env.LOVDATA_MCP_PINS, meld: process.env.LOVDATA_MCP_MELD };
  process.env.LOVDATA_MCP_PINS = pins;
  process.env.LOVDATA_MCP_MELD = channel.module;
  t.after(async () => {
    process.env.LOVDATA_MCP_PINS = before.pins;
    delete process.env.LOVDATA_MCP_MELD;
    await lovdata.close();
  });

  await ensureFresh(dir, options);
  writePins([
    createPin(dir, "aml", "§ 14-9", "midlertidig ansettelse i vaktappen"),
    createPin(dir, "ehandelsloven", "§ 9", "merking av e-post"),
    createPin(dir, "lov/2001-01-01-1", "innledning", "finnes bare for testen"),
  ]);

  await t.test("before anything has changed there is no history and no message", async () => {
    assert.match(await historikk({ dokument: "aml", paragraf: "§ 14-9" }, dir), /Ingen historikk er lagret ennå/);
    assert.deepEqual(checkPins(dir).map((r) => r.status), ["ok", "ok", "ok"]);
    assert.deepEqual(channel.sent(), []);
  });

  // Next night: one character is gone from aml § 14-9, and one act is no longer current law.
  const changed = corruptedLover();
  fs.rmSync(path.join(changed, "nl", "nl-20010101-001.xml"));
  lovdata.dates[LOVER] = "2026-11-22T02:32:00Z";
  lovdata.files[LOVER] = pack(changed);
  assert.equal((await ensureFresh(dir, options)).warning, undefined);

  await t.test("the earlier wording is kept verbatim, with the package dates", async () => {
    const earlier = await historikk({ dokument: "aml", paragraf: "§ 14-9" }, dir);
    assert.match(earlier, /Ordlyd til og med pakken datert 2026-11-21T02:32:00Z, erstattet i pakken datert 2026-11-22T02:32:00Z:\n§ 14-9\. Fast og midlertidig ansettelse\n\(1\) Arbeidstaker skal ansettes fast\. Med/);
    assert.match(earlier, /Historikken starter med pakken datert 2026-11-21T02:32:00Z\. Eldre ordlyd finnes ikke her\./);
    assert.match(earlier, /NLOD\) 2\.0/);

    const now = await hentParagraf({ dokument: "aml", paragraf: "§ 14-9" }, dir);
    assert.match(now, /\(1\) Arbeidstaker skal ansettes fast Med/);
    assert.match(now, /Paragrafen er endret siden 2026-11-21T02:32:00Z\. Tidligere ordlyd: verktøyet historikk\./);
  });

  await t.test("only what changed is kept", async () => {
    assert.match(await historikk({ dokument: "aml" }, dir), /nyeste først:\n- §14-9: teksten endret i pakken datert 2026-11-22T02:32:00Z\n\n/);
    assert.match(await historikk({ dokument: "aml", paragraf: "§ 14-2" }, dir), /Ingen endringer i «§ 14-2» siden/);
    assert.doesNotMatch(await hentParagraf({ dokument: "aml", paragraf: "§ 14-2" }, dir), /Tidligere ordlyd/);
  });

  await t.test("an act that is no longer current law is still found by its ID", async () => {
    const gone = await historikk({ dokument: "LOV-2001-01-01-1" }, dir);
    assert.match(gone, /Dokumentet er ikke lenger blant gjeldende lover og forskrifter\./);
    assert.match(gone, /: tatt ut i pakken datert 2026-11-22T02:32:00Z/);
    assert.match(await historikk({ dokument: "LOV-2001-01-01-1", paragraf: "innledning" }, dir), /borte i pakken datert 2026-11-22T02:32:00Z\. Siste ordlyd:\n./);
  });

  await t.test("the pins that differ are reported once, in one message", async () => {
    assert.deepEqual(checkPins(dir).map((r) => r.status), ["endret", "ok", "mangler"]);
    const sent = channel.sent();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].tittel, "Lovdata: 2 av paragrafene vi bygger på er endret i ny pakke");
    assert.match(sent[0].detaljer, /- Arbeidsmiljøloven – aml § 14-9: teksten er endret\. Brukes til: midlertidig ansettelse i vaktappen\n/);
    assert.match(sent[0].detaljer, /Endringslov til ehandelsloven innledning: finnes ikke lenger i gjeldende lov\. Brukes til: finnes bare for testen/);
    assert.doesNotMatch(sent[0].detaljer, /merking av e-post/);

    lovdata.dates[LOVER] = "2026-11-23T02:32:00Z"; // a new package where nothing more has changed
    await ensureFresh(dir, options);
    assert.equal(channel.sent().length, 1);
  });

  await t.test("accepting the new text makes the pin current again", () => {
    const accepted = checkPins(dir).map((r) => (r.now ? { ...r.now, hvorfor: r.pin.hvorfor } : r.pin));
    writePins(accepted);
    assert.deepEqual(checkPins(dir).map((r) => r.status), ["ok", "ok", "mangler"]);
    assert.equal(readPins()[0].tekstdato, "2026-11-23T02:32:00Z");
  });

  await t.test("a notice of a pending change on a pinned paragraph counts as a difference", () => {
    const [pin] = readPins();
    assert.equal(checkPins(dir, [{ ...pin, varslet: "Endres ved lov som ikke finnes." }])[0].status, "varsel");
  });
});

test("the channel message stays within the channel's limits however many pins differ", async () => {
  const dir = buildDataDir();
  const channel = fakeChannel();
  const pins = path.join(tempDir(), "pins.json");
  const pin = createPin(dir, "aml", "§ 14-9", "en ganske lang begrunnelse for hvorfor akkurat denne paragrafen er festet");
  fs.writeFileSync(pins, JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ ...pin, paragraf: "§14-" + (i + 1), sha256: "stale" }))));
  process.env.LOVDATA_MCP_PINS = pins;
  process.env.LOVDATA_MCP_MELD = channel.module;
  try {
    const { notifyPinChanges } = await import(pathToFileURL(path.join(FIXTURES, "../../src/pins.mjs")).href);
    await notifyPinChanges(dir);
  } finally {
    delete process.env.LOVDATA_MCP_MELD;
  }
  const [message] = channel.sent();
  assert.equal(message.detaljer.length <= 600, true);
  assert.match(message.detaljer, /npm run pins -- accept$/);
});
