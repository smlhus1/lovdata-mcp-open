#!/usr/bin/env node
// MCP server (stdio): verbatim lookup and full-text search in current Norwegian
// laws and central regulations, straight from Lovdata's open data.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { hentParagraf, sok, henvisninger, historikk, kommende } from "./answers.mjs";
import { ensureFresh } from "./store.mjs";

const server = new McpServer({ name: "lovdata", version: "0.1.0" });

const answer = (fn) => async (args) => {
  try {
    return { content: [{ type: "text", text: await fn(args) }] };
  } catch (err) {
    console.error(`[lovdata-mcp] ${err.stack ?? err}`);
    return { content: [{ type: "text", text: `Feil: ${err.message}` }], isError: true };
  }
};

server.registerTool(
  "hent_paragraf",
  {
    title: "Hent paragraf ordrett",
    description:
      "Henter en paragraf ordrett fra en gjeldende norsk lov eller sentral forskrift, med dokumentets navn, ID, " +
      "lenke til lovdata.no og datoen teksten er fra. Sier også fra om vedtatte endringer som ikke er i kraft, " +
      "og hvilke forskrifter som har hjemmel i paragrafen. Uten paragraf: viser hvilke paragrafer dokumentet har. " +
      "Bruk dette før du siterer lovtekst. Data hentes direkte fra Lovdata (NLOD 2.0).",
    inputSchema: {
      dokument: z
        .string()
        .min(2)
        .max(300)
        .describe("Navn, korttittel eller ID. Eksempler: «arbeidsmiljøloven», «aml», «LOV-2005-06-17-62», «forskrift/2011-12-06-1357»."),
      paragraf: z.string().max(40).optional().describe("Eksempler: «§ 14-9», «14-12 a», «9»."),
    },
    annotations: { readOnlyHint: true },
  },
  answer(hentParagraf),
);

server.registerTool(
  "sok",
  {
    title: "Søk i lover og forskrifter",
    description:
      "Fritekstsøk på tvers av gjeldende norske lover og sentrale forskrifter. Alle ordene må finnes i samme paragraf. " +
      "«Anførselstegn» gir eksakt frase, og * til slutt i et ord gir trunkering (oppsig*). " +
      "Svarer med paragraf, lenke og et kort utdrag. Data hentes direkte fra Lovdata (NLOD 2.0).",
    inputSchema: {
      tekst: z.string().min(2).max(300).describe("Søkeord eller frase."),
      type: z.enum(["lov", "forskrift"]).optional().describe("Begrens søket til lover eller forskrifter."),
      antall: z.number().int().min(1).max(50).default(10).describe("Antall treff."),
    },
    annotations: { readOnlyHint: true },
  },
  answer(sok),
);

const dokument = z
  .string()
  .min(2)
  .max(300)
  .describe("Navn, korttittel eller ID. Eksempler: «arbeidsmiljøloven», «aml», «LOV-2005-06-17-62».");

server.registerTool(
  "henvisninger",
  {
    title: "Hvem viser til paragrafen",
    description:
      "Viser hvilke andre bestemmelser i gjeldende lover og sentrale forskrifter som viser til en paragraf, " +
      "slik Lovdata har lenket dem. Bruk dette for å finne unntak, straffebestemmelser og forskrifter som bygger " +
      "på paragrafen. Lista er ikke nødvendigvis fullstendig. Data hentes direkte fra Lovdata (NLOD 2.0).",
    inputSchema: {
      dokument,
      paragraf: z.string().min(1).max(40).describe("Eksempler: «§ 14-9», «14-12 a», «artikkel 6»."),
      antall: z.number().int().min(1).max(200).default(50).describe("Antall bestemmelser som vises."),
    },
    annotations: { readOnlyHint: true },
  },
  answer(henvisninger),
);

server.registerTool(
  "historikk",
  {
    title: "Tidligere ordlyd",
    description:
      "Viser hva en paragraf sa før den ble endret, ordrett, og hvilke paragrafer i et dokument som er endret. " +
      "Lovdata gir bare gjeldende tekst, så historikken går bare tilbake til da denne installasjonen begynte å " +
      "ta vare på den. Uten paragraf: liste over endrede paragrafer i dokumentet. Data fra Lovdata (NLOD 2.0).",
    inputSchema: {
      dokument,
      paragraf: z.string().max(40).optional().describe("Eksempler: «§ 14-9», «14-12 a»."),
    },
    annotations: { readOnlyHint: true },
  },
  answer(historikk),
);

server.registerTool(
  "kommende_endringer",
  {
    title: "Vedtatt, men ikke i kraft",
    description:
      "Oversikt over alt som er vedtatt, men ikke trådt i kraft, i gjeldende lover og sentrale forskrifter: én linje " +
      "per endringslov, med tidspunktet ordrett fra Lovdatas note, rettsområde, EU/EØS-henvisning og hvilke dokumenter " +
      "som berøres. Bruk dette for å se hvilke nye plikter og regler som kommer. Les endringsloven med hent_paragraf " +
      "før du påstår hva den innfører. Data hentes direkte fra Lovdata (NLOD 2.0).",
    inputSchema: {
      tekst: z.string().max(100).optional().describe("Begrens til treff i tittel, rettsområde eller berørt dokument. Eksempler: «arbeidsrett», «bokføring», «2021/2167»."),
      detaljer: z.boolean().default(false).describe("Vis hvilke paragrafer som berøres, ikke bare antallet."),
    },
    annotations: { readOnlyHint: true },
  },
  answer(kommende),
);

// Start the update check now, so the first question does not have to wait for a nightly rebuild.
ensureFresh().catch((err) => console.error(`[lovdata-mcp] ${err.message}`));

await server.connect(new StdioServerTransport());
