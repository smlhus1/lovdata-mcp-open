// Local copy of Lovdata's open data: download, index (SQLite + FTS5), lookup and search.
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLovdataDocument } from "./parse.mjs";
import { recordChanges } from "./history.mjs";
import { notifyPinChanges } from "./pins.mjs";

const run = promisify(execFile);

const API = "https://api.lovdata.no/v1/publicData";
export const PACKAGES = {
  "gjeldende-lover.tar.bz2": "lov",
  "gjeldende-sentrale-forskrifter.tar.bz2": "forskrift",
};
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // Lovdata publishes once a night
const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;
const ABANDONED_BUILD_MS = 60 * 60 * 1000;
const SCHEMA_VERSION = "5";
const USER_AGENT = "lovdata-mcp/0.1";

export const dataDir = () =>
  process.env.LOVDATA_MCP_DATA || path.join(os.homedir(), ".lovdata-mcp");
const dbPath = (dir) => path.join(dir, "lovdata.db");
const checkedFile = (dir) => path.join(dir, "checked.json");

async function fetchOk(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res;
}

/** Package dates as published by Lovdata: { filename: lastModified }. */
async function fetchPackageDates(api) {
  const list = await (await fetchOk(`${api}/list`, 15_000)).json();
  const dates = {};
  for (const name of Object.keys(PACKAGES)) {
    const entry = list.find((e) => e.filename === name);
    if (!entry?.lastModified) throw new Error(`Lovdata's list no longer contains ${name}`);
    dates[name] = entry.lastModified;
  }
  return dates;
}

function* xmlFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* xmlFiles(full);
    else if (entry.isFile() && entry.name.endsWith(".xml")) yield full;
  }
}

const SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE docs (
    refid TEXT PRIMARY KEY, legacy_id TEXT, type TEXT NOT NULL, package TEXT NOT NULL,
    title TEXT NOT NULL, short_title TEXT, last_change_in_force TEXT, last_changed_by TEXT,
    areas TEXT, eea TEXT
  );
  CREATE TABLE names (name TEXT NOT NULL, refid TEXT NOT NULL);
  CREATE INDEX names_name ON names (name);
  CREATE TABLE parts (
    id INTEGER PRIMARY KEY, refid TEXT NOT NULL, ord INTEGER NOT NULL, kind TEXT NOT NULL,
    name TEXT NOT NULL, key TEXT NOT NULL, heading TEXT NOT NULL, text TEXT NOT NULL,
    notes TEXT NOT NULL, url TEXT NOT NULL,
    pending TEXT NOT NULL, pending_refs TEXT NOT NULL
  );
  CREATE INDEX parts_lookup ON parts (refid, key);
  -- Legal basis as Lovdata has registered it on each regulation. key is '' when the
  -- regulation names the act without a paragraph.
  CREATE TABLE basis (refid TEXT NOT NULL, target_refid TEXT NOT NULL, target_key TEXT NOT NULL, target_name TEXT NOT NULL);
  CREATE INDEX basis_target ON basis (target_refid, target_key);
  CREATE INDEX basis_source ON basis (refid);
  -- Lovdata's links from the legal text of one part to a paragraph elsewhere. detail is the
  -- rest of the address ("ledd/2/bokstav/a"), '' when the link is to the paragraph as a whole.
  CREATE TABLE links (part_id INTEGER NOT NULL, target_refid TEXT NOT NULL, target_key TEXT NOT NULL, detail TEXT NOT NULL);
  CREATE INDEX links_target ON links (target_refid, target_key);
  CREATE VIRTUAL TABLE fts USING fts5(
    heading, text, content='parts', content_rowid='id',
    tokenize="unicode61 remove_diacritics 0"
  );
`;

/**
 * "§ 14-12 a", "14-12a" and "§14-12 A." all become "14-12a".
 * Articles in incorporated conventions are named "gdpr/a6" by Lovdata; that name,
 * "artikkel 6", "art. 6" and "a6" all become "a6". Chapters are "kapittel_7".
 */
export const paragraphKey = (s) =>
  s
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/^art(ikkel|\.)?\s*(?=\d)/, "a")
    .replace(/[§\s]/g, "")
    .replace(/\.+$/, "");

// "lov/1976-06-11-79/§4" -> act and paragraph; "lov/1898-12-10-1" -> act only.
const BASIS_TARGET = /^((?:lov|forskrift)\/\d{4}-\d{2}-\d{2}(?:-\d+)?)(?:\/(.+))?$/;

// "lov/2005-06-17-62/§14-9/ledd/2" and "lov/2018-06-15-38/gdpr/a6/nr1": act, paragraph, the rest.
const LINK_TARGET = /^((?:lov|forskrift)\/\d{4}-\d{2}-\d{2}(?:-\d+)?)\/(§[^/]+|[a-zæøå]+\/a\d+[a-z]?)(?:\/(.+))?$/;

const normalizeName = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Names a document can be looked up by: full title, short title parts, "(xloven)" in the title. */
/** A document's own names: the parts of its short title ("Arbeidsmiljøloven – aml"). */
function shortTitleNames(titleShort) {
  const names = [];
  for (const part of (titleShort ?? "").split(/\s[–-]\s/)) {
    names.push(part);
    names.push(part.replace(/\s*\([^()]*\)\s*$/, "")); // "Grunnloven (bokmål)" -> "Grunnloven"
    names.push(part.replace(/\.$/, "")); // "Grl." -> "Grl"
  }
  return names.map(normalizeName).filter(Boolean);
}

function documentNames(meta) {
  const names = new Set([meta.title, ...shortTitleNames(meta.titleShort)]);
  // "Lov om ... (arbeidsmiljøloven)" and "Lov om ferie [ferieloven]"
  const popular = meta.title.match(/[([]([^()[\]]+)[)\]]\s*$/);
  if (popular) names.add(popular[1]);
  return [...new Set([...names].map(normalizeName))].filter(Boolean);
}

/**
 * Builds a fresh database from extracted packages. One unreadable document fails the
 * whole build: an index that silently lacks a law is worse than yesterday's index.
 * @param {string} file database file to create (must not exist)
 * @param {{ dir: string, package: string, date: string }[]} sources extracted package directories
 */
export function buildDatabase(file, sources) {
  const db = new DatabaseSync(file);
  try {
    db.exec(SCHEMA);
    const meta = db.prepare("INSERT INTO meta VALUES (?, ?)");
    const doc = db.prepare("INSERT INTO docs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const name = db.prepare("INSERT INTO names VALUES (?, ?)");
    const part = db.prepare(
      `INSERT INTO parts (refid, ord, kind, name, key, heading, text, notes, url, pending, pending_refs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const basis = db.prepare("INSERT INTO basis VALUES (?, ?, ?, ?)");
    const link = db.prepare("INSERT INTO links VALUES (?, ?, ?, ?)");
    db.exec("BEGIN");
    meta.run("schema", SCHEMA_VERSION);
    for (const source of sources) {
      meta.run("package:" + source.package, source.date);
      for (const xml of xmlFiles(source.dir)) {
        try {
          const { meta: m, parts } = parseLovdataDocument(fs.readFileSync(xml, "utf8"));
          // The Constitution comes in two languages with the same refid; the nynorsk file is
          // "…-nn.xml", and lovdata.no addresses it as "lov/1814-05-17-nn".
          const variant = path.basename(xml).match(/-([a-z]{2})\.xml$/)?.[1];
          if (variant) {
            m.refid += "-" + variant;
            if (m.legacyID) m.legacyID += "-" + variant;
          }
          const url = "https://lovdata.no/" + m.refid;
          doc.run(
            m.refid, m.legacyID ?? null, PACKAGES[source.package], source.package,
            m.title, m.titleShort ?? null, m.lastChangeInForce ?? null, m.lastChangedBy ?? null,
            m.legalArea ?? null, m.eeaReferences ?? null,
          );
          for (const n of documentNames(m)) name.run(n, m.refid);
          for (const href of new Set(m.basedOnRefs ?? [])) {
            const target = href.match(BASIS_TARGET);
            if (target) basis.run(m.refid, target[1], target[2] ? paragraphKey(target[2]) : "", target[2] ?? "");
          }
          for (const p of parts) {
            const { lastInsertRowid } = part.run(
              m.refid, p.ord, p.kind, p.name, p.name ? paragraphKey(p.name) : INTRODUCTION, p.heading, p.text, p.notes,
              p.name ? `${url}/${p.name}` : url, p.pending, p.pendingRefs.join(" "),
            );
            for (const href of p.links) {
              const target = href.match(LINK_TARGET);
              if (target) link.run(lastInsertRowid, target[1], paragraphKey(target[2]), target[3] ?? "");
            }
          }
        } catch (err) {
          throw new Error(`Could not index ${path.basename(xml)}: ${err.message}`);
        }
      }
    }
    db.exec("INSERT INTO fts (rowid, heading, text) SELECT id, heading, text FROM parts");
    db.exec("COMMIT");
  } finally {
    db.close(); // an open handle would keep the file locked on Windows
  }
}

/** Removes a directory this module created. Failing to clean up must never hide the real outcome. */
function removeWorkDir(work) {
  try {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.error(`[lovdata-mcp] could not remove ${work}: ${err.message}`);
  }
}

/** Build directories left behind by a process that was killed mid-build. */
function removeAbandonedBuilds(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("build-")) continue;
    const full = path.join(dir, entry.name);
    if (Date.now() - fs.statSync(full).mtimeMs > ABANDONED_BUILD_MS) removeWorkDir(full);
  }
}

/** On Windows the rename fails while another process has the old database open for a query. */
async function replaceFile(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt === 10 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
      await sleep(300);
    }
  }
}

/**
 * Downloads both packages and builds a new database that replaces the old one in a single
 * rename. Everything happens in a directory of this process's own, so several servers
 * sharing the data directory cannot corrupt each other's work.
 */
async function rebuild(dir, api, dates, state) {
  removeAbandonedBuilds(dir);
  const work = fs.mkdtempSync(path.join(dir, "build-"));
  try {
    const sources = [];
    for (const name of Object.keys(PACKAGES)) {
      const res = await fetchOk(`${api}/get/${name}`, 180_000);
      fs.writeFileSync(path.join(work, name), Buffer.from(await res.arrayBuffer()));
      fs.mkdirSync(path.join(work, PACKAGES[name]));
      // cwd and relative names: Git for Windows' tar reads "C:\..." as a remote host.
      await run("tar", ["-xjf", name, "-C", PACKAGES[name]], { cwd: work });
      sources.push({ dir: path.join(work, PACKAGES[name]), package: name, date: dates[name] });
    }
    // The date came from the list before the download. If Lovdata published in between,
    // the text would be newer than the date we label it with.
    const after = await fetchPackageDates(api);
    if (Object.keys(PACKAGES).some((name) => after[name] !== dates[name])) {
      throw new Error("Lovdata published a new package during the download");
    }
    const fresh = path.join(work, "lovdata.db");
    buildDatabase(fresh, sources);
    // Lovdata only publishes the current text. What a paragraph said before is kept from the
    // day we start comparing. A change of schema means a change of parser, so the two indexes
    // cannot be compared then.
    // Losing one night of history is better than answering with yesterday's law.
    if (state?.schema === SCHEMA_VERSION) {
      try {
        recordChanges(dir, dbPath(dir), fresh, state, dates);
      } catch (err) {
        console.error(`[lovdata-mcp] could not record what changed since the last package: ${err.stack ?? err.message}`);
      }
    }
    await replaceFile(fresh, dbPath(dir));
    await notifyPinChanges(dir);
  } finally {
    removeWorkDir(work);
  }
}

/** The index's own record of what it contains, or null if there is no readable index. */
function readState(dir) {
  if (!fs.existsSync(dbPath(dir))) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath(dir), { readOnly: true });
    const rows = db.prepare("SELECT key, value FROM meta").all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch (err) {
    console.error(`[lovdata-mcp] local index is unreadable and will be rebuilt: ${err.message}`);
    return null;
  } finally {
    db?.close();
  }
}

function readCheckedAt(dir) {
  try {
    const { checkedAt } = JSON.parse(fs.readFileSync(checkedFile(dir), "utf8"));
    return Number.isNaN(Date.parse(checkedAt)) ? null : checkedAt;
  } catch {
    return null; // missing or half-written: just check again
  }
}

const inFlight = new Map();
const lastFailure = new Map();

/**
 * Makes sure the local copy matches what Lovdata has published.
 * Asks Lovdata at most every 6 hours. If that fails and a local copy exists, the copy is
 * used, the problem is returned as `warning`, and the next attempt waits 15 minutes.
 * @returns {Promise<{ checkedAt: string | null, warning?: string }>}
 */
export function ensureFresh(dir = dataDir(), options = {}) {
  // One check at a time per directory in this process.
  if (!inFlight.has(dir)) {
    inFlight.set(dir, refresh(dir, options).finally(() => inFlight.delete(dir)));
  }
  return inFlight.get(dir);
}

async function refresh(dir, { force = false, api = API } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const state = readState(dir);
  const usable = state?.schema === SCHEMA_VERSION;
  const checkedAt = readCheckedAt(dir);
  if (usable && !force) {
    const sinceCheck = checkedAt ? Date.now() - Date.parse(checkedAt) : Infinity;
    if (sinceCheck >= 0 && sinceCheck < CHECK_INTERVAL_MS) return { checkedAt };
    const failure = lastFailure.get(dir);
    if (failure && Date.now() - failure.at < RETRY_AFTER_FAILURE_MS) {
      return { checkedAt, warning: failure.warning };
    }
  }

  let warning;
  try {
    let dates;
    try {
      dates = await fetchPackageDates(api);
    } catch (err) {
      warning = `Fikk ikke kontakt med Lovdata for å sjekke om det finnes en nyere pakke (${err.message}). Teksten er fra den lokale kopien og kan være utdatert.`;
      throw err;
    }
    if (!usable || Object.keys(PACKAGES).some((name) => state["package:" + name] !== dates[name])) {
      warning = "Lovdata har lagt ut en nyere pakke, men den lot seg ikke hente og indeksere. Teksten er fra den forrige pakken og kan være utdatert.";
      await rebuild(dir, api, dates, state);
    }
  } catch (err) {
    if (!usable) throw new Error(`Could not fetch data from Lovdata, and there is no local copy: ${err.message}`);
    console.error(`[lovdata-mcp] update failed, using local copy: ${err.message}`);
    warning += ` (${err.message})`;
    lastFailure.set(dir, { at: Date.now(), warning });
    return { checkedAt, warning };
  }
  lastFailure.delete(dir);
  const now = new Date().toISOString();
  // Written under another name first: a reader must never see half a file.
  const tmp = `${checkedFile(dir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ checkedAt: now }));
  await replaceFile(tmp, checkedFile(dir));
  return { checkedAt: now };
}

const ID_PATTERN = /^(lov|for|forskrift)[-/ ]?(\d{4}-\d{2}-\d{2}(?:-\d+)?(?:-[a-z]{2})?)$/i;
export const MAX_CANDIDATES = 20;

/** "LOV-2005-06-17-62" and "lov/2005-06-17-62" -> "lov/2005-06-17-62"; null when it is not an ID. */
export function refidFromId(query) {
  const id = query.trim().match(ID_PATTERN);
  return id ? (id[1].toLowerCase() === "lov" ? "lov/" : "forskrift/") + id[2].toLowerCase() : null;
}
// Text standing directly in a document, outside every chapter and paragraph, is asked for by this name.
export const INTRODUCTION = "innledning";

export class Store {
  constructor(dir = dataDir()) {
    this.dir = dir;
    this.db = new DatabaseSync(dbPath(dir), { readOnly: true });
  }

  close() {
    this.db.close();
  }

  /** @returns {{ doc?: object, candidates: object[] }} at most MAX_CANDIDATES candidates */
  resolveDocument(query) {
    const q = query.trim();
    const refid = refidFromId(q);
    if (refid) {
      const doc = this.db.prepare("SELECT * FROM docs WHERE refid = ?").get(refid);
      return { doc, candidates: [] };
    }
    const exact = this.db
      .prepare("SELECT DISTINCT d.* FROM names n JOIN docs d ON d.refid = n.refid WHERE n.name = ? LIMIT ?")
      .all(normalizeName(q), MAX_CANDIDATES);
    if (exact.length === 1) return { doc: exact[0], candidates: [] };
    if (exact.length > 1) {
      // Amending acts and regulations putting a law into force carry the law's name in
      // their title ("Lov om endringer i ... (ekomloven)"). The document whose own short
      // title is the name wins; failing that, the name of a law means the law.
      const own = exact.filter((d) => shortTitleNames(d.short_title).includes(normalizeName(q)));
      if (own.length === 1) return { doc: own[0], candidates: [] };
      const laws = (own.length ? own : exact).filter((d) => d.type === "lov");
      return laws.length === 1 ? { doc: laws[0], candidates: [] } : { candidates: exact };
    }
    const partial = this.db
      .prepare(
        `SELECT DISTINCT d.* FROM names n JOIN docs d ON d.refid = n.refid
         WHERE instr(n.name, ?) > 0 ORDER BY d.type DESC, length(d.title) LIMIT ?`,
      )
      .all(normalizeName(q), MAX_CANDIDATES);
    if (partial.length === 1) return { doc: partial[0], candidates: [] };
    return { candidates: partial };
  }

  /** Every part carrying Lovdata's notice of an adopted change that is not in force, with its document. */
  pendingParts() {
    return this.db
      .prepare(
        `SELECT p.name, p.kind, p.pending, p.pending_refs, d.refid, d.legacy_id, d.title, d.short_title, d.package, d.areas
         FROM parts p JOIN docs d ON d.refid = p.refid WHERE p.pending <> '' ORDER BY p.id`,
      )
      .all();
  }

  document(refid) {
    return this.db.prepare("SELECT * FROM docs WHERE refid = ?").get(refid);
  }

  packageDate(doc) {
    return this.db.prepare("SELECT value FROM meta WHERE key = ?").get("package:" + doc.package).value;
  }

  /** All parts of the document matching e.g. "§ 14-9" (several if the document reuses numbers). */
  parts(refid, paragraph) {
    return this.db
      .prepare("SELECT * FROM parts WHERE refid = ? AND key = ? ORDER BY ord")
      .all(refid, paragraphKey(paragraph));
  }

  /**
   * Regulations Lovdata has registered with this act (and paragraph) as legal basis.
   * With `key` undefined: every regulation naming the act, with or without paragraph.
   */
  regulationsBasedOn(refid, key) {
    return this.db
      .prepare(
        `SELECT DISTINCT d.refid, d.legacy_id, d.title, d.short_title FROM basis b JOIN docs d ON d.refid = b.refid
         WHERE b.target_refid = ? AND (? IS NULL OR b.target_key = ?) ORDER BY d.refid DESC`,
      )
      .all(refid, key ?? null, key ?? null);
  }

  /** What Lovdata has registered as this regulation's legal basis. */
  basisOf(refid) {
    return this.db
      .prepare(
        `SELECT b.target_refid, b.target_name, d.short_title, d.title FROM basis b
         LEFT JOIN docs d ON d.refid = b.target_refid WHERE b.refid = ? ORDER BY b.rowid`,
      )
      .all(refid);
  }

  /**
   * Parts elsewhere whose text Lovdata has linked to this paragraph: first the same document,
   * then laws, then regulations.
   */
  referencesTo(refid, key, limit) {
    return this.db
      .prepare(
        `SELECT p.refid, p.name, p.kind, p.heading, p.url, d.title, d.short_title, d.legacy_id,
                group_concat(DISTINCT l.detail) AS details
         FROM links l JOIN parts p ON p.id = l.part_id JOIN docs d ON d.refid = p.refid
         WHERE l.target_refid = ? AND l.target_key = ? AND NOT (p.refid = ? AND p.key = ?)
         GROUP BY p.id ORDER BY p.refid = ? DESC, d.type DESC, p.refid DESC, p.ord LIMIT ?`,
      )
      .all(refid, key, refid, key, refid, limit);
  }

  referenceCount(refid, key) {
    return this.db
      .prepare(
        `SELECT count(DISTINCT l.part_id) AS n FROM links l JOIN parts p ON p.id = l.part_id
         WHERE l.target_refid = ? AND l.target_key = ? AND NOT (p.refid = ? AND p.key = ?)`,
      )
      .get(refid, key, refid, key).n;
  }

  /** Whether a document with this refid is in the index. */
  has(refid) {
    return this.db.prepare("SELECT 1 FROM docs WHERE refid = ?").get(refid) !== undefined;
  }

  /** Every part of the document, in order. */
  allParts(refid) {
    return this.db.prepare("SELECT * FROM parts WHERE refid = ? ORDER BY ord").all(refid);
  }

  /**
   * Full-text search. Words must all occur; "quoted phrases" and trailing * (prefix) are supported.
   * @returns {object[]} hits with document, heading, url and a snippet
   */
  search(query, { type, limit = 10 } = {}) {
    const terms = [];
    for (const m of query.matchAll(/"([^"]+)"|(\S+)/g)) {
      const raw = m[1] ?? m[2];
      const prefix = m[2]?.endsWith("*") ? "*" : "";
      // Only letters and digits can match anything; a term without them is dropped.
      const cleaned = raw.replace(/["*]/g, "").trim();
      if (/[\p{L}\p{N}]/u.test(cleaned)) terms.push(`"${cleaned}"${prefix}`);
    }
    if (!terms.length) return [];
    return this.db
      .prepare(
        `SELECT d.refid, d.legacy_id, d.title, d.short_title, d.type, d.package,
                p.kind, p.name, p.heading, p.url,
                snippet(fts, 1, '', '', ' … ', 40) AS snippet
         FROM fts JOIN parts p ON p.id = fts.rowid JOIN docs d ON d.refid = p.refid
         WHERE fts MATCH ? AND (? IS NULL OR d.type = ?)
         -- bm25 is negative, lower is better. A law is the primary source, so at about the
         -- same relevance it goes before a regulation repeating it.
         ORDER BY bm25(fts, 4.0, 1.0) * CASE d.type WHEN 'lov' THEN 1.25 ELSE 1.0 END LIMIT ?`,
      )
      .all(terms.join(" "), type ?? null, type ?? null, limit);
  }
}
