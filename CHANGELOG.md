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
