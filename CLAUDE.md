# lovdata-mcp

MCP-server for ordrett oppslag og søk i gjeldende norske lover og sentrale forskrifter, bygget rett på Lovdatas åpne
data uten tredjepart mellom brukeren og lovteksten. Se `README.md` for bruk.

## Løftet

Teksten `hent_paragraf` gir, skal være tegn for tegn lik lovdata.no. Alt annet er underordnet. En endring som kan
påvirke teksten, er ikke ferdig før `test/published.test.mjs` er grønn, og rød med `LOVDATA_TEST_CORRUPT=1`.

## Arkitektur

- `src/parse.mjs`: ett Lovdata-dokument (XML-kompatibel HTML) til metadata og paragrafer. Ren funksjon.
- `src/store.mjs`: nedlasting fra `api.lovdata.no/v1/publicData`, indeks i SQLite med FTS5 (`node:sqlite`), oppslag.
- `src/answers.mjs`: svartekstene til verktøyene, også radaren (`kommende`): alt som er vedtatt, men ikke i kraft.
- `src/server.mjs`: MCP over stdio.
- `src/history.mjs`: gammel ordlyd for paragrafer som er endret, i `history.db` ved siden av indeksen. Skrives i
  `rebuild` før den nye indeksen byttes inn. Slettes `history.db`, er historikken borte for godt.
- `src/pins.mjs` og `pins.json`: paragrafene ditt eget arbeid hviler på. Sjekkes etter hver ny pakke; avvik meldes én gang
  (`pins-notified.json` i datamappa husker hva som er meldt).

Data ligger utenfor repoet, i `~/.lovdata-mcp` (`LOVDATA_MCP_DATA` overstyrer). Indeksen bygges alltid helt på nytt
fra begge pakkene, i en egen `build-`mappe per prosess, og byttes inn med én `rename`. Flere økter kan derfor dele
datamappa. Databasen åpnes og lukkes per forespørsel, fordi en åpen fil ikke kan byttes ut på Windows.

Hvert dokument deles i `parts`: paragrafer (`kind = paragraf`) og tekst utenfor paragrafene, én del per kapittel
(`kind = avsnitt`). Hvert tegn i dokumentet skal havne i nøyaktig én del; det er det en egen test for.

## Ting som er lett å gjøre feil

- **Ikke hent lovdata.no automatisk.** `robots.txt` sier `Disallow: /` for alle. Fasit hentes for hånd i nettleser.
- **Kildene er Lovdatas API-dokumentasjon og pakkene selv.** Ikke bygg på andres Lovdata-klienter.
- **`tar` på Windows kan være Git sin.** Den leser `C:\…` som en nettverksvert og tåler ikke `..` ut av temp-mappa.
  Kall `tar` med `cwd` og relative stier med skråstrek.
- **Grunnloven finnes på bokmål og nynorsk med samme `refid`.** Nynorskfila ender på `-nn.xml` og får ID med `-nn`.
- **`futureLegalArticle` er ikke «kommende versjon av paragrafen».** Det er ny ordlyd sitert inne i en endringslov
  («§ 8 a skal lyde: …») og er endringslovens egen tekst. Varsel om endring som ikke er i kraft, står i paragrafens
  `changesToParent`-note i presens («Endres ved», «Oppheves ved», «Tilføyes ved»), alltid etter det som er skjedd.
- **Utled ikke data som ser ut som lov.** Hjemmel og varslet endring er Lovdatas egne opplysninger, gjengitt og
  merket som det. Frister, beløp, definisjoner og «sist endret» per paragraf regnes ikke ut.
- **Henvisninger er Lovdatas lenker i lovteksten**, ikke noe vi finner selv. Lenker i noter telles ikke, og
  henvisninger til hele loven eller et kapittel er ikke med. Ikke legg til egen gjenkjenning av «§ 5» i tekst.
- **Åpne økter kjører gammel kode.** Etter en skjemaendring bygger en gammel serverprosess indeksen tilbake til sitt
  skjema. Start øktene på nytt etter `git pull`.
- **Innlemmede konvensjoner** (GDPR i personopplysningsloven, EØS-avtalen) har navn som `gdpr/a6`, ikke `§`.
- Endrer du noe som lagres i indeksen, øk `SCHEMA_VERSION` i `store.mjs`, så bygges den på nytt hos alle.

## Kommandoer

```bash
npm test          # alle tester, ingen nettverk
npm run update    # hent nyeste pakker fra Lovdata nå
npm run pins      # sjekk de festede paragrafene (add / accept: se README)
npm run radar     # vedtatt, men ikke i kraft (filter og --detaljer: se README)
```
