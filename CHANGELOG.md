# Changelog

## 2026-10-22

### Cloudflare Worker
- Acces privat: `/mcp` și `/cauta` cer un token din secretul `ACCESS_TOKEN` (Bearer, `X-Api-Key` sau `?key=`); fără secret, Worker-ul răspunde `503`. `PUBLIC_ACCESS=true` deschide explicit o instanță publică.
- Protocol MCP: `ping`, notificări → `202`, JSON invalid → `-32700`, erori pentru unealtă/metodă necunoscută, `405` la `GET /mcp`, instrucțiuni de server la `initialize`.
- `wrangler.jsonc` pentru Workers Builds din GitHub.

### Parser și date (Worker + `server.py`)
- Parser structural al paginilor consolidate: un articol = un `.S_ART`; alineatele/literele pe linii separate; notele (modificări `(la …)` și `Notă` CCR/RIL/HP) ca listă separată de textul legii.
- Corectate 9 din 22 de `doc_id`-uri din aliasuri care indicau alt act (ex: „Codul de procedură civilă” deschidea Codul de procedură penală).
- Legile care aprobă/republică un Cod (ex: Legea 53/2003) conțin doar o trimitere `.S_REF`; aceasta este urmată automat.

### Căutare (Worker + `server.py`)
- Număr de act fără an (ex: „HG 859”): nu se mai alege cel mai vechi act; cuvintele-cheie restrâng căutarea, altfel răspunsul este `ambiguu` și se cere anul.
- Căutarea după cuvinte-cheie ordonează articolele după relevanță (rădăcini românești, potrivire la început de cuvânt, ponderare IDF) și spune explicit când nimic nu se potrivește.
- Răspunsurile includ `cuprins_articole` (acte de până la 80 de articole) și `instructiuni_model` (nu completa din memorie).
- `art. 11 alin. (2) lit. c)` cere articolul 11 (alineatele/literele nu mai sunt interpretate ca articole).
- `server.py`: cache v2 (note JSON, coloană `source`), `exploreaza_cuprinsul_actului` construit din forma consolidată (funcționa greșit pentru Coduri), căutarea în act folosește forma consolidată.

### Cache în Worker
- Două niveluri fără configurare: memoria izolatului (LRU) și Cache API (per centru de date, 24h pentru acte, 12h pentru căutări). Antetul `X-Legis-Cache` arată sursa (`memorie` / `cache-api` / `sursa`). Codul administrativ: ~200 ms la prima cerere, ~7 ms din Cache API.

### Corecturi găsite la verificarea referințelor
- Articolele de peste 999 („Articolul 1.270”) erau numerotate „1”: 1001 articole din Codul civil și 136 din CPC erau inaccesibile.
- Eșecul descărcării formei consolidate era ignorat, iar căutarea de rezervă „Articolul X” putea întoarce articolul unui alt act (API-ul ignoră anul când se caută și text). Acum se acceptă doar același număr, an și tip, iar eșecurile apar în `avertisment`.
- Alias nou cu `doc_id` pentru Codul amenajării teritoriului, urbanismului și construcțiilor (Legea 169/2026, document 314302).

### Skill (`skills/`)
- `SKILL.md`: ambele variante de conector (local și remote), cum se interpretează `ambiguu`, lipsa potrivirilor, `cuprins_articole`, `articole_negasite`, `avertisment`; verificarea fiecărei afirmații concrete în textul returnat.
- `references/DOMENII_SI_LEGI.md`: toate articolele citate au fost verificate pe textul consolidat; corectate trimiterile greșite (Cod adm. art. 356 → 358/360, art. 109 eliminat, art. 536 reformulat; Legea 119/1996 art. 41 → 43 lit. i); OUG 84/2001 → OG 84/2001; Legea dialogului social art. 211 inexistent → Codul muncii art. 269; Legea 554/2004 art. 11 alin. (2) curge de la comunicare, nu de la emitere) și adăugat un vocabular „limbaj uzual → termenii legii” pentru căutări.
