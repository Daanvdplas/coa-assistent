# Gedeelde vraagsets

`datasets/` bevat één canonieke kopie van de vragen en beschermde verwachtingen die zowel het retrieval-lab als de volledige-assistentproeven gebruiken:

| Map | Vraagset | Bronversie |
| --- | --- | --- |
| `legacy/` | P01–P12 en T01–T06 | Vijf activiteiten |
| `independent-20261103/` | IND26-01–IND26-12 | Vijf activiteiten |
| `expanded-10-20261105/` | Tien geselecteerde ontwikkelvragen | Tien activiteiten |
| `strengthened-10-20261106/` | RAG26-01–RAG26-10 | Tien activiteiten |
| `demo-12-20261118/` | Zeventien ontwikkelvragen: tien aangepaste RAG26-vragen, vier nieuwe Schaken/Naaicafé-vragen en drie bestaande browservragen | Huidige twaalf activiteiten, referentiedatum 13 november 2026 |

De vragen, verwachtingen, freezes en onafhankelijk opgestelde AUTHORING-notities zijn bytevast verplaatst. Oude padvelden in de manifesten identificeren de oorspronkelijke bestanden. De loaders vergelijken die historische sleutels en hashes met de huidige canonieke bestanden; de inhoud of herkomst is niet opnieuw gelabeld. Verwachtingen worden alleen voor beoordeling geladen, nooit als modelinstructies of zoekindexinhoud.

De twaalfbronnendemo heeft een eigen expliciete vraagset `demo-12-20261118`. De bronverwachtingen zijn door een andere agent tegen alle twaalf documenten gecontroleerd en vóór de eerste meting vastgelegd. Het zijn ontwikkel- en regressievragen, geen blinde testset of menselijke kwaliteitsijking. Onder meer T02 accepteert nu zowel een volledige fietsoptie als een volledige atelieroptie. Scores uit deze nieuwe versie zijn geen herhaling van de oude vijf- of tienbronnenmeting. De oorspronkelijke vijf tuinvragen hebben alleen de retrievalregressie als eigenaar en staan daarom in `../rag/datasets/garden/`.

Sinds 16 november 2026 gebruikt de ontwikkelvraag `legacy/P06` de bezoekersvraag: “Ik zoek een activiteit die helemaal buiten plaatsvindt en vóór 11.00 uur afgelopen is. Wat past daarbij?” De huidige versie `activities-evaluation-v2-20261116` verwacht bewijs voor buiten en eindtijd 10.30 uur bij Wandelen; de bezoeker hoeft geen activiteiten te kennen of genoemde alternatieven te vergelijken. De oorspronkelijke bevroren `independent-20261103/IND26-10` en opgeslagen meetresultaten blijven ongewijzigd. Nieuwe uitvoeringen krijgen de nieuwe vraag-/verwachtingsidentiteit; oude scores zijn geen meting van deze herziene vraag.

De oorspronkelijke `activities-evaluation-v1`-vragen en criteria staan byte-identiek in `legacy/v1/`. Oude volledige-assistentrapporten herkennen die versie; gebruik voor oude retrievaltraces expliciet `--dataset legacy-v1` bij `lab assess` of `lab report`. De gewone `legacy`-keuze blijft de huidige ontwikkelversie.
