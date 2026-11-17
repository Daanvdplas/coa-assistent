# Publieke demo: voorbereiden, controleren en stoppen

Status: deploymentvoorbereiding, **geen gepubliceerde dienst**. Publiceer pas na akkoord op de exacte release, de openbare URL, de afzonderlijke projectsleutel en het totale kostenplafond. Alleen fictieve gegevens. Een ander team beheert de demo-interface; neem hun goedgekeurde wijzigingen mee vóór de laatste releasebouw.

De eigenaar koos een grens van $100. Een providerinstelling is niet beschikbaar; de demo gebruikt daarom de lokale policy 2: vóór iedere modelpoging telt de officiële gratis input-tokenroute de exacte invoer, maximaal 300.000 tokens, met maximaal 4096 outputtokens en vijftig expliciet goedgekeurde pogingen. Onder de op 17 november 2026 gecontroleerde Sol/Standard/30m-prijzen is dat maximaal $78,072 API-gebruik; één totale planningsmarge van 20% komt op $93,6864. Dit is geen accountbrede facturatiegarantie voor andere sleutelgebruikers, gewijzigde prijzen of onjuiste operatorconfiguratie. Wijzig model, prijstier, cacheduur of tokenplafond niet zonder herberekening. Zet geen sleutel of echt bewonersgegeven in deze repository, opdrachten, issues of logs.

## Bestaande host en ontbrekende voorwaarden

Read-only gecontroleerd op 16 november 2026: bestaande Hetzner-VPS met Ubuntu 24.04, x86_64, twee vCPU, ongeveer 3 GiB beschikbaar RAM, geen swap en 45 GiB vrije schijf. `coa-demo` bestaat met `/var/lib/coa-demo` (`700`); `/opt/coa-demo` is leeg en root-owned. Er was nog geen COA-service, Caddy of openbare HTTPS-route. SSH, de private Tailscale-route en de private nieuwsdemo blijven ongemoeid.

De eigenaar heeft op 17 november geen voorkeur voor een domeinnaam uitgesproken. De kleinste voorgestelde route is daarom HTTPS op het bestaande publieke IP-adres, zonder domeinaankoop of gratis DNS-afhankelijkheid. Caddy gebruikt expliciet Let's Encrypt ACME met profiel `shortlived`, niet een alleen lokaal vertrouwd IP-certificaat. De configuratietest controleert de publieke issuer en het profiel zonder een certificaat aan te vragen.

De openbare poorten waren bij de concrete proef onbereikbaar, ook met werkende lokale Caddy-listeners. Hetzner-beheer en Funnel-ownerautorisatie waren niet beschikbaar. Verander geen algemene firewallregels of bestaande private Tailscale-publicatie. Een accountloze tijdelijke tunnel is hieronder als proefroute beschreven; publicatie van de app begint pas na de controles en vrijgave.

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
3. Initialiseer één keer als `coa-demo`: `meedoen-retrieval demo-budget init /var/lib/coa-demo/budget/attempts-v2.json --max-attempts GOEDGEKEURD_AANTAL`. De placeholder is bewust ongeldig; de operationele startkeuze is vijftig onder de hierboven vastgelegde policy. Het commando moet een bestaand bestand weigeren. Het budget hoort buiten de releasemappen en blijft bij herstart en rollback behouden.

Verwijder of herschrijf het budgetbestand nooit om een fout op te lossen. Ontbrekende, ongeldige of ontoegankelijke state moet nieuwe providerpogingen tegenhouden. De serviceunit initialiseert niets en heeft geen standaardcap. Lokale per-netwerklimieten blijven aanvullend; die tellers staan alleen in RAM.

Op de private voorbereidingsversie bestond eerder schema 1 met vijftien pogingen, waarvan nul gebruikt. Alleen voor die expliciet vastgestelde nulstand is een eenmalige overgang toegestaan: stop de service, controleer en bewaar het oorspronkelijke bestand ongewijzigd als auditbewijs, onttrek het aan de servicegebruiker (`root:root`, `0400`) en maak met de nieuwe binary een **nieuw** schema-2-bestand op het v2-pad. Verander nooit het oude maximum of de teller. Bij enig verbruik: stop en laat het gezamenlijke resterende budget opnieuw goedkeuren. De nieuwe unit wijst naar v2; oudere binaries weigeren schema 2. Rol niet terug naar een oude unit plus het eerder ongebruikte v1-budget: dat zou een tweede onafhankelijk startbudget openen.

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

## Tijdelijke accountloze HTTPS-proefroute

Cloudflare Quick Tunnels is een tijdelijke uitwijkroute wanneer de eigenaar geen firewall- of Funnel-ownerbeheer kan afronden. Gebruik uitsluitend de gepinde `cloudflared` **2026.11.0** (12 november 2026), Linux-amd64-SHA256 `51f7c68b57ed7269164075d7e789efce5b59355982f06392deeb037d982a51fd`. Plaats de binary root-owned als `/opt/coa-demo/tools/cloudflared-2026.11.0`. Er is geen Cloudflare-account, domeinaankoop of API-key voor deze proef nodig.

Deze route heeft geen SLA, maximaal 200 gelijktijdige HTTP-requests en geen SSE. De demo pollt korte JSON-requests en gebruikt geen publieke SSE-stream. **De willekeurige `trycloudflare.com`-URL verandert bij herstart van het tunnelproces.** Verkoop deze proef niet als permanente LinkedIn-hosting. Een app-/Caddy-herstart mag het tunnelproces niet herstarten; de tunnelunit heeft daarom geen binding aan de applicatieunit. Bij een tunnelherstart moet de eigenaar de nieuwe URL controleren en eventueel de gedeelde link aanpassen.

Maak een afzonderlijke nologin-gebruiker `coa-tunnel` met `/var/lib/coa-tunnel` (`0700`). Installeer `config/coa-demo-tunnel.service` root-owned en controleer de unit met `systemd-analyze verify`. De unit is alleen een uitgaande HTTP/2-tunnel naar Caddy op loopback; metrics luisteren uitsluitend op `127.0.0.1:20242`. Hij heeft geen capabilities, geen OpenAI-keyomgeving en geen toegang tot `/var/lib/coa-demo`. Controleer dat zowel `caddy` als `coa-tunnel` de providersleutel niet kunnen lezen.

Begin uitsluitend met `config/Caddyfile.quick-tunnel` als `/etc/caddy/Caddyfile`: loopback `9899`, automatische TLS en admin-API uit, geen app-proxy, elke route geeft onderhoudsstatus 503/no-store. Caddy en de tunnel krijgen geen OpenAI-sleutel. De tunnel zelf verzorgt publiek vertrouwde HTTPS. Controleer van buiten de server normale TLS zonder `-k`, de onderhoudstekst en 503 op zowel `/` als `POST /api/runs`; de providerledger moet ongewijzigd blijven. De aparte appconfig staat alleen klaar in `config/Caddyfile.quick-tunnel.app` en is **niet** de onderhoudsconfig.

De appvariant behoudt de publieke routeallowlist en weigert lokale workers/adminroutes. Hij overschrijft `X-Real-IP` met het door de Cloudflare-edge aangeleverde `CF-Connecting-IP`, alleen via de eigen lokale tunnel. Verifieer met een tijdelijk geïsoleerd nepbackend dat publiek vervalste `CF-Connecting-IP`, `X-Real-IP` en `X-Forwarded-For` niet als bezoekersadres aankomen. Zonder dit bewijs: geen header vertrouwen; gebruik een conservatieve gedeelde teller. De resultatenpagina moet bovendien publiek alleen-lezen zijn; startknoppen mogen niet naar een geweigerde worker leiden.

Cloudflare termineert de publieke TLS-verbinding en kan het verkeer verwerken. De korte uitleg bij de definitieve publieke app moet daarom zowel Cloudflare als OpenAI noemen en persoonsgegevens uitsluiten; dit is een UI-handoff, geen wijziging die de netwerkconfig zelfstandig afhandelt. Tot privacy-, budget-, UI- en vrijgavevoorwaarden rond zijn, blijft uitsluitend de onderhoudsconfig actief.

Leg vóór de wijziging `tailscale serve status --json` en de PIDs/starttijden van de bestaande private diensten vast. Vergelijk die na afloop exact. Gebruik geen `tailscale serve reset`, Funnel op de bestaande private poort 8443 of een andere brede policywijziging. Stop deze uitwijkroute met `systemctl stop coa-demo-tunnel.service`; er is geen gekoppelde appstop of quotareset nodig. Bewaar de oorspronkelijke IP-Caddyconfig afzonderlijk zodat later een gecontroleerde permanente route mogelijk blijft.

## Vrijgave van exact deze versie

Vóór een LinkedIn-link controleren twee rollen de gebouwde release en de werkelijke publieke route:

1. HTTPS is zonder certificaatwaarschuwing bereikbaar buiten Tailscale; HTTP verwijst naar HTTPS. De goedgekeurde commit en frontendassets komen overeen met het pakket.
2. Bronnen, taalkeuze, mobiel, één open activiteit en opgeslagen rapporten werken. Bij het vraagveld staat dat dit een onafhankelijk fictief prototype is, dat vragen extern worden verwerkt en dat geen persoonsgegevens mogen worden ingevuld.
3. Eén vooraf begrensde echte fictieve vraag werkt met echte bronnen. Betaalde controles beginnen pas met expliciete toestemming en tellen binnen dezelfde budgetgrens; oude rookproeven zijn geen facturatiebewijs.
4. Twee bezoekers krijgen gescheiden sessies. Proxy-IP-overschrijving, 429/`Retry-After`, volle capaciteit en ongeoorloofde routes worden gecontroleerd zonder extra onbeperkte modelcalls.
5. Herstart behoudt pogingenteller en cap; parallelle vragen kunnen geen quota overschrijden. Stoppen blokkeert nieuwe providerpogingen. Een plaatselijke time-out of stop garandeert niet dat al verstuurd providerwerk geen kosten meer maakt.

Zonder dit bewijs, aantoonbare lokale budgetpolicy of sleuteltoegang: geen publicatie. De workflow is uitsluitend voorbereiding en vervangt dit akkoord niet. Een gewone configuratie-/correctheidsreview is geen vervanging voor een niet voltooide afzonderlijk gevraagde securityaudit.

## Stoppen, einddatum en rollback

Leg bij vrijgave een eigenaar en stopdatum vast. Stop direct met `systemctl stop coa-demo.service` bij onverwachte kosten, misbruik, foutieve bron-/privacyweergave of onbekende budgetstate. Controleer dat er geen nieuw providerverkeer kan starten; behoud de ledger voor controle. Houd SSH, Tailscale en de private nieuwsdemo aan.

Voor onderhoud kan de openbare proxy een korte 503-melding geven. Voor rollback: stop de COA-service, kies uitsluitend een eerder onafhankelijk gecontroleerde **policy-2-release met input-tokencontrole**, wijzig `current`, controleer checksums en start met hetzelfde v2-budget. Een oudere versie met alleen een pogingenteller is voor de nieuwe vijftigpogingencap onvoldoende; dan blijft de dienst uit. Wissel geen hostbreed Caddybestand uit dat ondertussen andere diensten bevat zonder hun configuratie te behouden.

## Bronnen en actualiteit

- [Caddy 2.11.9](https://github.com/caddyserver/caddy/releases/tag/v2.11.9), gepubliceerd **5 november 2026**.
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), bijgewerkt **30 september 2026**: accountloos, tijdelijke URL, geen SLA/SSE en maximaal 200 gelijktijdige requests.
- [cloudflared 2026.11.0](https://github.com/cloudflare/cloudflared/releases/tag/2026.11.0), gepubliceerd **12 november 2026**; de release publiceert de hierboven vastgelegde SHA-256.
- [Let's Encrypt: IP- en zesdaagse certificaten](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability), gepubliceerd **15 januari 2026**, bijgewerkt **11 maart 2026**.
- [Let's Encrypt-profielen](https://letsencrypt.org/docs/profiles/), bijgewerkt **4 oktober 2026**: `shortlived` ondersteunt IP-adressen en geeft certificaten van 160 uur; automatische vernieuwing is noodzakelijk.
- [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https), aantoonbaar bijgewerkt **6 maart 2026** ([broncommit](https://github.com/caddyserver/website/commit/9a26b56e3b36ea4dea362b504ad19101fdf11461)).
- [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), bijgewerkt **8 november 2026** ([broncommit](https://github.com/caddyserver/website/commit/e71548f6f16ebbae678062968158ca788069ef06)).

Deze bronnen onderbouwen het proxymechanisme; de concrete URL, certificaatuitgifte, provideraccount en hostcapaciteit moeten bij ingebruikname worden gecontroleerd.
