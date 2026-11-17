# Publieke demo: voorbereiden, controleren en stoppen

Status: deploymentvoorbereiding, **geen gepubliceerde dienst**. Publiceer pas na akkoord op de exacte release, de openbare URL, de afzonderlijke projectsleutel en het totale kostenplafond. Alleen fictieve gegevens. Een ander team beheert de demo-interface; neem hun goedgekeurde wijzigingen mee vóór de laatste releasebouw.

De grens van $100 is door de eigenaar genoemd. Dit stelt geen providerlimiet in en bepaalt niet vanzelf een aantal API-pogingen. Kies de expliciet goedgekeurde providerinstelling en conservatieve pogingencap vóór initialisatie. Zet geen sleutel of echt bewonersgegeven in deze repository, opdrachten, issues of logs.

## Bestaande host en ontbrekende voorwaarden

Read-only gecontroleerd op 16 november 2026: bestaande Hetzner-VPS met Ubuntu 24.04, x86_64, twee vCPU, ongeveer 3 GiB beschikbaar RAM, geen swap en 45 GiB vrije schijf. `coa-demo` bestaat met `/var/lib/coa-demo` (`700`); `/opt/coa-demo` is leeg en root-owned. Er was nog geen COA-service, Caddy of openbare HTTPS-route. SSH, de private Tailscale-route en de private nieuwsdemo blijven ongemoeid.

De eigenaar heeft op 17 november geen voorkeur voor een domeinnaam uitgesproken. De kleinste voorgestelde route is daarom HTTPS op het bestaande publieke IP-adres, zonder domeinaankoop of gratis DNS-afhankelijkheid. Caddy gebruikt expliciet Let's Encrypt ACME met profiel `shortlived`, niet een alleen lokaal vertrouwd IP-certificaat. De configuratietest controleert de publieke issuer en het profiel zonder een certificaat aan te vragen.

Nog vast te stellen: werkelijke IP-certificaatuitgifte en bereikbaarheid van 80/443 door de Hetzner-cloudfirewall, de afzonderlijke projectsleutel en aantoonbare providerbudgetinstelling. Verander geen algemene firewallregels of bestaande Tailscale-publicatie om deze demo online te krijgen. Publicatie begint pas na de hieronder beschreven controle en vrijgave.

## Eén gepind Linux-pakket

De workflow **Public demo release candidate** bouwt op Ubuntu 24.04 met Rust 1.97.1 en `Cargo.lock`. Hij publiceert alleen een downloadbaar reviewartefact; hij heeft geen server-/providercredentials en deployt niets. Start hem op de goedgekeurde branch via GitHub Actions. Controleer daarna dat de werkelijk gebouwde commit exact de goedgekeurde release is.

Het pakket bevat:

- `bin/meedoen-retrieval`: Linux x86_64-release; geen Mac-binary.
- `lib/`: eventuele niet door Ubuntu geleverde runtimebibliotheken uit `ldd`.
- `release.json` en `SHA256SUMS`: broncommit, toolchain, lockfilehash en bestandschecksums.
- `config/`: de Caddy- en systemd-configuratie; `DEPLOYMENT.md`: deze werkwijze.

De bronnen, interface en beperkte opgeslagen rapporten zijn in de binary ingebed. Node, npm, Codex, Git, persoonlijke caches en de volledige checkout hoeven niet op de productieservice. Ubuntu levert de systeembibliotheken uit het manifest; controleer `ldd` op de host. De workflow test de proxy, checksums, Linux-CLI, systemd-parser en echte MiniLM-warmup met een onbruikbare testsleutel zonder antwoordcalls. Hij weigert een binary die geen verplicht budget heeft. Dit bewijst nog geen capaciteit op de VPS.

Download het artefact van de gecontroleerde workflowrun. Controleer de buitenste `.sha256`, pak uit in een nieuwe map en voer daarin `sha256sum --check SHA256SUMS` uit. Bewaar de broncommit en GitHub-run bij de vrijgave. Installeer de uitgepakte inhoud root-owned in `/opt/coa-demo/releases/GOEDGEKEURDE_COMMIT`; maak `current` pas bij ingebruikname een verwijzing naar die gecontroleerde map. Overschrijf geen actieve release.

## Private state en sleutel

Deze handelingen zijn voor de operator **na goedkeuring**, geen onderdeel van starten of herstarten:

1. Maak `/var/lib/coa-demo/budget` met eigenaar `coa-demo:coa-demo` en mode `700`.
2. Plaats de afzonderlijke projectsleutel als regulier bestand `/var/lib/coa-demo/openai-api-key`, eigenaar `coa-demo`, mode `600`, zonder symlink/hardlink. Gebruik geen persoonlijke Codex-aanmelding en geen sleutelwaarde in argumenten of environmentbestanden.
3. Initialiseer één keer als `coa-demo`: `meedoen-retrieval demo-budget init /var/lib/coa-demo/budget/attempts.json --max-attempts GOEDGEKEURD_AANTAL`. De placeholder is bewust ongeldig. Het commando moet een bestaand bestand weigeren. Het budget hoort buiten de releasemappen en blijft bij herstart en rollback behouden.

Verwijder of herschrijf het budgetbestand nooit om een fout op te lossen. Ontbrekende, ongeldige of ontoegankelijke state moet nieuwe providerpogingen tegenhouden. De serviceunit initialiseert niets en heeft geen standaardcap. Lokale per-netwerklimieten blijven aanvullend; die tellers staan alleen in RAM.

## Service en modelwarmup achter gesloten toegang

Installeer `config/coa-demo.service` als `/etc/systemd/system/coa-demo.service`. De unit draait als `coa-demo`, met readonly code, private tijdelijke bestanden, verborgen persoonlijke homedirectories en alleen schrijfrecht onder `/var/lib/coa-demo`. De sleutel en het budgetpad zijn vast; de applicatie luistert uitsluitend op `127.0.0.1:8766`.

`MemoryMax=1536M` is een voorlopige grens, geen gemeten capaciteit. Warm MiniLM op vanuit de servicewerkmap, zodat alleen de benodigde `.model-cache` onder `/var/lib/coa-demo` wordt gemaakt. Download geen persoonlijke cachecollectie. De huidige MiniLM-download is ongeveer 235 MB; startup maakt embeddings voor 72 fictieve bronsecties, met twee CPU-threads. De antwoorden worden extern gegenereerd, niet op de VPS.

Na `systemctl daemon-reload` en `systemctl start coa-demo.service` mag toegang nog alleen via SSH/een private verbinding. Controleer:

- `ldd` met `LD_LIBRARY_PATH=/opt/coa-demo/current/lib`: geen ontbrekende bibliotheek.
- `/api/source`: twaalf bronnen, juiste referentiedatum, de bedoelde echte providerconfiguratie en `runtime_ready=true`; geen mockroute.
- Modelwarmup en `MemoryCurrent`/`MemoryPeak` in systemd; geen OOM of herstartlus. Bij onvoldoende ruimte blijft publicatie uit.
- Sleutel/state-eigenaar, `700`/`600`, en weigering als het budget ontbreekt of beschadigd is.

Schrijf alleen foutstatussen en beperkte operationele informatie naar de journal. Zet geen body-, autorisatieheader-, vraag-/antwoord- of sessielogging aan. De meegeleverde Caddyfile activeert geen accesslog en verwijdert het volledige requestobject uit de standaardlogger: ook een upstreamfout mag het `X-Test-Session`-bearertoken niet loggen. Status en foutdiagnostiek blijven behouden. De echte proxytest forceert zo'n fout met een synthetische canary. Externe providerverwerking blijft bestaan; `store:false` is geen belofte van nulretentie.

## HTTPS-proxy en openbare routes

Installeer een gecontroleerde Caddy-versie; de proxytests gebruiken **2.11.9**, gepubliceerd op 5 november 2026. Installeer `config/Caddyfile` als `/etc/caddy/Caddyfile` en `config/caddy-override.conf` als `/etc/systemd/system/caddy.service.d/coa-demo.conf`. Maak `/etc/coa-demo/public.env` root-owned (`600`) op basis van `config/public.env.example`; vul uitsluitend het goedgekeurde publieke IP-adres in, zonder `https://` of pad. Een ontbrekende host maakt de configuratie ongeldig. Er is geen catch-allsite.

Valideer vóór starten met Caddy `adapt`/`validate`, waarbij hetzelfde environmentbestand wordt gelezen. Controleer het vereiste IP-SAN, de publieke certificaatketen en de poortvoorwaarden voor de gekozen URL. Een lokaal vertrouwd certificaat of `curl -k` geldt niet als bewijs. De IP-certificaten zijn kort geldig: controleer vervaldatum en automatische vernieuwing; leg een dagelijkse controle bij de demo-eigenaar. Caddy bewaart zijn certificaatstate op zijn eigen persistente pad, niet in een releasemap. Open geen app-poort rechtstreeks naar internet.

De proxy overschrijft `X-Real-IP` met het werkelijke verbindingsadres; de app vertrouwt exact `127.0.0.1`. Gebruik geen extra CDN/proxy zonder deze identiteit opnieuw te controleren. Een bezoeker mag zijn teller niet beïnvloeden met zelf meegezonden `X-Real-IP` of `X-Forwarded-For`.

Publiek toegestaan: de demo, technische uitleg, statische assets/rapporten, bronnen, sessies aanmaken/lezen, vragen starten en de eigen uitvoering ophalen. Alleen `GET`/`HEAD` op leesroutes en `POST` op `/api/session` en `/api/runs`. Andere routes geven 404 vóór de app.

Niet publiek: lokale zoektestworkers, replay, beoordelingen, criteria, diagnose, testvragen en verslagexport. De resultatenpagina moet daarom openbare bezoekers duidelijk alleen opgeslagen uitkomsten laten bekijken; lokale startknoppen zijn geen ondersteunde openbare flow. Stem die presentatie af met de UI-eigenaar; verruim de proxy niet om lokale workers openbaar te maken.

## Vrijgave van exact deze versie

Vóór een LinkedIn-link controleren twee rollen de gebouwde release en de werkelijke publieke route:

1. HTTPS is zonder certificaatwaarschuwing bereikbaar buiten Tailscale; HTTP verwijst naar HTTPS. De goedgekeurde commit en frontendassets komen overeen met het pakket.
2. Bronnen, taalkeuze, mobiel, één open activiteit en opgeslagen rapporten werken. Bij het vraagveld staat dat dit een onafhankelijk fictief prototype is, dat vragen extern worden verwerkt en dat geen persoonsgegevens mogen worden ingevuld.
3. Eén vooraf begrensde echte fictieve vraag werkt met echte bronnen. Betaalde controles beginnen pas met expliciete toestemming en tellen binnen dezelfde budgetgrens; oude rookproeven zijn geen facturatiebewijs.
4. Twee bezoekers krijgen gescheiden sessies. Proxy-IP-overschrijving, 429/`Retry-After`, volle capaciteit en ongeoorloofde routes worden gecontroleerd zonder extra onbeperkte modelcalls.
5. Herstart behoudt pogingenteller en cap; parallelle vragen kunnen geen quota overschrijden. Stoppen blokkeert nieuwe providerpogingen. Een plaatselijke time-out of stop garandeert niet dat al verstuurd providerwerk geen kosten meer maakt.

Zonder dit bewijs, aantoonbare budgetkeuzes of sleuteltoegang: geen publicatie. De workflow is uitsluitend voorbereiding en vervangt dit akkoord niet.

## Stoppen, einddatum en rollback

Leg bij vrijgave een eigenaar en stopdatum vast. Stop direct met `systemctl stop coa-demo.service` bij onverwachte kosten, misbruik, foutieve bron-/privacyweergave of onbekende budgetstate. Controleer dat er geen nieuw providerverkeer kan starten; behoud de ledger voor controle. Houd SSH, Tailscale en de private nieuwsdemo aan.

Voor onderhoud kan de openbare proxy een korte 503-melding geven. Voor rollback: stop de COA-service, kies uitsluitend een eerder onafhankelijk gecontroleerde **budgetveilige** release, wijzig `current`, controleer checksums en start met dezelfde state. Rol nooit terug naar een oudere versie die geen verplicht budget heeft; dan blijft de dienst uit. Wissel geen hostbreed Caddybestand uit dat ondertussen andere diensten bevat zonder hun configuratie te behouden.

## Bronnen en actualiteit

- [Caddy 2.11.9](https://github.com/caddyserver/caddy/releases/tag/v2.11.9), gepubliceerd **5 november 2026**.
- [Let's Encrypt: IP- en zesdaagse certificaten](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability), gepubliceerd **15 januari 2026**, bijgewerkt **11 maart 2026**.
- [Let's Encrypt-profielen](https://letsencrypt.org/docs/profiles/), bijgewerkt **4 oktober 2026**: `shortlived` ondersteunt IP-adressen en geeft certificaten van 160 uur; automatische vernieuwing is noodzakelijk.
- [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https), aantoonbaar bijgewerkt **6 maart 2026** ([broncommit](https://github.com/caddyserver/website/commit/9a26b56e3b36ea4dea362b504ad19101fdf11461)).
- [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), bijgewerkt **8 november 2026** ([broncommit](https://github.com/caddyserver/website/commit/e71548f6f16ebbae678062968158ca788069ef06)).

Deze bronnen onderbouwen het proxymechanisme; de concrete URL, certificaatuitgifte, provideraccount en hostcapaciteit moeten bij ingebruikname worden gecontroleerd.
