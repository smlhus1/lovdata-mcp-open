# lovdata-mcp

MCP-server som gir Claude ordrett lovtekst fra gjeldende norske lover og sentrale forskrifter. Teksten hentes rett fra
Lovdatas åpne data (`api.lovdata.no`), uten tredjepart imellom.

## Hva den gjør

| Verktøy | Gir deg |
|---|---|
| `hent_paragraf` | En paragraf ordrett, med dokumentets navn, ID, lenke til lovdata.no og datoen teksten er fra. Uten paragraf: listen over paragrafer i dokumentet. |
| `sok` | Fritekstsøk på tvers av lover og forskrifter. Alle ordene må stå i samme paragraf. `"frase"` og `oppsig*` virker. |
| `henvisninger` | Hvilke andre bestemmelser som viser til en paragraf, slik Lovdata har lenket dem: unntak, straffebestemmelser, forskrifter som bygger på den. |
| `historikk` | Hva en paragraf sa før den ble endret, ordrett. Går bare tilbake til da installasjonen begynte å ta vare på teksten. |
| `kommende_endringer` | Alt som er vedtatt, men ikke i kraft: én oppføring per endringslov, med tidspunktet ordrett fra Lovdatas note, rettsområde, EU/EØS-henvisning og hvilke dokumenter som berøres. |

Hvert svar oppgir Lovdata som kilde, lisensen (NLOD 2.0) og tekstdatoen.

## Følge med på paragrafene du bygger på

`pins.json` lister paragrafene arbeidet ditt hviler på, med hvorfor, tekstdato og SHA-256 av teksten slik den var da
du festet dem. Fila er tom i repoet. Sett `LOVDATA_MCP_PINS` for å ha den et annet sted. Hver gang serveren har hentet en ny pakke, sammenlignes de. Avvik gir én melding, og samme avvik
meldes ikke igjen neste natt.

```bash
npm run pins                                          # sjekk nå; exit-kode 1 ved avvik
npm run pins -- add "ekomloven" "§ 2-10" "112-plikten"
npm run pins -- accept                                # ny tekst er lest og godtatt; fest på nytt
```

Tre slags avvik: teksten er endret, varselet om en kommende endring er nytt eller endret, eller paragrafen finnes ikke
lenger. Avviket skrives til stderr. Vil du ha det et annet sted, la `LOVDATA_MCP_MELD` peke på en egen modul som
eksporterer `nyId`, `adresse`, `valider` og `skriv` (se `notifyPinChanges` i `src/pins.mjs`), og sett mottakeren
med `LOVDATA_MCP_MELD_TIL`.

## Historikk

Lovdata gir bare gjeldende tekst. Når en ny pakke kommer, sammenlignes den med den forrige, og den gamle ordlyden til
hver paragraf som er endret, lagres i `history.db` i datamappa. Historikken starter derfor den dagen installasjonen
først så en ny pakke, og hver maskin har sin egen. Datoene er pakkedatoer, ikke ikrafttredelse. Dagen skjemaet i
indeksen endres (ny versjon av serveren), sammenlignes ikke, fordi forskjellen da kan komme fra parseren.

## Radar: hva som kommer

```bash
npm run radar                          # alt som er vedtatt, men ikke i kraft
npm run radar -- arbeidsrett           # bare det som treffer et rettsområde, en lov eller et direktivnummer
npm run radar -- bokføring --detaljer  # med paragrafene som berøres
```

Lista bygger på Lovdatas noter på paragrafene som skal endres («Endres ved lov … (i kraft 1 jan 2027)»), gruppert per
endringslov. Tre ting å vite:

- En ny lov som ikke endrer noen gjeldende paragraf, vises ikke.
- Tidspunktet er Lovdatas formulering, ikke en utregnet dato. Endringsloven selv har ofte en mer presis note om hvilke
  deler som trer i kraft når. Les den før du bygger på datoen.
- Lista sier at noe endres, ikke hva plikten blir. Det står i endringsloven.

## Installere

Krever Node 22.13 eller nyere og `tar` med bzip2 (følger med macOS og Windows 10/11).

```bash
git clone https://github.com/smlhus1/lovdata-mcp-open.git lovdata-mcp && cd lovdata-mcp
npm ci
npm run update   # laster ned og indekserer, ett til to minutter
claude mcp add --scope user lovdata -- node "$(pwd)/src/server.mjs"
```

Dataene legges i `~/.lovdata-mcp` (ca. 200 MB). Sett `LOVDATA_MCP_DATA` for å bruke en annen mappe.

## Hvor fersk teksten er

Lovdata legger ut nye pakker hver natt rundt 02:30 UTC. Serveren spør Lovdata om pakkedatoen ved oppstart og deretter
høyst hver sjette time. Er pakken ny, lastes den ned og indeksen bygges på nytt. `Tekstdato` i svaret er Lovdatas egen
dato på pakken teksten kom fra.

Når Lovdata ikke svarer, eller en ny pakke ikke lar seg indeksere, brukes den forrige kopien. Svaret sier da fra med
en advarsel, og neste forsøk kommer etter et kvarter.

## Hva «ordrett» betyr her

Lovteksten gjengis tegn for tegn. Det som tilpasses, er oppsettet: hvert ledd og hvert listepunkt står på egen linje,
listepunkter får bokstaven eller tallet sitt foran (`a. når arbeidet er …`), og tabellceller skilles med tabulator.

Fire ting er annerledes enn om du kopierer fra lovdata.no:

- **Lovdatas endringsnoter og fotnoter** vises under teksten, merket som Lovdatas tilføyelser.
- **Fotnotetegn** (det hevede tallet på lovdata.no) tas ikke med i teksten. Fotnoten står blant notene.
- **Hevede og senkede tall** skrives med egne tegn (m², 10⁻⁶, CO₂). Kopierer du fra nettsiden, får du «m2» og «10-6».
- **Bilder og formler som er bilder** vises som `[bilde: beskrivelse]`. Se dem på lovdata.no.

## Det svaret gir i tillegg til teksten

- **Varslet endring som ikke er i kraft.** Når Lovdatas note sier «Endres ved lov … (i kraft 1 jan 2027)», løftes
  den setningen fram ordrett, sammen med hvilken endringslov den nye ordlyden står i. Teksten som vises, er alltid
  den som gjelder nå. Ordlyden i endringsloven hentes som et vanlig dokument.
- **Forskrifter med hjemmel i paragrafen**, og for en forskrift: hvilke lovparagrafer den er gitt med hjemmel i.
  Dette er Lovdatas egen registrering på hver forskrift, og den er ikke nødvendigvis fullstendig.
- **Lovdatas endringsnote for paragrafen.** Den forteller når paragrafen sist ble endret. Datoen nederst i svaret
  gjelder hele dokumentet. Serveren regner ikke ut en egen «sist endret»-dato per paragraf, fordi eldre endringer
  står uten lenke i notene, og en utledet dato ville sett sikrere ut enn den er.

Tekst som står utenfor paragrafene (vedlegg, fortaler, gjengitte EU-forordninger) er også med. Den hentes med navnet
som står i innholdslisten og i søketreffene, for eksempel `paragraf: "KAPITTEL_7-1-1"`. Deler over 60 000 tegn
forkortes, med beskjed om det og lenke til resten.

## Hva som er med

De to pakkene `gjeldende-lover` og `gjeldende-sentrale-forskrifter`. Ikke med: lokale forskrifter, Lovtidend,
opphevede lover, forarbeider og rettsavgjørelser.

## Tester

```bash
npm test
```

- `test/published.test.mjs` sammenligner arbeidsmiljøloven § 14-9, ehandelsloven § 9 og GDPR artikkel 6 med det
  lovdata.no viste 22.11.2026. Fasiten i `test/published/` er nettleserens tekst fra siden, og SHA-256 i testen ble regnet ut i
  nettleseren, så filene er bevist like det som sto publisert. lovdata.no tillater ikke automatisk henting
  (`robots.txt`), derfor er fasiten lagret og ikke hentet av testene.
- `LOVDATA_TEST_CORRUPT=1 npm test` kjører samme sammenligning mot en kopi der ett tegn er fjernet. Den skal feile.
- `test/update.test.mjs` kjører nedlasting og oppdatering mot en lokal etterligning av Lovdatas API.
- `test/server.test.mjs` snakker med serveren over stdio som en ekte MCP-klient.

Ny fasit lages ved å åpne paragrafen på lovdata.no i en nettleser og lagre `innerText` av elementet
`#PARAGRAF_<nummer>`.

## Ikke juridisk rådgivning

Verktøyet gjengir lovtekst. Det tolker den ikke, og det erstatter ikke en jurist. Prosjektet er ikke tilknyttet
Stiftelsen Lovdata.

## Lisens

Koden er lisensiert under MIT, se `LICENSE`. Lovtekstene har egen lisens, se under.

## Kilde og lisens for dataene

Lovtekstene kommer fra Stiftelsen Lovdata, `https://api.lovdata.no`, og er lisensiert under
[Norsk lisens for offentlige data (NLOD) 2.0](https://data.norge.no/nlod/no/2.0). Lisensen krever at Lovdata oppgis
som kilde. Det gjør serveren i hvert svar, og det må du også gjøre når du gjengir teksten videre.

Det samme gjelder filene i `test/fixtures/` og `test/published/`: de er lovtekst fra Lovdata, ikke en del av koden.
