// End to end: a real MCP client talking to the real server process over stdio.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildDataDir } from "./helpers.mjs";

test("the MCP server answers lookups and searches over stdio", async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/server.mjs", import.meta.url))],
      env: { ...process.env, LOVDATA_MCP_DATA: buildDataDir() },
    }),
  );
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["hent_paragraf", "henvisninger", "historikk", "kommende_endringer", "sok"]);

    const paragraph = await client.callTool({ name: "hent_paragraf", arguments: { dokument: "aml", paragraf: "§ 14-9" } });
    assert.equal(paragraph.isError, undefined);
    assert.match(paragraph.content[0].text, /\(1\) Arbeidstaker skal ansettes fast\. Med fast ansettelse menes/);
    assert.match(paragraph.content[0].text, /Tekstdato: /);
    assert.match(paragraph.content[0].text, /NLOD\) 2\.0/);

    const search = await client.callTool({ name: "sok", arguments: { tekst: "elektronisk markedsføring" } });
    assert.match(search.content[0].text, /https:\/\/lovdata\.no\/lov\/2003-05-23-35\/§9/);

    const local = await client.callTool({ name: "sok", arguments: { tekst: "snurrevad", type: "lokal", sted: "Finnmark" } });
    assert.equal(local.isError, undefined);
    assert.match(local.content[0].text, /KUNNGJORT TEKST, IKKE AJOURFØRT/);
    assert.match(local.content[0].text, /FOR-2026-04-10-582/);
    const announced = await client.callTool({ name: "hent_paragraf", arguments: { dokument: "FOR-2026-04-10-582", paragraf: "§ 3" } });
    assert.match(announced.content[0].text, /KUNNGJORT TEKST, IKKE AJOURFØRT/);
    assert.match(announced.content[0].text, /\n§ 3\. Ikrafttredelse\n/);

    for (const invalid of [{ tekst: "x" }, { tekst: "oppsigelse", antall: 500 }, { tekst: "oppsigelse", type: "dom" }]) {
      const result = await client.callTool({ name: "sok", arguments: invalid });
      assert.equal(result.isError, true, JSON.stringify(invalid));
    }
  } finally {
    await client.close();
  }
});
