// What paragraphs said before they changed. Lovdata's packages only hold the current text,
// so earlier wording exists here only from the first package this installation compared.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const historyPath = (dir) => path.join(dir, "history.db");

// One row per version that is no longer the current one. `change` says what replaced it:
// "endret" (text), "varsel" (only the notice of a pending change), "opphevet" (gone), or
// "ny" (the paragraph did not exist before; text is empty).
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS versions (
    refid TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, document TEXT NOT NULL,
    change TEXT NOT NULL, text TEXT NOT NULL, pending TEXT NOT NULL,
    last_seen TEXT NOT NULL, replaced TEXT NOT NULL,
    PRIMARY KEY (refid, key, replaced)
  );
`;

// Another server process may be writing its comparison of the same two packages.
const WAIT = "PRAGMA busy_timeout = 10000;";

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** The text of a paragraph as it is compared and pinned: heading and text of every part with that number. */
export const partsContent = (parts) => parts.map((p) => p.heading + "\n" + p.text).join("\n\n");

/** Per paragraph: one digest of the text and one of the pending-change notice. */
function signatures(db) {
  const all = new Map();
  for (const r of db.prepare("SELECT refid, key, heading, text, pending FROM parts ORDER BY id").iterate()) {
    const id = r.refid + "\n" + r.key;
    const s = all.get(id) ?? { text: "", pending: "" };
    s.text += sha256(r.heading + "\n" + r.text);
    s.pending += sha256(r.pending);
    all.set(id, s);
  }
  return all;
}

const paragraph = (db, refid, key) => {
  const parts = db
    .prepare(
      `SELECT p.name, p.heading, p.text, p.pending, d.package, d.short_title, d.title
       FROM parts p JOIN docs d ON d.refid = p.refid WHERE p.refid = ? AND p.key = ? ORDER BY p.ord`,
    )
    .all(refid, key);
  return {
    name: parts[0].name,
    package: parts[0].package,
    document: parts[0].short_title ?? parts[0].title,
    text: partsContent(parts),
    pending: parts.map((p) => p.pending).filter(Boolean).join("\n"),
  };
};

/**
 * Compares the index in use with the one about to replace it, and keeps the old wording of
 * every paragraph that differs. Safe to run twice for the same pair of packages.
 * @param {Record<string,string>} oldState meta of the old index ("package:<name>" -> date)
 * @param {Record<string,string>} dates package dates of the new index
 */
export function recordChanges(dir, oldFile, newFile, oldState, dates) {
  const oldDb = new DatabaseSync(oldFile, { readOnly: true });
  const newDb = new DatabaseSync(newFile, { readOnly: true });
  const history = new DatabaseSync(historyPath(dir));
  try {
    history.exec(WAIT + SCHEMA);
    const before = signatures(oldDb);
    const after = signatures(newDb);
    const insert = history.prepare("INSERT OR IGNORE INTO versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    history.exec("BEGIN");
    const oldDates = Object.keys(dates).map((name) => oldState["package:" + name]).sort();
    history.prepare("INSERT OR IGNORE INTO meta VALUES ('since', ?)").run(oldDates[0]);
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const was = before.get(id);
      const is = after.get(id);
      if (was && is && was.text === is.text && was.pending === is.pending) continue;
      const [refid, key] = id.split("\n");
      const old = was ? paragraph(oldDb, refid, key) : null;
      const current = old ?? paragraph(newDb, refid, key);
      const change = !was ? "ny" : !is ? "opphevet" : was.text !== is.text ? "endret" : "varsel";
      insert.run(
        refid, key, current.name, current.document, change, old?.text ?? "", old?.pending ?? "",
        oldState["package:" + current.package], dates[current.package],
      );
    }
    history.exec("COMMIT");
  } finally {
    history.close();
    newDb.close();
    oldDb.close();
  }
}

function withHistory(dir, fn, empty) {
  if (!fs.existsSync(historyPath(dir))) return empty;
  const db = new DatabaseSync(historyPath(dir), { readOnly: true });
  try {
    db.exec(WAIT);
    return fn(db);
  } finally {
    db.close();
  }
}

/** Earlier versions of a paragraph, newest first. */
export const historyOf = (dir, refid, key) =>
  withHistory(dir, (db) => db.prepare("SELECT * FROM versions WHERE refid = ? AND key = ? ORDER BY replaced DESC").all(refid, key), []);

/** Every paragraph of the document that has changed, newest first. */
export const historyOfDocument = (dir, refid) =>
  withHistory(
    dir,
    (db) => db.prepare("SELECT refid, key, name, document, change, replaced FROM versions WHERE refid = ? ORDER BY replaced DESC, rowid").all(refid),
    [],
  );

/** Date of the first package the history was compared from, or null when nothing is kept yet. */
export const historySince = (dir) =>
  withHistory(dir, (db) => db.prepare("SELECT value FROM meta WHERE key = 'since'").get()?.value ?? null, null);
