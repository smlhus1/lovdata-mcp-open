// Pins: the paragraphs your own work rests on, with the hash of the text they had when
// they were pinned. Checked against every new package from Lovdata.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Store, dataDir, INTRODUCTION } from "./store.mjs";
import { partsContent, sha256 } from "./history.mjs";

export const pinsFile = () =>
  process.env.LOVDATA_MCP_PINS || fileURLToPath(new URL("../pins.json", import.meta.url));

export function readPins(file = pinsFile()) {
  if (!fs.existsSync(file)) return [];
  const pins = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(pins)) throw new Error(`${file} must hold a list of pins`);
  return pins;
}

export const writePins = (pins, file = pinsFile()) => fs.writeFileSync(file, JSON.stringify(pins, null, 2) + "\n");

/** The paragraph as the index has it now, or null if the document or paragraph is gone. */
function current(store, dokument, paragraf) {
  const { doc } = store.resolveDocument(dokument);
  const parts = doc ? store.parts(doc.refid, paragraf) : [];
  if (!parts.length) return null;
  return {
    dokument: doc.refid,
    navn: doc.short_title ?? doc.title,
    paragraf: parts[0].name || INTRODUCTION,
    sha256: sha256(partsContent(parts)),
    tekstdato: store.packageDate(doc),
    varslet: parts.map((p) => p.pending).filter(Boolean).join("\n"),
  };
}

/** A new pin for the paragraph as it reads today. Throws if it cannot be found. */
export function createPin(dir, dokument, paragraf, hvorfor) {
  const store = new Store(dir);
  try {
    const now = current(store, dokument, paragraf);
    if (!now) throw new Error(`Fant ikke «${paragraf}» i «${dokument}»`);
    return { ...now, hvorfor };
  } finally {
    store.close();
  }
}

/**
 * @returns {{ pin: object, status: "ok" | "endret" | "varsel" | "mangler", now: object | null }[]}
 * "endret": the text differs. "varsel": the text is the same, the notice of a pending change differs.
 * "mangler": the document or paragraph is no longer in the current law.
 */
export function checkPins(dir = dataDir(), pins = readPins()) {
  if (!pins.length) return [];
  const store = new Store(dir);
  try {
    return pins.map((pin) => {
      const now = current(store, pin.dokument, pin.paragraf);
      const status = !now ? "mangler" : now.sha256 !== pin.sha256 ? "endret" : now.varslet !== pin.varslet ? "varsel" : "ok";
      return { pin, status, now };
    });
  } finally {
    store.close();
  }
}

const STATUS_TEXT = {
  endret: "teksten er endret",
  varsel: "varselet om kommende endring er nytt eller endret",
  mangler: "finnes ikke lenger i gjeldende lov",
};

export const describe = ({ pin, status }) =>
  `${pin.navn} ${pin.paragraf.replace(/^§/, "§ ")}: ${STATUS_TEXT[status]}. Brukes til: ${pin.hvorfor}`;

const notifiedFile = (dir) => path.join(dir, "pins-notified.json");

/**
 * Run after a new package is in place. Sends one message about pins that differ, and
 * remembers what it has told, so the same difference is not reported every night.
 * With LOVDATA_MCP_MELD (path to a module exporting nyId, adresse, valider and skriv) the
 * message goes through that module, to LOVDATA_MCP_MELD_TIL; without
 * it, to stderr. A failure here must never stop the update itself.
 */
export async function notifyPinChanges(dir) {
  try {
    const differing = checkPins(dir).filter((r) => r.status !== "ok");
    let told = {};
    try {
      told = JSON.parse(fs.readFileSync(notifiedFile(dir), "utf8"));
    } catch {
      // nothing told yet
    }
    const state = (r) => `${r.status} ${r.now?.sha256 ?? ""} ${sha256(r.now?.varslet ?? "")}`;
    const id = (r) => `${r.pin.dokument} ${r.pin.paragraf}`;
    const fresh = differing.filter((r) => told[id(r)] !== state(r));
    if (!fresh.length) return;
    fs.writeFileSync(notifiedFile(dir), JSON.stringify({ ...told, ...Object.fromEntries(fresh.map((r) => [id(r), state(r)])) }));

    const title = `Lovdata: ${fresh.length} av paragrafene vi bygger på er endret i ny pakke`;
    const lines = fresh.map((r) => "- " + describe(r));
    const meld = process.env.LOVDATA_MCP_MELD;
    if (!meld) {
      console.error(`[lovdata-mcp] ${title}\n${lines.join("\n")}`);
      return;
    }
    const { nyId, valider, skriv, adresse } = await import(pathToFileURL(meld).href);
    const fra = adresse("lovdata");
    const closing = "Gammel ordlyd: verktøyet historikk. Godta ny tekst: npm run pins -- accept";
    let details = lines.join("\n");
    if (details.length + closing.length + 1 > 600) details = details.slice(0, 600 - closing.length - 3) + "…\n";
    else details += "\n";
    const message = {
      id: nyId(fra),
      tid: new Date().toISOString(),
      fra,
      til: process.env.LOVDATA_MCP_MELD_TIL,
      prosjekt: "lovdata-mcp",
      type: "fremgang",
      tittel: title,
      detaljer: details + closing,
    };
    const errors = valider(message);
    if (errors.length) throw new Error(errors.join("; "));
    skriv(message);
  } catch (err) {
    console.error(`[lovdata-mcp] could not report pin changes: ${err.stack ?? err.message}`);
  }
}
