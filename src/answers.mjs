// Turns lookups and searches into the text the MCP tools answer with.
import { Store, ensureFresh, localIndexNow, dataDir, paragraphKey, refidFromId, MAX_CANDIDATES, INTRODUCTION, LOCAL } from "./store.mjs";
import { historyOf, historyOfDocument, historySince } from "./history.mjs";

const LICENSE =
  "Kilde: Lovdata (api.lovdata.no). Lisens: Norsk lisens for offentlige data (NLOD) 2.0, https://data.norge.no/nlod/no/2.0";

const TYPE_LABEL = { lov: "Lov", forskrift: "Forskrift" };
// Longer than any paragraph of a law. Reproduced EU acts in appendices can run to megabytes.
const MAX_TEXT = 60_000;
// A document without paragraphs is shown whole when it is short; otherwise as a list of parts.
const MAX_WHOLE_DOCUMENT = 20_000;

function documentLines(doc) {
  return [
    doc.title,
    `${TYPE_LABEL[doc.type]} · ID: ${doc.legacy_id ?? doc.refid} (${doc.refid})` +
      (doc.short_title ? ` · Korttittel: ${doc.short_title}` : ""),
  ];
}

/** Every answer ends with this: how fresh the text is, where it is from, and the licence. */
function footer(store, docs, fresh) {
  const lines = [];
  const packages = new Map(docs.map((d) => [d.package, store.packageDate(d)]));
  for (const [name, date] of packages) {
    lines.push(`Tekstdato: Lovdatas pakke ${name} datert ${date}. Sist sjekket mot Lovdata: ${fresh.checkedAt ?? "ukjent"}.`);
  }
  if (fresh.warning) lines.push("ADVARSEL: " + fresh.warning);
  lines.push(LICENSE);
  return lines.join("\n");
}

const changeLine = (doc) =>
  doc.last_changed_by
    ? `Hele dokumentet sist endret ved: ${doc.last_changed_by}`
    : doc.last_change_in_force
      ? `Siste endring i kraft: ${doc.last_change_in_force}`
      : "Ingen endringer registrert på dokumentet.";

function candidateList(candidates) {
  const lines = candidates.map((d) => `- ${d.legacy_id ?? d.refid}: ${d.short_title ?? d.title}`);
  if (candidates.length === MAX_CANDIDATES) lines.push(`(Viser de første ${MAX_CANDIDATES}. Det kan finnes flere; vær mer presis eller bruk sok.)`);
  return lines.join("\n");
}

const MAX_REGULATIONS = 30;
const REGISTERED = "slik Lovdata har registrert det, ikke nødvendigvis fullstendig";

const LINKED = "slik Lovdata har lenket det, ikke nødvendigvis fullstendig";

const documentLabel = (d) => `${d.short_title ?? d.title} (${d.legacy_id ?? d.refid})`;

/** Regulations resting on this paragraph. An agent cannot find these by reading the act. */
function regulationLines(store, doc, p) {
  if (p.kind !== "paragraf") return [];
  const onParagraph = store.regulationsBasedOn(doc.refid, p.key);
  if (!onParagraph.length && doc.type !== "lov") return [];
  if (!onParagraph.length) {
    const onAct = store.regulationsBasedOn(doc.refid, "").length;
    return ["", `Ingen forskrifter er registrert med hjemmel i akkurat denne paragrafen (${REGISTERED}). Antall forskrifter som oppgir loven som hjemmel uten å nevne paragraf: ${onAct}.`];
  }
  const out = ["", `Forskrifter med hjemmel i denne paragrafen (${REGISTERED}):`];
  for (const d of onParagraph.slice(0, MAX_REGULATIONS)) out.push(`- ${documentLabel(d)}`);
  if (onParagraph.length > MAX_REGULATIONS) out.push(`(Viser ${MAX_REGULATIONS} av ${onParagraph.length}, nyeste først.)`);
  return out;
}

function partLines(store, doc, p) {
  const out = ["", p.url, "", p.heading];
  if (!p.text) out.push("(Bestemmelsen har ingen tekst i gjeldende utgave.)");
  else if (p.text.length > MAX_TEXT) {
    out.push(p.text.slice(0, MAX_TEXT), `[FORKORTET: viser ${MAX_TEXT} av ${p.text.length} tegn. Resten står på ${p.url}]`);
  } else out.push(p.text);

  if (p.pending) {
    out.push("", "VARSLET ENDRING SOM IKKE ER I KRAFT (Lovdatas note). Teksten over er den som gjelder nå:", p.pending);
    for (const ref of p.pending_refs.split(" ").filter(Boolean)) {
      out.push(
        store.has(ref)
          ? `Den nye ordlyden står i endringsloven. Hent den med hent_paragraf, dokument «${ref}».`
          : `Endringsloven ${ref} ligger ikke i datagrunnlaget. Se https://lovdata.no/${ref}`,
      );
    }
  }
  if (p.notes) out.push("", "Endringer i denne delen ifølge Lovdatas note, og fotnoter (ikke en del av lovteksten):", p.notes);
  else if (p.kind === "paragraf") out.push("", "Lovdata har ingen endringsnote på denne paragrafen.");
  out.push(...regulationLines(store, doc, p));
  const references = p.kind === "paragraf" ? store.referenceCount(doc.refid, p.key) : 0;
  if (references) out.push("", `${references} andre bestemmelser viser til denne paragrafen (${LINKED}). Se dem med verktøyet henvisninger.`);
  const earlier = historyOf(store.dir, doc.refid, p.key).filter((v) => v.change !== "ny");
  if (earlier.length) out.push("", `Paragrafen er endret siden ${historySince(store.dir)}. Tidligere ordlyd: verktøyet historikk.`);
  return out;
}

/** For a regulation: the acts and paragraphs it is issued under. */
function basisLines(store, doc) {
  const basis = store.basisOf(doc.refid);
  if (!basis.length) return [];
  const byAct = new Map();
  for (const b of basis) {
    const act = `${b.short_title ?? b.title ?? "Ikke i datagrunnlaget"} (${b.target_refid})`;
    byAct.set(act, [...(byAct.get(act) ?? []), b.target_name.replace(/^§/, "§ ")].filter(Boolean));
  }
  const targets = [...byAct].map(([act, paragraphs]) => (paragraphs.length ? `${act}: ${paragraphs.join(", ")}` : act));
  return [`Hjemmel (${REGISTERED}): ${targets.join("; ")}`];
}

/** How a part is asked for again: the value to pass as `paragraf`. */
const handle = (p) => (p.kind === "paragraf" ? "" : ` [paragraf: "${p.name || INTRODUCTION}"]`);

async function withStore(dir, fn) {
  const fresh = await ensureFresh(dir);
  const store = new Store(dir);
  try {
    return fn(store, fresh);
  } finally {
    store.close();
  }
}

/** Verbatim paragraph, or the document's table of contents when `paragraf` is left out. */
export async function hentParagraf({ dokument, paragraf }, dir = dataDir()) {
  let stale; // that current law could not be updated matters to "not found" too
  const answer = await withStore(dir, (store, fresh) => {
    const { doc, candidates } = store.resolveDocument(dokument);
    // Not among current laws and central regulations: it may be a local regulation.
    stale = fresh.warning;
    if (!doc && !candidates.length) return null;
    if (!doc) return unknownDocument(store, fresh, dokument, candidates);
    const out = [...documentLines(doc), ...basisLines(store, doc)];

    if (!paragraf) {
      const parts = store.allParts(doc.refid);
      const hasParagraphs = parts.some((p) => p.kind === "paragraf");
      const size = parts.reduce((sum, p) => sum + p.text.length, 0);
      out.push(`https://lovdata.no/${doc.refid}`);
      if (!hasParagraphs && size <= MAX_WHOLE_DOCUMENT) {
        out.push("", "Dokumentet har ingen paragrafer. Hele teksten:");
        for (const p of parts) out.push(...partLines(store, doc, p));
      } else {
        out.push("", "Innhold. Hent en del ordrett ved å oppgi den som paragraf:");
        for (const p of parts) {
          out.push(p.heading.replace(/\n/g, " ") + handle(p) + (p.pending ? " [varslet endring, ikke i kraft]" : ""));
        }
        const regulations = store.regulationsBasedOn(doc.refid).length;
        if (regulations) out.push("", `${regulations} forskrifter har hjemmel i dokumentet (${REGISTERED}). Hent en paragraf for å se hvilke som bygger på den.`);
      }
    } else {
      const hits = store.parts(doc.refid, paragraf);
      if (!hits.length) {
        return [
          `Fant ikke «${paragraf}» i ${doc.short_title ?? doc.title} (${doc.refid}). Kall verktøyet uten paragraf for å se hva dokumentet inneholder.`,
          "",
          footer(store, [doc], fresh),
        ].join("\n");
      }
      if (hits.length > 1) out.push(`Dokumentet har ${hits.length} deler med dette nummeret. Alle vises.`);
      for (const p of hits) out.push(...partLines(store, doc, p));
    }
    out.push("", changeLine(doc), footer(store, [doc], fresh));
    return out.join("\n");
  });
  return answer ?? hentLokal({ dokument, paragraf }, dir, stale);
}

const NOT_CURRENT = (dokument) => `Fant ingen gjeldende lov eller sentral forskrift som heter «${dokument}».`;
const NOT_CONSOLIDATED =
  "Senere endringer er ikke innarbeidet i teksten, og forskriften kan være opphevet. Sjekk gjeldende tekst på lovdata.no før du bygger på den.";
const CHANGES_REGISTERED = "Lovdatas registrering fra 2001 og framover, ikke nødvendigvis fullstendig";

/** "2026-05-04 15:25" -> "2026-05-04" */
const day = (published) => published?.slice(0, 10) ?? "ukjent dato";

/**
 * Answers from the index of local regulations that is in place. Never waits for Lovdata: a
 * rebuild takes minutes and runs in the background. `missing` answers when there is no index yet.
 */
function withLocalStore(dir, fn, missing) {
  const fresh = localIndexNow(dir);
  if (!fresh.usable) return missing(LOCAL_MISSING + (fresh.warning ? ` Siste forsøk feilet: ${fresh.warning}` : ""));
  const store = new Store(dir, LOCAL);
  try {
    return fn(store, fresh);
  } finally {
    store.close();
  }
}

const LOCAL_MISSING =
  "Lokale forskrifter er ikke indeksert på denne maskinen ennå. De hentes fra Lovdata i bakgrunnen, og det tar noen minutter. Prøv igjen da.";

/** What stands above the text of a local regulation: that it is the announced text, and what Lovdata says has happened to it since. */
function announcedLines(store, doc) {
  const a = store.announcement(doc.refid);
  const out = [
    doc.title,
    `Lokal forskrift · ID: ${doc.legacy_id ?? doc.refid} (${doc.refid})` + (doc.short_title ? ` · Korttittel: ${doc.short_title}` : ""),
    "",
    `KUNNGJORT TEKST, IKKE AJOURFØRT. Dette er forskriften slik den ble kunngjort i Norsk Lovtidend ${day(a.published)}. ${NOT_CONSOLIDATED}`,
  ];
  const changedBy = store.changedBy(doc.refid);
  if (changedBy.length) {
    out.push(`Senere kunngjøringer som endrer eller opphever denne forskriften (${CHANGES_REGISTERED}):`);
    for (const c of changedBy) out.push(`- ${c.legacy_id ?? c.refid}, kunngjort ${day(c.published)}: ${c.title}`);
  } else {
    out.push(
      `Ingen senere kunngjøring er registrert som endring eller oppheving av denne forskriften (${CHANGES_REGISTERED}). Det viser ikke at den gjelder uendret.`,
    );
  }
  out.push("");
  if (a.applies_to) out.push(`Gjelder for (Lovdatas opplysning): ${a.applies_to.replace(/\n/g, " ")}`);
  if (a.in_force) out.push(`I kraft fra (Lovdatas opplysning): ${a.in_force.replace(/\n/g, " ")}`);
  // The acts it rests on are in the other index, so they are named by ID. Lovdata's own sentence follows below.
  const basis = store.basisOf(doc.refid).map((b) => (b.target_refid + " " + b.target_name.replace(/^§/, "§ ")).trim());
  if (basis.length) out.push(`Hjemmel (${REGISTERED}): ${basis.join("; ")}`);
  const changes = store.changesMadeBy(doc.refid);
  if (changes.length) {
    const targets = changes.map((c) => (c.title ? `${c.title} (${c.legacy_id ?? c.target_refid})` : `${c.target_refid} (ikke i datagrunnlaget)`));
    out.push(`Endrer eller opphever (${REGISTERED}): ${targets.join("; ")}`);
  }
  if (a.misc) out.push(`Annet om dokumentet (Lovdatas opplysning): ${a.misc.replace(/\s+/g, " ").trim()}`);
  return out;
}

function announcedPartLines(p) {
  const out = ["", p.heading];
  if (!p.text) out.push("(Delen har ingen tekst i kunngjøringen.)");
  else if (p.text.length > MAX_TEXT) {
    out.push(p.text.slice(0, MAX_TEXT), `[FORKORTET: viser ${MAX_TEXT} av ${p.text.length} tegn. Resten står på ${p.url}]`);
  } else out.push(p.text);
  if (p.notes) out.push("", "Lovdatas noter og fotnoter (ikke en del av forskriftsteksten):", p.notes);
  return out;
}

/**
 * A local regulation as announced in Norsk Lovtidend, or the plain answer that the document is unknown.
 * @param {string} [stale] the warning that current law could not be updated, when there is one
 */
function hentLokal({ dokument, paragraf }, dir, stale) {
  // "Not found" is also a statement about current law, so its warning goes with every answer from here.
  const current = stale ? ["ADVARSEL om gjeldende lover og sentrale forskrifter: " + stale] : [];
  return withLocalStore(
    dir,
    (store, fresh) => {
      const { doc, candidates } = store.resolveAnnounced(dokument);
      if (!doc && !candidates.length) {
        return [`${NOT_CURRENT(dokument)} Ingen kunngjort lokal forskrift heter det heller. Prøv verktøyet sok.`, "", ...current, footer(store, [], fresh)].join("\n");
      }
      if (!doc) {
        const lines = candidates.map((d) => `- ${d.legacy_id ?? d.refid}: ${d.title}`);
        if (candidates.length === MAX_CANDIDATES) lines.push(`(Viser de ${MAX_CANDIDATES} nyeste. Det kan finnes flere; vær mer presis eller bruk sok med type «lokal».)`);
        return [
          `${NOT_CURRENT(dokument)} Navnet passer på flere lokale forskrifter slik de ble kunngjort (nyeste først). Bruk ID-en til den du mener:`,
          ...lines,
          "",
          ...current,
          footer(store, candidates, fresh),
        ].join("\n");
      }
      const parts = store.allParts(doc.refid);
      const out = announcedLines(store, doc);
      if (parts.length) out.push(parts[0].url); // every part of an announcement carries the document's address
      if (!paragraf) {
        const hasParagraphs = parts.some((p) => p.kind === "paragraf");
        const size = parts.reduce((sum, p) => sum + p.text.length, 0);
        if (!parts.length) out.push("", "(Dokumentet har ingen tekst i pakken.)");
        else if (!hasParagraphs && size <= MAX_WHOLE_DOCUMENT) {
          out.push("", "Dokumentet har ingen paragrafer. Hele teksten:");
          for (const p of parts) out.push(...announcedPartLines(p));
        } else {
          out.push("", "Innhold. Hent en del ordrett ved å oppgi den som paragraf:");
          for (const p of parts) out.push(p.heading.replace(/\n/g, " ") + handle(p));
        }
      } else {
        const hits = store.parts(doc.refid, paragraf);
        if (!hits.length) {
          return [
            `Fant ikke «${paragraf}» i ${doc.title} (${doc.refid}), slik den ble kunngjort. Kall verktøyet uten paragraf for å se hva dokumentet inneholder.`,
            "",
            ...current,
            footer(store, [doc], fresh),
          ].join("\n");
        }
        if (hits.length > 1) out.push(`Dokumentet har ${hits.length} deler med dette navnet. Alle vises.`);
        for (const p of hits) out.push(...announcedPartLines(p));
      }
      out.push("", ...current, footer(store, [doc], fresh));
      return out.join("\n");
    },
    // The answer about current law stands on its own when there are no local regulations to look in.
    (missing) => [`${NOT_CURRENT(dokument)} Prøv verktøyet sok. ${missing}`, "", ...current, LICENSE].join("\n"),
  );
}

/** Full-text search in local regulations as announced. */
function sokLokal({ tekst, sted, antall }, dir) {
  return withLocalStore(dir, (store, fresh) => {
    const hits = store.searchAnnounced(tekst, { place: sted, limit: antall });
    // The filter is on words in Lovdata's "applies to", so each hit shows that field itself.
    const scope = sted ? `, avgrenset til stedet «${sted}»` : "";
    if (!hits.length) {
      const all = store.db.prepare("SELECT DISTINCT package FROM docs").all();
      return [`Ingen treff på «${tekst}» i kunngjorte lokale forskrifter${scope}.`, "", footer(store, all, fresh)].join("\n");
    }
    const out = [
      `${hits.length} treff på «${tekst}» i lokale forskrifter${scope} (beste først). Utdragene er forkortet.`,
      `KUNNGJORT TEKST, IKKE AJOURFØRT. Hvert treff er en forskrift eller endringsforskrift slik den ble kunngjort i Norsk Lovtidend. ${NOT_CONSOLIDATED}`,
    ];
    for (const h of hits) {
      out.push(
        "",
        `${h.title} (${h.legacy_id ?? h.refid}) · ${h.heading.replace(/\n/g, " ")}${handle(h)}`,
        `Kunngjort ${day(h.published)}` +
          (h.applies_to ? ` · Gjelder for: ${h.applies_to.replace(/\n/g, " ")}` : "") +
          (h.changed ? ` · Endret eller opphevet av ${h.changed} senere kunngjøring${h.changed > 1 ? "er" : ""}` : ""),
        h.url,
        `Utdrag: ${h.snippet.replace(/\s+/g, " ").trim()}`,
      );
    }
    out.push("", "Hent en forskrift med hent_paragraf og ID-en for å se teksten og hvilke senere kunngjøringer som endrer den.", "", footer(store, hits, fresh));
    return out.join("\n");
  }, (missing) => [missing, "", LICENSE].join("\n"));
}

/** Full-text search across laws and central regulations, or in local regulations when asked for. */
export async function sok({ tekst, type, antall, sted }, dir = dataDir()) {
  // A place only makes sense for local regulations, so naming one asks for them.
  if (type === LOCAL || (sted && !type)) return sokLokal({ tekst, sted, antall }, dir);
  const answer = await sokGjeldende({ tekst, type, antall }, dir);
  return sted ? `«sted» gjelder bare lokale forskrifter og er ikke brukt i dette søket.\n\n${answer}` : answer;
}

function sokGjeldende({ tekst, type, antall }, dir) {
  return withStore(dir, (store, fresh) => {
    const hits = store.search(tekst, { type, limit: antall });
    if (!hits.length) {
      const all = store.db.prepare("SELECT DISTINCT package FROM docs").all();
      return [`Ingen treff på «${tekst}».`, "", footer(store, all, fresh)].join("\n");
    }
    const out = [`${hits.length} treff på «${tekst}» (beste først). Utdragene er forkortet. Hent hele teksten med hent_paragraf før du siterer.`];
    for (const h of hits) {
      out.push(
        "",
        `${h.short_title ?? h.title} (${h.legacy_id ?? h.refid}) · ${h.heading.replace(/\n/g, " ")}${handle(h)}`,
        h.url,
        `Utdrag: ${h.snippet.replace(/\s+/g, " ").trim()}`,
      );
    }
    out.push("", footer(store, hits, fresh));
    return out.join("\n");
  });
}

function unknownDocument(store, fresh, dokument, candidates) {
  const message = candidates.length
    ? `«${dokument}» passer på flere dokumenter. Bruk ID-en til det du mener:\n${candidateList(candidates)}`
    : `Fant ingen gjeldende lov eller sentral forskrift som heter «${dokument}». Prøv verktøyet sok.`;
  return [message, "", footer(store, candidates, fresh)].join("\n");
}

const firstLine = (s) => s.split("\n")[0];
// "ledd/2/bokstav/a" -> "ledd 2 bokstav a"
const where = (details) => {
  const places = details.split(",").filter(Boolean).map((d) => d.replace(/\//g, " "));
  return places.length ? ` (viser til ${places.join(" og ")})` : "";
};

/** Which other provisions point to this paragraph. Cannot be found by reading the paragraph itself. */
export function henvisninger({ dokument, paragraf, antall = 50 }, dir = dataDir()) {
  return withStore(dir, (store, fresh) => {
    const { doc, candidates } = store.resolveDocument(dokument);
    if (!doc) return unknownDocument(store, fresh, dokument, candidates);
    const hits = store.parts(doc.refid, paragraf);
    if (!hits.length) {
      return [`Fant ikke «${paragraf}» i ${doc.short_title ?? doc.title} (${doc.refid}).`, "", footer(store, [doc], fresh)].join("\n");
    }
    const key = hits[0].key;
    const total = store.referenceCount(doc.refid, key);
    const out = [...documentLines(doc), firstLine(hits[0].heading), hits[0].url, ""];
    if (!total) out.push(`Ingen andre bestemmelser er lenket til denne paragrafen (${LINKED}).`);
    else {
      const rows = store.referencesTo(doc.refid, key, antall);
      out.push(`${total} bestemmelser viser til denne paragrafen (${LINKED}). Samme dokument først, så lover, så forskrifter:`);
      for (const r of rows) {
        out.push(`- ${r.short_title ?? r.title} (${r.legacy_id ?? r.refid}) · ${firstLine(r.heading)}${handle(r)}${where(r.details)}`);
      }
      if (total > rows.length) out.push(`(Viser ${rows.length} av ${total}. Øk antall for å se flere.)`);
      out.push("", "Henvisninger til hele loven eller til et kapittel er ikke med. Hent bestemmelsen med hent_paragraf før du bygger på den.");
    }
    out.push("", footer(store, [doc], fresh));
    return out.join("\n");
  });
}

const CHANGE_LABEL = { endret: "teksten endret", varsel: "varsel om kommende endring endret", opphevet: "tatt ut", ny: "ny" };

function versionLines(v) {
  if (v.change === "ny") return [`Kom inn i pakken datert ${v.replaced}. Fantes ikke i pakken datert ${v.last_seen}.`];
  if (v.change === "varsel") {
    return [`Varselet om kommende endring ble endret i pakken datert ${v.replaced}. Teksten var uendret. Før sto det:`, v.pending || "(ingen varsel)"];
  }
  const out = [
    v.change === "opphevet"
      ? `Fantes til og med pakken datert ${v.last_seen}, borte i pakken datert ${v.replaced}. Siste ordlyd:`
      : `Ordlyd til og med pakken datert ${v.last_seen}, erstattet i pakken datert ${v.replaced}:`,
    v.text.length > MAX_TEXT ? v.text.slice(0, MAX_TEXT) + `\n[FORKORTET: viser ${MAX_TEXT} av ${v.text.length} tegn.]` : v.text,
  ];
  if (v.pending) out.push("Varslet endring den gangen:", v.pending);
  return out;
}

/** Earlier wording of a paragraph, as far back as this installation has kept it. */
export function historikk({ dokument, paragraf }, dir = dataDir()) {
  return withStore(dir, (store, fresh) => {
    const { doc, candidates } = store.resolveDocument(dokument);
    // A repealed act is no longer in the index, but its ID still finds its history.
    const refid = doc?.refid ?? refidFromId(dokument);
    const changed = refid ? historyOfDocument(dir, refid) : [];
    if (!doc && !changed.length) return unknownDocument(store, fresh, dokument, candidates);

    const packages = doc ? [doc] : store.db.prepare("SELECT DISTINCT package FROM docs").all();
    const since = historySince(dir);
    const out = doc ? documentLines(doc) : [`${changed[0].document} (${refid}). Dokumentet er ikke lenger blant gjeldende lover og forskrifter.`];
    out.push("");
    if (!since) {
      out.push("Ingen historikk er lagret ennå. Lovdata gir bare gjeldende tekst, og denne installasjonen begynner å ta vare på gammel ordlyd ved første nye pakke.");
    } else if (!paragraf) {
      out.push(changed.length ? `Endringer siden pakken datert ${since}, nyeste først:` : `Ingen endringer i dokumentet siden pakken datert ${since}.`);
      for (const c of changed) out.push(`- ${c.name || INTRODUCTION}: ${CHANGE_LABEL[c.change]} i pakken datert ${c.replaced}`);
    } else {
      const versions = historyOf(dir, refid, paragraphKey(paragraf));
      if (!versions.length) out.push(`Ingen endringer i «${paragraf}» siden pakken datert ${since}.`);
      for (const v of versions) out.push(...versionLines(v), "");
      if (doc && versions.length) out.push("Gjeldende ordlyd: hent_paragraf.");
    }
    if (since) {
      out.push("", `Datoene er datoen på Lovdatas pakke, ikke ikrafttredelse. Historikken starter med pakken datert ${since}. Eldre ordlyd finnes ikke her.`);
    }
    out.push("", footer(store, packages, fresh));
    return out.join("\n");
  });
}

const MONTHS = ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"];
// "i kraft 1 jan 2027 iflg. …" -> "2027-01-01". Only orders the list; the phrase itself is shown verbatim.
function dateIn(phrase) {
  const m = phrase.match(/\bi ?kr(?:aft|\.) (\d{1,2})\.? ([a-zæøå]{3})[a-zæøå]*\.? (\d{4})/);
  const month = m ? MONTHS.indexOf(m[2]) : -1;
  return month < 0 ? null : `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/** The parenthesis that follows the mention of this act in Lovdata's note: when the change takes effect. */
function whenFor(note, refid) {
  const id = refid.match(/(\d{4})-\d{2}-(\d{2})-(\d+)$/);
  const mention = id && note.match(new RegExp(`\\b${+id[2]}\\.? \\S+ ${id[1]} nr\\. ${+id[3]} \\(`));
  if (!mention) return "";
  const start = mention.index + mention[0].length;
  let depth = 1;
  for (let i = start; i < note.length; i++) {
    if (note[i] === "(") depth++;
    else if (note[i] === ")" && --depth === 0) return note.slice(start, i);
  }
  return "";
}

const topAreas = (areas) => [...new Set((areas ?? "").split("\n").filter(Boolean).map((a) => a.split(" > ")[0]))];
const MAX_PHRASES = 4;

/**
 * Everything adopted but not in force, one entry per amending act: what Lovdata's notes on the
 * paragraphs say is coming, when, and which documents it touches.
 */
function pendingActs(store, rows) {
  const acts = new Map();
  for (const row of rows) {
    const refs = row.pending_refs.split(" ").filter(Boolean);
    for (const ref of refs.length ? refs : [""]) {
      const act = acts.get(ref) ?? { ref, doc: ref ? store.document(ref) : null, phrases: new Set(), touched: new Map() };
      const when = ref ? whenFor(row.pending, ref) : "";
      act.phrases.add(when || (ref ? "" : row.pending));
      const touched = act.touched.get(row.refid) ?? { doc: row, parts: [] };
      touched.parts.push(row.name || INTRODUCTION);
      act.touched.set(row.refid, touched);
      acts.set(ref, act);
    }
  }
  for (const act of acts.values()) {
    act.phrases.delete("");
    act.dates = [...act.phrases].map(dateIn).filter(Boolean).sort();
    // The act's own legal areas; an act outside the index borrows those of what it changes.
    act.areas = topAreas(act.doc?.areas ?? [...act.touched.values()].map((t) => t.doc.areas).filter(Boolean).join("\n"));
  }
  return acts;
}

/** The radar as data, for drawing: the same acts `kommende` lists, with nothing filtered out. */
export function kommendeData(dir = dataDir()) {
  return withStore(dir, (store) => {
    const rows = store.pendingParts();
    return {
      pakkedato: rows.length ? store.packageDate(rows[0]).slice(0, 10) : "",
      endringer: [...pendingActs(store, rows).values()].map((act) => ({
        ref: act.ref,
        id: act.doc?.legacy_id ?? act.ref,
        tittel: act.doc ? (act.doc.short_title ?? act.doc.title) : "",
        naar: [...act.phrases],
        datoer: act.dates,
        omraader: act.areas,
        eea: act.doc?.eea?.replace(/\n/g, " ") ?? "",
        beroerer: [...act.touched.entries()].map(([refid, t]) => ({ refid, navn: t.doc.short_title ?? t.doc.title, deler: t.parts })),
      })),
    };
  });
}

export function kommende({ tekst, detaljer = false } = {}, dir = dataDir()) {
  return withStore(dir, (store, fresh) => {
    const rows = store.pendingParts();
    const acts = pendingActs(store, rows);

    const today = rows.length ? store.packageDate(rows[0]).slice(0, 10) : "";
    const needle = tekst?.trim().toLowerCase();
    const shown = [];
    for (const act of acts.values()) {
      // Found by what it touches too: an act on bankruptcy that changes the Working Environment Act is labour law as well.
      const haystack = [act.ref, act.doc?.title, act.doc?.short_title, act.doc?.eea, act.doc?.areas, ...[...act.touched.values()].flatMap((t) => [t.doc.title, t.doc.short_title, t.doc.areas])]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      if (!needle || haystack.includes(needle)) shown.push(act);
    }

    const upcoming = (a) => a.dates.find((d) => d >= today);
    const groups = [
      ["MED DATO (tidligste først)", shown.filter(upcoming).sort((a, b) => upcoming(a).localeCompare(upcoming(b)))],
      ["DATO IKKE FASTSATT (nyeste vedtak først)", shown.filter((a) => !a.dates.length).sort((a, b) => b.ref.localeCompare(a.ref))],
      ["DATOEN I NOTEN ER PASSERT, men Lovdata omtaler fortsatt endringen som kommende", shown.filter((a) => a.dates.length && !upcoming(a))],
    ];

    const out = [
      `Vedtatt, men ikke i kraft: ${shown.length} endringslover og nye lover og forskrifter` +
        (needle ? `, som passer på «${tekst.trim()}» (av ${acts.size})` : "") +
        `. De berører ${new Set(shown.flatMap((a) => [...a.touched.keys()])).size} gjeldende dokumenter.`,
      "Grunnlaget er Lovdatas noter på paragrafene som endres. En ny lov som ikke endrer noen gjeldende paragraf, vises derfor ikke.",
      "Tidspunktet er gjengitt ordrett fra noten. Les endringsloven selv før du bygger på den: hent_paragraf med ID-en.",
    ];
    for (const [title, list] of groups) {
      if (!list.length) continue;
      out.push("", title);
      for (const act of list) {
        const phrases = [...act.phrases];
        out.push(
          "",
          act.doc ? documentLabel(act.doc) : act.ref ? `${act.ref} (ikke i datagrunnlaget)` : "Endringer der noten ikke lenker til endringsloven",
          `  Når: ${phrases.slice(0, MAX_PHRASES).map((p) => `«${p}»`).join("; ") || "står ikke i noten"}` +
            (phrases.length > MAX_PHRASES ? ` (og ${phrases.length - MAX_PHRASES} andre formuleringer)` : ""),
        );
        if (act.areas.length) out.push(`  Rettsområde: ${act.areas.join(", ")}`);
        if (act.doc?.eea) out.push(`  EU/EØS-henvisning: ${act.doc.eea.replace(/\n/g, " ")}`);
        const touched = [...act.touched.values()].sort((a, b) => b.parts.length - a.parts.length);
        const label = (t) => `${t.doc.short_title ?? t.doc.title} (${detaljer ? t.parts.join(", ") : t.parts.length})`;
        const limit = detaljer ? touched.length : 8;
        out.push(`  Berører: ${touched.slice(0, limit).map(label).join("; ")}` + (touched.length > limit ? `; og ${touched.length - limit} dokumenter til` : ""));
      }
    }
    out.push("", footer(store, rows.length ? rows : store.db.prepare("SELECT DISTINCT package FROM docs").all(), fresh));
    return out.join("\n");
  });
}
