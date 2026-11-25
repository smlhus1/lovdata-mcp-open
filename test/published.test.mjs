// The promise: a paragraph from this server is character for character what lovdata.no publishes.
//
// test/published/*.txt is the browser's innerText of the paragraph on lovdata.no, captured
// 2026-11-22. The SHA-256 below was computed inside the browser on that page, so the files
// are proven to be exactly what the site showed. lovdata.no's robots.txt disallows automated
// fetching, so the published text is a stored capture and not fetched by the tests.
//
// Run with LOVDATA_TEST_CORRUPT=1 to point the suite at a copy with one character removed.
// It must then fail.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/store.mjs";
import { PUBLISHED, buildDataDir, corruptedLover } from "./helpers.mjs";

const CASES = [
  {
    name: "arbeidsmiljøloven § 14-9",
    file: "aml-14-9.txt",
    url: "https://lovdata.no/lov/2005-06-17-62/§14-9",
    sha256: "16d804800448a8f15105bf7d6ff81379493c5ab03fa0ae379ca9941a51e8e6e3",
    refid: "lov/2005-06-17-62",
    paragraph: "§ 14-9",
  },
  {
    name: "ehandelsloven § 9",
    file: "ehl-9.txt",
    url: "https://lovdata.no/lov/2003-05-23-35/§9",
    sha256: "1230ac5f22ffe74db0d74fdc7851fd1b76a0ff31ae5cdbbb06886476f30353f2",
    refid: "lov/2003-05-23-35",
    paragraph: "§ 9",
  },
  {
    // An incorporated convention with numbered subsections and nested lists.
    name: "personopplysningsloven, GDPR artikkel 6",
    file: "gdpr-6.txt",
    url: "https://lovdata.no/lov/2018-06-15-38/gdpr/a6",
    sha256: "da3a7e180ad8be0b591ee8d850d27257292c776775194989a27aa256d44b1a71",
    refid: "lov/2018-06-15-38",
    paragraph: "artikkel 6",
  },
];

/**
 * Splits the browser's innerText into heading, legal text and Lovdata's amendment note.
 * Only layout is touched: the tab between a list label and its text becomes a space, and
 * blank lines between subsections are dropped. Every other character is kept.
 */
function splitPublished(innerText) {
  const lines = innerText.replace(/\t/g, " ").split(/\n+/);
  const heading = lines.shift();
  const notes = lines.at(-1).startsWith("0 ") ? lines.pop().slice(2) : "";
  return { heading, text: lines.join("\n"), notes };
}

function fromServer(dir, c) {
  const store = new Store(dir);
  try {
    const hits = store.parts(c.refid, c.paragraph);
    assert.equal(hits.length, 1);
    return hits[0];
  } finally {
    store.close();
  }
}

const readPublished = (c) => fs.readFileSync(path.join(PUBLISHED, c.file), "utf8");

const lover = process.env.LOVDATA_TEST_CORRUPT ? corruptedLover() : undefined;
const dir = buildDataDir({ lover });

for (const c of CASES) {
  test(`${c.name}: the stored capture is exactly what lovdata.no showed`, () => {
    assert.equal(createHash("sha256").update(readPublished(c), "utf8").digest("hex"), c.sha256);
  });

  test(`${c.name}: legal text is character for character equal to lovdata.no`, () => {
    const published = splitPublished(readPublished(c));
    const ours = fromServer(dir, c);
    assert.equal(ours.text, published.text);
    // The site sets heading number and title next to each other without a space in the markup.
    assert.equal(ours.heading.replace(". ", "."), published.heading);
    assert.equal(ours.notes, published.notes);
    assert.equal(ours.url, c.url);
  });
}

test("the comparison catches one missing character in the package", () => {
  const c = CASES[0];
  const ours = fromServer(buildDataDir({ lover: corruptedLover() }), c);
  assert.notEqual(ours.text, splitPublished(readPublished(c)).text);
});
