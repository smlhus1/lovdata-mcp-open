import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseLovdataDocument } from "../src/parse.mjs";
import { FIXTURES } from "./helpers.mjs";

const doc = (body) => `<!DOCTYPE html><html lang="nb"><head><title>T</title></head><body>
<header class="documentHeader"><dl class="data-document-key-info">
<dt class="legacyID">Datokode</dt><dd class="legacyID">LOV-2000-01-01-1</dd>
<dt class="dokid">DokumentID</dt><dd class="dokid">NL/lov/2000-01-01-1</dd>
<dt class="titleShort">Korttittel</dt><dd class="titleShort">Testloven – testl</dd>
<dt class="title">Tittel</dt><dd class="title">Lov om test &amp; prøving (testloven)</dd>
<dt class="refid">RefID</dt><dd class="refid">lov/2000-01-01-1</dd>
<dt class="table-of-contents">Innhold</dt><dd class="table-of-contents"><ul><li>§ 1. Ikke lovtekst</li></ul></dd>
</dl></header><main class="documentBody">${body}</main></body></html>`;

const article = (name, inner, title = "Formål") =>
  `<article class="legalArticle" data-lovdata-URL="NL/lov/2000-01-01-1/${name}" data-name="${name}">` +
  `<h3 class="legalArticleHeader"><span class="legalArticleValue">§ 1</span>. <span class="legalArticleTitle">${title}</span></h3>${inner}</article>`;

const only = (body) => {
  const { parts } = parseLovdataDocument(doc(body));
  assert.equal(parts.length, 1);
  return parts[0];
};

const real = (file) => parseLovdataDocument(fs.readFileSync(path.join(FIXTURES, file), "utf8"));
const aml = real("lover/nl/nl-20050617-062.xml");

test("reads metadata and decodes entities", () => {
  const { meta } = parseLovdataDocument(doc(article("§1", "")));
  assert.equal(meta.refid, "lov/2000-01-01-1");
  assert.equal(meta.legacyID, "LOV-2000-01-01-1");
  assert.equal(meta.title, "Lov om test & prøving (testloven)");
  assert.equal(meta["table-of-contents"], undefined);
});

test("each subsection is one line, and inline markup does not break the line", () => {
  const p = only(
    article(
      "§1",
      `<article class="numberedLegalP">(1) Første <i>ledd</i>, jf. <a href="lov/x/§2">§ 2</a>.</article>` +
        `<article class="numberedLegalP">(2) Andre\n   ledd.</article>`,
    ),
  );
  assert.equal(p.kind, "paragraf");
  assert.equal(p.name, "§1");
  assert.equal(p.heading, "§ 1. Formål");
  assert.equal(p.text, "(1) Første ledd, jf. § 2.\n(2) Andre ledd.");
});

test("list items get their label on the same line as their text, also when nested", () => {
  const item = (label, inner) =>
    `<li data-name="${label}"><article class="listArticle"><article class="legalP">${inner}</article></article></li>`;
  const p = only(
    article(
      "§1",
      `<article class="legalP">Det gjelder:<ol class="defaultList">` +
        item("a.", `første<ol class="defaultList">${item("1.", "under")}</ol>`) +
        item("b.", "andre") +
        `</ol></article>`,
    ),
  );
  assert.equal(p.text, "Det gjelder:\na. første\n1. under\nb. andre");
});

test("amendment notes and footnotes are kept out of the legal text, at every level", () => {
  const p = only(
    article(
      "§1",
      `<article class="legalP">Teksten.<sup class="footnotereference">1</sup>` +
        `<footer class="footnotes"><article class="footnote"><span class="footnoteLabel">1</span> Fotnote i leddet.</article></footer></article>` +
        `<article class="changesToParent">Endret ved lov 1 jan 2001 nr. 1.</article>`,
      `Formål</span><sup class="footnotereference">2</sup><span>`,
    ),
  );
  assert.equal(p.heading, "§ 1. Formål");
  assert.equal(p.text, "Teksten.");
  assert.equal(p.notes, "1 Fotnote i leddet.\nEndret ved lov 1 jan 2001 nr. 1.");
});

test("real data: the footnote marker in the heading of aml § 10-12 is not part of the heading", () => {
  const p = aml.parts.find((x) => x.name === "§10-12");
  assert.equal(p.heading, "§ 10-12. Unntak");
  assert.match(p.notes, /^1 /m);
});

test("table cells are separated by a tab, and an empty cell keeps its place", () => {
  const p = only(
    article(
      "§1",
      `<table><caption>Satser</caption><tbody>` +
        `<tr><th>Type</th><th>Lav</th><th>Høy</th></tr>` +
        `<tr><td>Gebyr</td><td data-text-align="left" /><td>500</td></tr>` +
        `<tr><td>Avgift</td><td>100</td><td /></tr>` +
        `</tbody></table><article class="legalP">Etter tabellen.</article>`,
    ),
  );
  assert.equal(p.text, "Satser\nType\tLav\tHøy\nGebyr\t\t500\nAvgift\t100\t\nEtter tabellen.");
});

test("numbers in superscript and subscript stay distinguishable, other content is plain", () => {
  const p = only(
    article("§1", `<article class="legalP">Inntil 50 m<sup>2</sup>, 10<sup>-6</sup> og CO<sub>2</sub>. Se note<sup>a</sup>.</article>`),
  );
  assert.equal(p.text, "Inntil 50 m², 10⁻⁶ og CO₂. Se notea.");
});

test("a picture is marked in the text instead of disappearing", () => {
  const p = only(article("§1", `<article class="legalP">Merket: <img alt="EU-miljømerke" src="x.gif" /> og <img src="y.gif" />.</article>`));
  assert.equal(p.text, "Merket: [bilde: EU-miljømerke] og [bilde].");
});

test("real data: new wording quoted in an amending act is that act's text, not a paragraph of its own", () => {
  // Lov 29. august 2003 nr. 90 amends lotteriloven: "§ 8 a skal lyde:" followed by the wording.
  const { parts } = real("lover/nl/nl-20030829-090.xml");
  const all = parts.map((p) => p.text).join("\n");
  assert.match(all, /§ 8 a skal lyde:\n§ 8 a\. Aldersgrenser\nDepartementet kan i forskrift fastsette aldersgrenser for deltakelse i lotterier\./);
  assert.equal(parts.some((p) => p.name === "§8a"), false);
});

test("an adopted change that is not in force is picked out of the amendment note, with the amending act", () => {
  const note = (inner) => only(article("§1", `<article class="legalP">Tekst.</article><article class="changesToParent">${inner}</article>`));

  const pending = note(
    `Endret ved lov <a href="lov/2019-06-21-24">21 juni 2019 nr. 24</a> (ikr. 1 jan 2020 iflg. <a href="forskrift/2019-06-21-806">res. 21 juni 2019 nr. 806</a>). ` +
      `Endres ved lov <a href="lov/2026-06-19-48">19 juni 2026 nr. 48</a> (i kraft 1 jan 2027 iflg. <a href="forskrift/2026-11-13-2341">res. 13 nov 2026 nr. 2341</a>).`,
  );
  assert.equal(pending.pending, "Endres ved lov 19 juni 2026 nr. 48 (i kraft 1 jan 2027 iflg. res. 13 nov 2026 nr. 2341).");
  assert.deepEqual(pending.pendingRefs, ["lov/2026-06-19-48"]); // not the resolution in the parentheses
  assert.match(pending.notes, /^Endret ved lov 21 juni 2019 nr\. 24 .* Endres ved lov 19 juni 2026 nr\. 48/);

  const inForce = note(`Endret ved lov <a href="lov/2019-06-21-24">21 juni 2019 nr. 24</a> (ikr. 1 jan 2020). Tilføyd ved lov 1 jan 2001 nr. 1.`);
  assert.equal(inForce.pending, "");
  assert.deepEqual(inForce.pendingRefs, []);

  assert.equal(note(`Oppheves ved lov <a href="lov/2026-06-19-41">19 juni 2026 nr. 41</a> (i kraft 1 jan 2027).`).pending.startsWith("Oppheves ved lov"), true);
  assert.equal(note(`Vert endra ved lov <a href="lov/2026-06-19-41">19 juni 2026 nr. 41</a>.`).pendingRefs[0], "lov/2026-06-19-41");
});

test("real data: aml § 14-2 carries the change adopted in 2026, and § 14-9 has none", () => {
  const p = aml.parts.find((x) => x.name === "§14-2");
  assert.match(p.pending, /^Endres ved lov 19 juni 2026 nr\. 48 \(i kraft 1 jan 2027/);
  assert.deepEqual(p.pendingRefs, ["lov/2026-06-19-48"]);
  assert.equal(aml.parts.find((x) => x.name === "§14-9").pending, "");
});

test("real data: a regulation's legal basis is read as act and paragraph", () => {
  const { meta } = real("forskrifter/del/sf-20060426-0457.xml");
  assert.equal(meta.basedOnRefs.includes("lov/2005-06-17-62/§4-4"), true);
  assert.equal(real("lover/nl/nl-20030523-035.xml").meta.basedOnRefs, undefined);
});

test("text outside the paragraphs is kept, one part per chapter", () => {
  const { parts } = parseLovdataDocument(
    doc(
      `<h1>Tittel</h1><article class="legalP">Fortale.</article>` +
        `<section class="section" data-lovdata-URL="NL/lov/2000-01-01-1/KAPITTEL_1"><h2>Kapittel 1. Bare overskrift</h2>${article("§1", `<article class="legalP">Paragraftekst.</article>`)}</section>` +
        `<section class="section" data-lovdata-URL="NL/lov/2000-01-01-1/KAPITTEL_2"><h2>Vedlegg 1</h2><article class="legalP">Vedleggstekst.</article>` +
        `<article class="changesToParent">Vedlegget tilføyd ved lov 2001.</article></section>`,
    ),
  );
  assert.deepEqual(
    parts.map((p) => [p.kind, p.name, p.heading, p.text, p.notes]),
    [
      ["avsnitt", "", "Tittel", "Fortale.", ""],
      ["paragraf", "§1", "§ 1. Formål", "Paragraftekst.", ""],
      ["avsnitt", "KAPITTEL_2", "Vedlegg 1", "Vedleggstekst.", "Vedlegget tilføyd ved lov 2001."],
    ],
  );
});

test("real data: every character of text in the document body ends up in exactly one part", () => {
  // Guards against text being dropped or duplicated when the body is split into parts.
  const files = [
    "lover/nl/nl-20030523-035.xml",
    "forskrifter/sf/sf-19840213-0427.xml",
    "forskrifter/del/sf-19610616-9392.xml",
    // Local regulations as announced in Norsk Lovtidend: a regulation, and one amending it.
    "lokale/ltii/2026/lf-20260603-1082.xml",
    "lokale/ltii/2026/lf-20260430-0710.xml",
  ];
  for (const file of files) {
    const html = fs.readFileSync(path.join(FIXTURES, file), "utf8");
    const { parts } = parseLovdataDocument(html);
    const body = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
    const strip = (s) => s.replace(/\s+/g, "");
    const expected = strip(
      body
        .replace(/<article class="changesToParent">.*?<\/article>/g, "")
        .replace(/<h[1-6][^>]*>[^<]*<\/h[1-6]>/g, "") // chapter headings without text of their own
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&"),
    );
    const got = strip(parts.map((p) => (p.kind === "paragraf" ? p.heading : "") + p.text.replace(/^(\d+\.|[a-z]\.) /gm, "")).join(""));
    assert.equal(got.length > 500, true, file);
    assert.equal(got, expected, file);
  }
});

test("rejects a file that is not a Lovdata document", () => {
  assert.throws(() => parseLovdataDocument("<html><body><p>hei</p></body></html>"), /Not a Lovdata document/);
});
