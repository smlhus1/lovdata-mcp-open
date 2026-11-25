import test from "node:test";
import assert from "node:assert/strict";
import { Store, paragraphKey } from "../src/store.mjs";
import { hentParagraf, sok } from "../src/answers.mjs";
import fs from "node:fs";
import path from "node:path";
import { PACKAGE_DATE, buildDataDir, tempDir } from "./helpers.mjs";

const dir = buildDataDir();
const withStore = (fn) => {
  const store = new Store(dir);
  try {
    return fn(store);
  } finally {
    store.close();
  }
};

test("paragraph numbers are matched however they are written", () => {
  for (const written of ["§ 14-12 a", "14-12a", "§14-12 A", "§ 14-12 a."]) {
    assert.equal(paragraphKey(written), "14-12a");
  }
  for (const written of ["gdpr/a6", "Artikkel 6", "art. 6", "art 6", "a6"]) {
    assert.equal(paragraphKey(written), "a6");
  }
  assert.notEqual(paragraphKey("§ 1-1"), paragraphKey("§ 11"));
  withStore((store) => {
    assert.equal(store.parts("lov/2005-06-17-62", "14-12 a")[0].heading.startsWith("§ 14-12 a."), true);
    assert.deepEqual(store.parts("lov/2005-06-17-62", "14-1").map((p) => p.name), ["§14-1"]);
  });
});

test("a document is found by popular name, short title, abbreviation and ID", () => {
  withStore((store) => {
    for (const name of ["arbeidsmiljøloven", "Arbeidsmiljøloven", "aml", "LOV-2005-06-17-62", "lov/2005-06-17-62"]) {
      assert.equal(store.resolveDocument(name).doc?.refid, "lov/2005-06-17-62", name);
    }
    assert.equal(store.resolveDocument("e-hl").doc?.refid, "lov/2003-05-23-35");
    assert.equal(store.resolveDocument("FOR-1984-02-13-427").doc?.refid, "forskrift/1984-02-13-427");
    assert.equal(store.resolveDocument("brennbare tekstiler").doc?.refid, "forskrift/1984-02-13-427");
  });
});

test("an ambiguous name gives candidates and an unknown name gives none", () => {
  withStore((store) => {
    const ambiguous = store.resolveDocument("lov");
    assert.equal(ambiguous.doc, undefined);
    assert.equal(ambiguous.candidates.length >= 2, true);
    assert.deepEqual(store.resolveDocument("finnes ikke-loven"), { candidates: [] });
    assert.equal(store.resolveDocument("LOV-1999-01-01-1").doc, undefined);
  });
});

test("search requires all words, supports phrases and prefixes, and can be limited by type", () => {
  withStore((store) => {
    const hits = store.search("midlertidig vikariat");
    assert.equal(hits[0].url, "https://lovdata.no/lov/2005-06-17-62/§14-9");
    assert.equal(store.search('"elektronisk markedsføring"')[0].refid, "lov/2003-05-23-35");
    assert.equal(store.search("brenntid", { type: "lov" }).length, 0);
    assert.equal(store.search("brenntid", { type: "forskrift" })[0].refid, "forskrift/1984-02-13-427");
    assert.equal(store.search("brennt").length, 0);
    assert.equal(store.search("brennt*").length > 0, true);
    assert.equal(store.search("sosialdepartementet bemyndiges")[0].refid, "forskrift/1961-06-16-9392");
  });
});

test("search input cannot break out of the query", () => {
  withStore((store) => {
    for (const hostile of ['"', "a OR b)", "NEAR(", "text:*", "'; DROP TABLE docs; --", "* * *", "§", '"§ -"', "- . ,"]) {
      assert.doesNotThrow(() => store.search(hostile), hostile);
    }
    assert.equal(store.resolveDocument("x' OR '1'='1").candidates.length, 0);
  });
});

test("a paragraph answer carries name, ID, link, text date, source and licence", async () => {
  const answer = await hentParagraf({ dokument: "ehandelsloven", paragraf: "§ 9" }, dir);
  assert.match(answer, /^Lov om visse sider av elektronisk handel/);
  assert.match(answer, /LOV-2003-05-23-35/);
  assert.match(answer, /https:\/\/lovdata\.no\/lov\/2003-05-23-35\/§9/);
  assert.match(answer, /Markedsføringslovens bestemmelser gjelder i tillegg til bestemmelsene i paragrafen her\./);
  assert.match(answer, new RegExp(`Tekstdato: Lovdatas pakke gjeldende-lover\\.tar\\.bz2 datert ${PACKAGE_DATE}`));
  assert.match(answer, /Hele dokumentet sist endret ved: lov\/2023-06-16-38 fra 2023-10-01/);
  assert.match(answer, /Lovdata har ingen endringsnote på denne paragrafen\./);
  assert.doesNotMatch(answer, /VARSLET ENDRING/);
  assert.match(answer, /Kilde: Lovdata/);
  assert.match(answer, /NLOD\) 2\.0/);
});

test("without a paragraph the answer lists the paragraphs, or the whole text if there are none", async () => {
  const outline = await hentParagraf({ dokument: "aml" }, dir);
  assert.match(outline, /§ 14-9\. Fast og midlertidig ansettelse/);
  assert.doesNotMatch(outline, /Arbeidstaker skal ansettes fast/);
  const whole = await hentParagraf({ dokument: "FOR-1961-06-16-9392" }, dir);
  assert.match(whole, /Sosialdepartementet bemyndiges til å oppheve/);
  assert.match(whole, /III\.\nSosialdepartementet bemyndiges til å foreta endringer/);
  assert.match(whole, /NLOD\) 2\.0/);
});

test("a part that is not a paragraph is listed with the name it is fetched by, and can be fetched", async () => {
  const outline = await hentParagraf({ dokument: "personopplysningsloven" }, dir);
  const listed = outline.match(/^(.+) \[paragraf: "([^"]+)"\]$/m);
  assert.notEqual(listed, null);
  const fetched = await hentParagraf({ dokument: "personopplysningsloven", paragraf: listed[2] }, dir);
  assert.equal(fetched.includes("\n" + listed[1] + "\n"), true);
  assert.doesNotMatch(fetched, /Fant ikke/);
});

test("a very long part is cut with a clear notice, never silently", async () => {
  const longest = withStore((store) =>
    store.db.prepare("SELECT refid, name, length(text) AS n FROM parts WHERE name <> '' ORDER BY n DESC LIMIT 1").get(),
  );
  assert.equal(longest.n > 60000, true, "the fixtures must contain a part longer than the limit");
  const answer = await hentParagraf({ dokument: longest.refid, paragraf: longest.name }, dir);
  assert.match(answer, /\[FORKORTET: viser 60000 av \d+ tegn\. Resten står på https:\/\/lovdata\.no\//);
});

test("unknown documents and paragraphs are answered plainly, never with a guess", async () => {
  const noParagraph = await hentParagraf({ dokument: "aml", paragraf: "§ 999" }, dir);
  assert.match(noParagraph, /Fant ikke «§ 999»/);
  assert.match(noParagraph, /Tekstdato: /);
  const noDocument = await hentParagraf({ dokument: "tulleloven", paragraf: "1" }, dir);
  assert.match(noDocument, /Fant ingen gjeldende lov/);
  const ambiguous = await hentParagraf({ dokument: "lov" }, dir);
  assert.match(ambiguous, /passer på flere dokumenter/);
  for (const answer of [noParagraph, noDocument, ambiguous]) assert.match(answer, /Kilde: Lovdata.*NLOD\) 2\.0/);
});

test("a search answer carries link, text date, source and licence", async () => {
  const answer = await sok({ tekst: "brenntid", antall: 5 }, dir);
  assert.match(answer, /https:\/\/lovdata\.no\/forskrift\/1984-02-13-427\/§1/);
  assert.match(answer, /Tekstdato: Lovdatas pakke gjeldende-sentrale-forskrifter\.tar\.bz2/);
  assert.match(answer, /NLOD\) 2\.0/);
  const nothing = await sok({ tekst: "zzzfinnesikke" }, dir);
  assert.match(nothing, /Ingen treff/);
  assert.match(nothing, /Tekstdato: /);
  assert.match(nothing, /NLOD\) 2\.0/);
});

test("at equal relevance a law is ranked before a regulation", () => {
  const document = (type, id) =>
    `<html><body><dl class="data-document-key-info"><dd class="dokid">X/${type}/${id}</dd><dd class="title">Dokument ${id}</dd>` +
    `<dd class="refid">${type}/${id}</dd></dl><main class="documentBody"><article class="legalP">Zebrafinker skal registreres.</article></main></body></html>`;
  const lover = tempDir();
  const forskrifter = tempDir();
  fs.writeFileSync(path.join(forskrifter, "a.xml"), document("forskrift", "2001-01-01-1"));
  fs.writeFileSync(path.join(lover, "b.xml"), document("lov", "2001-01-01-2"));
  const store = new Store(buildDataDir({ lover, forskrifter }));
  try {
    assert.deepEqual(store.search("zebrafinker").map((hit) => hit.type), ["lov", "forskrift"]);
  } finally {
    store.close();
  }
});

test("a paragraph with an adopted change says so, keeps the current text, and points to the new wording", async () => {
  const answer = await hentParagraf({ dokument: "aml", paragraf: "§ 14-2" }, dir);
  assert.match(answer, /VARSLET ENDRING SOM IKKE ER I KRAFT \(Lovdatas note\)\. Teksten over er den som gjelder nå:\nEndres ved lov 19 juni 2026 nr\. 48 \(i kraft 1 jan 2027/);
  assert.match(answer, /Hent den med hent_paragraf, dokument «lov\/2026-06-19-48»\./);
  // The pointer must lead somewhere: the amending act is in the index and names the paragraph.
  const amending = await hentParagraf({ dokument: "lov/2026-06-19-48" }, dir);
  assert.doesNotMatch(amending, /Fant ingen/);
  assert.match(await hentParagraf({ dokument: "aml" }, dir), /§ 14-2\. .*\[varslet endring, ikke i kraft\]/);
});

test("a paragraph lists the regulations issued under it, and a regulation names its legal basis", async () => {
  const paragraph = await hentParagraf({ dokument: "aml", paragraf: "§ 4-4" }, dir);
  assert.match(paragraph, /Forskrifter med hjemmel i denne paragrafen \(slik Lovdata har registrert det, ikke nødvendigvis fullstendig\):\n- .*\(FOR-2006-04-26-457\)/);

  const none = await hentParagraf({ dokument: "aml", paragraf: "§ 14-9" }, dir);
  assert.match(none, /Ingen forskrifter er registrert med hjemmel i akkurat denne paragrafen/);

  const regulation = await hentParagraf({ dokument: "FOR-2006-04-26-457" }, dir);
  assert.match(regulation, /Hjemmel \(slik Lovdata har registrert det, ikke nødvendigvis fullstendig\): Arbeidsmiljøloven – aml \(lov\/2005-06-17-62\): .*§ 4-4/);

  // The legal basis must not leak into the verbatim text of the paragraph itself.
  withStore((store) => assert.doesNotMatch(store.parts("lov/2005-06-17-62", "4-4")[0].text, /Forskrifter med hjemmel/));
});

test("a law's own name gives the law, not an amending act carrying the name in its title", () => {
  withStore((store) => {
    // Both the law and the amending act (fixture nl-20010101-001) end in "(ehandelsloven)".
    assert.equal(store.resolveDocument("ehandelsloven").doc?.refid, "lov/2003-05-23-35");
    assert.equal(store.resolveDocument("endringslov til ehandelsloven").doc?.refid, "lov/2001-01-01-1");
  });
});
