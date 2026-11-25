// What is adopted but not in force, across every law and regulation in the index.
import test from "node:test";
import assert from "node:assert/strict";
import { kommende, kommendeData } from "../src/answers.mjs";
import { buildDataDir } from "./helpers.mjs";

test("what is adopted but not in force is listed per amending act, with Lovdata's own words for when", async () => {
  const dir = buildDataDir();
  const answer = await kommende({}, dir);
  assert.match(answer, /^Vedtatt, men ikke i kraft: 1 endringslover/);
  assert.match(
    answer,
    /MED DATO \(tidligste først\)\n\nEndringslov til konkursloven mv\. \(LOV-2026-06-19-48\)\n  Når: «i kraft 1 jan 2027 iflg\. res\. 13 nov 2026 nr\. 2341»/,
  );
  assert.match(answer, /^  Rettsområde: Konkurs, gjeld og pant$/m);
  assert.match(answer, /^  Berører: Arbeidsmiljøloven – aml \(1\)$/m);
  assert.match(answer, /NLOD\) 2\.0/);

  assert.match(await kommende({ detaljer: true }, dir), /^  Berører: Arbeidsmiljøloven – aml \(§14-2\)$/m);
  assert.match(await kommende({ tekst: "Arbeidsrett" }, dir), /1 endringslover .* som passer på «Arbeidsrett» \(av 1\)/);
  assert.match(await kommende({ tekst: "zzz" }, dir), /^Vedtatt, men ikke i kraft: 0 /);
});

test("the radar as data carries the same entry, with the date parsed and the paragraphs it touches", async () => {
  const { pakkedato, endringer } = await kommendeData(buildDataDir());
  assert.match(pakkedato, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(endringer.length, 1);
  const [act] = endringer;
  assert.equal(act.id, "LOV-2026-06-19-48");
  assert.deepEqual(act.datoer, ["2027-01-01"]);
  assert.deepEqual(act.naar, ["i kraft 1 jan 2027 iflg. res. 13 nov 2026 nr. 2341"]);
  assert.deepEqual(act.omraader, ["Konkurs, gjeld og pant"]);
  assert.deepEqual(act.beroerer.map((b) => [b.navn, b.deler]), [["Arbeidsmiljøloven – aml", ["§14-2"]]]);
});
