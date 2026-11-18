# COA Assistent

COA Assistent helpt een medewerker om samen met een bewoner passende activiteiten te verkennen. Stel een vraag over twaalf verzonnen activiteiten en controleer de bronpassages bij het antwoord.

Dit is een onafhankelijk prototype, geen officieel COA-product. Gebruik alleen fictieve gegevens. Deelname blijft vrijwillig; de demo wijzigt geen dossiers, verstuurt geen berichten en meldt niemand aan.

## Hoe werkt het?

De Rust-app zoekt lokaal met meertalige embeddings of BM25. OpenAI Sol maakt via Rig een antwoord en kan gericht verderzoeken. Je ziet welke passages werkelijk zijn gevonden, met bron en datum. Een antwoord kan onvolledig zijn; de medewerker controleert de bronnen en bespreekt de opties met de bewoner.

## Starten

Vereist: macOS of Linux, Rust 1.97.1 via rustup en een eigen OpenAI API-sleutel met API-tegoed. Node.js en Codex zijn niet nodig voor de website.

Kloon de repository en stel eenmalig je sleutel en een gebruiksgrens in volgens de [lokale setup](docs/LOCAL_SETUP.md#zelf-draaien-met-een-eigen-sleutel). Start daarna vanuit de projectmap:

```sh
env -u OPENAI_API_KEY \
  COA_OPENAI_API_KEY_FILE="$HOME/.config/coa/openai-api-key" \
  COA_DEMO_BUDGET_FILE="$HOME/.config/coa/demo-budget/attempts-v2.json" \
  cargo run --locked
```

Open [COA Assistent](http://127.0.0.1:8766/) of de [opgeslagen evaluaties](http://127.0.0.1:8766/resultaten/). De eerste start bouwt Rust en downloadt het lokale zoekmodel. Houd de terminal open; **Ctrl+C** stopt de server. Herstart met hetzelfde budgetbestand behoudt het verbruik.

De vraag en gevonden passages gaan naar OpenAI. Iedere vraag kan meerdere betaalde modelpogingen gebruiken. Zonder sleutel en budget kun je met `cargo run --locked` de website en bronnen bekijken, maar geen nieuwe antwoorden maken.

Configuratie, controles en grenzen staan in de [uitgebreide lokale setup](docs/LOCAL_SETUP.md). De [codegids](docs/code-tour.html) laat zien hoe de onderdelen samenwerken. Alle evaluaties staan in [evals/](evals/README.md): afzonderlijk voor bronretrieval en de volledige assistent. Bewaarde uitkomsten zijn geen menselijke kwaliteitsvalidatie.
