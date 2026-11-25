// Parses one document from Lovdata's open data packages (XML-compatible HTML)
// into metadata and verbatim text, split into addressable parts.
import { parseDocument } from "htmlparser2";

const BLOCK_TAGS = new Set([
  "article", "p", "li", "ol", "ul", "div", "section", "table", "tr",
  "h1", "h2", "h3", "h4", "h5", "h6", "dl", "dt", "dd", "footer", "main", "br", "caption",
]);

const CELL = "\u0001"; // marks the end of a table cell until the line is finished

const SUPERSCRIPT = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", "+": "⁺", "-": "⁻", "−": "⁻" };
const SUBSCRIPT = { 0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉", "+": "₊", "-": "₋", "−": "₋" };

const hasClass = (node, name) =>
  node.type === "tag" && (node.attribs.class ?? "").split(/\s+/).includes(name);

function* descendants(node) {
  for (const child of node.children ?? []) {
    yield child;
    yield* descendants(child);
  }
}

function find(node, predicate) {
  for (const d of descendants(node)) if (predicate(d)) return d;
  return null;
}

const plainText = (node) =>
  node.type === "text" ? node.data : (node.children ?? []).map(plainText).join("");

/**
 * "m<sup>2</sup>" would otherwise become "m2" and "10<sup>-6</sup>" "10-6". Numbers in
 * superscript or subscript are written with the Unicode characters for them (m², 10⁻⁶, CO₂).
 * Anything else is left as plain text. Returns null when the content cannot be mapped.
 */
function scriptText(node) {
  const map = node.name === "sup" ? SUPERSCRIPT : SUBSCRIPT;
  const raw = plainText(node).trim();
  if (!raw || [...raw].some((ch) => !(ch in map))) return null;
  return [...raw].map((ch) => map[ch]).join("");
}

/**
 * Renders a node to lines of text. Block elements start a new line, inline elements do not.
 * List items are prefixed with their label ("a.", "1."), table cells are separated by a tab.
 * Runs of ASCII whitespace collapse to one space, and whitespace at the ends of a line is
 * removed. The characters of the text itself are not altered.
 * Nodes for which `skip` returns true are left out entirely.
 */
export function renderLines(root, skip = () => false) {
  const lines = [];
  let current = "";
  let label = ""; // list item label waiting for the item's first line of text
  const flush = () => {
    const cells = current.split(CELL).map((cell) => cell.replace(/[ \t\r\n]+/g, " ").trim());
    if (cells.at(-1) === "") cells.pop(); // the marker after the last cell
    const line = cells.join("\t");
    if (line.trim()) {
      lines.push(label + line);
      label = "";
    }
    current = "";
  };
  const walk = (node) => {
    if (node.type === "text") {
      current += node.data;
      return;
    }
    if (node.type !== "tag" || skip(node)) return;
    if (node.name === "img") {
      // A picture cannot be quoted; say that it is there instead of dropping it silently.
      current += node.attribs.alt ? `[bilde: ${node.attribs.alt}]` : "[bilde]";
      return;
    }
    if (node.name === "sup" || node.name === "sub") {
      const mapped = scriptText(node);
      if (mapped !== null) {
        current += mapped;
        return;
      }
    }
    const block = BLOCK_TAGS.has(node.name);
    if (block) flush();
    if (node.name === "li" && node.attribs["data-name"]) label += node.attribs["data-name"] + " ";
    for (const child of node.children) walk(child);
    if (node.name === "td" || node.name === "th") current += CELL;
    if (block) flush();
    if (node.name === "li" && label) {
      lines.push(label.trim()); // list item without text of its own
      label = "";
    }
  };
  walk(root);
  flush();
  return lines;
}

function parseHeader(doc) {
  const meta = {};
  const dl = find(doc, (n) => hasClass(n, "data-document-key-info"));
  if (!dl) return meta;
  for (const dd of dl.children) {
    if (dd.type === "tag" && dd.name === "dd" && dd.attribs.class !== "table-of-contents") {
      meta[dd.attribs.class] = renderLines(dd).join("\n");
    }
    // Legal basis of a regulation, as registered by Lovdata: "lov/1976-06-11-79/§4".
    if (dd.type === "tag" && dd.attribs.class === "basedOn") {
      meta.basedOnRefs = [...descendants(dd)]
        .filter((n) => n.type === "tag" && n.name === "a" && n.attribs.href)
        .map((n) => n.attribs.href);
    }
  }
  return meta;
}

// Lovdata's editorial additions: amendment notes and footnotes. Kept apart from the legal text.
const isNote = (n) => hasClass(n, "changesToParent") || hasClass(n, "footnotes");
// Left out of the legal text: footnote markers (the footnote itself is in the notes).
// `futureLegalArticle` is NOT skipped: it is the new wording quoted inside an amending act
// ("§ 8 a skal lyde: ..."), which is that act's own text.
const isNotLawText = (n) => isNote(n) || hasClass(n, "footnotereference");

const ACT_ID = /^(?:lov|forskrift)\/\d{4}-\d{2}-\d{2}(?:-\d+)?$/;
// Lovdata writes changes that have happened in the past tense ("Endret ved", "Tilføyd ved",
// nynorsk "Endra") and adopted changes not yet in force in the present ("Endres ved lov
// 19 juni 2026 nr. 48 (i kraft 1 jan 2027 ...)"). The pending part always comes last.
const PENDING = /(?:^|\. )(?=(?:Endres|Oppheves|Tilføyes|Vert (?:endra|oppheva|føyd)) )/;

/**
 * The part of an amendment note that announces a change not yet in force, verbatim, and
 * the amending acts it links to (where the new wording can be read).
 */
function pendingChange(note) {
  let full = "";
  const links = [];
  const walk = (node) => {
    if (node.type === "text") full += node.data;
    else if (node.type === "tag") {
      if (node.name === "a") links.push({ at: full.length, href: node.attribs.href ?? "" });
      node.children.forEach(walk);
    }
  };
  walk(note);
  const match = full.match(PENDING);
  if (!match) return null;
  const start = match.index + match[0].length;
  const refs = [];
  for (const link of links) {
    if (link.at < start || !ACT_ID.test(link.href)) continue;
    // Links inside parentheses are the resolutions setting the date, not the amending act.
    const before = full.slice(start, link.at);
    const depth = before.split("(").length - before.split(")").length;
    if (depth === 0 && !refs.includes(link.href)) refs.push(link.href);
  }
  return { text: full.slice(start).replace(/[ \t\r\n]+/g, " ").trim(), refs };
}
const isArticle = (n) => hasClass(n, "legalArticle");
const isSection = (n) => hasClass(n, "section");
const isHeading = (n) => n.type === "tag" && /^h[1-6]$/.test(n.name);

const text = (node) => renderLines(node, isNotLawText).join("\n");

/** Notes belonging to `owner`: all levels below it, but not those of nested parts. */
function collectNotes(owner, isOtherPart) {
  const notes = [];
  const pending = [];
  const pendingRefs = [];
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.type !== "tag" || isOtherPart(child)) continue;
      if (isNote(child)) {
        notes.push(renderLines(child).join("\n"));
        const change = hasClass(child, "changesToParent") && pendingChange(child);
        if (change) {
          pending.push(change.text);
          pendingRefs.push(...change.refs);
        }
      } else walk(child);
    }
  };
  walk(owner);
  return {
    notes: notes.filter(Boolean).join("\n"),
    pending: pending.join("\n"),
    pendingRefs: [...new Set(pendingRefs)],
  };
}

/**
 * Lovdata's own links from the legal text of a part to other acts and paragraphs
 * ("lov/2005-06-17-62/§14-9/ledd/2"). Links in notes are not included.
 */
function collectLinks(owner, skip) {
  const links = new Set();
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.type !== "tag" || skip(child)) continue;
      if (child.name === "a" && child.attribs.href) links.add(child.attribs.href);
      walk(child);
    }
  };
  walk(owner);
  return [...links];
}

/** The address Lovdata gives a part, relative to the document: "§14-9", "gdpr/a6", "KAPITTEL_7". */
function partName(node, dokid) {
  const url = node.attribs["data-lovdata-url"] ?? "";
  return dokid && url.startsWith(dokid + "/") ? url.slice(dokid.length + 1) : "";
}

function parseArticle(article, dokid) {
  const header = article.children.find((n) => hasClass(n, "legalArticleHeader"));
  // A few documents nest paragraphs; a nested one is its own entry, not part of the parent.
  const isNested = (n) => n !== article && isArticle(n);
  return {
    kind: "paragraf",
    name: article.attribs["data-name"] || partName(article, dokid),
    heading: header ? text(header) : "",
    text: renderLines(article, (n) => n === header || isNotLawText(n) || isNested(n)).join("\n"),
    links: collectLinks(article, (n) => isNotLawText(n) || isNested(n)),
    ...collectNotes(article, isNested),
  };
}

/**
 * Text that stands outside the paragraphs: preambles, appendices, reproduced EU acts,
 * and documents without paragraph structure. One part per chapter or section, holding
 * the text directly in it. A section with nothing but its heading gives no part.
 */
function parseOutside(container, dokid, fallbackHeading) {
  const header = container.children.find(isHeading);
  const isOtherPart = (n) => n !== container && (isArticle(n) || isSection(n));
  const body = renderLines(container, (n) => n === header || isNotLawText(n) || isOtherPart(n)).join("\n");
  if (!body) return null;
  return {
    kind: "avsnitt",
    name: partName(container, dokid),
    heading: header ? text(header) : fallbackHeading,
    text: body,
    links: collectLinks(container, (n) => isNotLawText(n) || isOtherPart(n)),
    ...collectNotes(container, isOtherPart),
  };
}

/**
 * @param {string} html one document from a Lovdata package
 * @returns {{ meta: Record<string,string>, parts: object[] }} parts in document order
 */
export function parseLovdataDocument(html) {
  // Lovdata writes empty elements as <td />. Without recognizeSelfClosing the HTML parser
  // would read that as an opening tag and swallow what follows.
  const doc = parseDocument(html, { decodeEntities: true, recognizeSelfClosing: true });
  const meta = parseHeader(doc);
  const body = find(doc, (n) => hasClass(n, "documentBody"));
  if (!meta.refid || !meta.title || !body) {
    throw new Error("Not a Lovdata document: missing refid, title or documentBody");
  }

  const parts = [];
  const visit = (node) => {
    if (node.type !== "tag" || isNotLawText(node)) return; // notes are not parts of the document
    if (isArticle(node)) {
      parts.push(parseArticle(node, meta.dokid));
    } else if (isSection(node) || node === body) {
      const outside = parseOutside(node, meta.dokid, meta.title);
      if (outside) parts.push(outside);
    }
    for (const child of node.children) visit(child);
  };
  visit(body);
  parts.forEach((part, ord) => (part.ord = ord));
  return { meta, parts };
}
