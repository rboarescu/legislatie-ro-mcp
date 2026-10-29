# Changelog

## 2026-10-29

### Cloudflare Worker: `HTTP 520` de la API-ul SOAP
- Dintr-o sesiune Gemini în cloud, apelurile către `legislatie.just.ro` eșuau cu `HTTP 520`. Cererea venea din SUA, deci Worker-ul rula tot acolo, iar `legislatie.just.ro` refuză conexiunile HTTPS din afara Europei. Sondat din regiunile Cloudflare: Atlanta → 520 pe HTTPS (HTTP merge, dar paginile consolidate redirecționează spre HTTPS); Frankfurt, Bruxelles, București → 200.
- `wrangler.jsonc` fixează Worker-ul în `aws:eu-central-1` (Frankfurt) prin `placement.region`.
- Eroarea pentru `520` (SOAP și pagina consolidată) explică acum cauza și remedierea.

## 2026-10-23

### Eșecuri vizibile la preluarea textului (Worker + `server.py`)
- Test „locuința socială” în Gemini: Legea 114/1996 și Codul administrativ au întors `numar_articole_in_act: 0` fără niciun avertisment, iar modelul a răspuns din memorie (inclusiv un „art. 292^3 introdus prin OUG 91/2023” necitat din nicio sursă).
- Worker: statusul HTTP al paginii consolidate nu era verificat; o pagină de eroare sau de blocare era parsată ca act fără articole. Acum un răspuns non-2xx sau o pagină fără articole și fără trimitere `.S_REF` este eroare, cu statusul și începutul paginii primite în `avertisment`.
- Actele din aliasuri (`doc_id`) nu aveau nici avertisment, nici text de rezervă. Acum, dacă forma consolidată eșuează, se folosește textul din API-ul SOAP (după număr și an), cu avertisment.
- Fără niciun articol (nici consolidat, nici SOAP), răspunsul este `eroare` cu `isError: true` în loc de un act „gol”; modelul primește instrucțiunea să spună că sursa nu e disponibilă, nu să răspundă din memorie.
- Worker, API-ul SOAP: statusul HTTP și `<s:Fault>` nu erau verificate, iar tokenul nu era reînnoit (durata lui de valabilitate nu este documentată). Un token expirat sau o eroare a serviciului apăreau ca „Nu s-au găsit acte”. Acum, la eroare sau rezultat gol cu un token mai vechi de un minut, se reîncearcă o dată cu token nou (ca în `server.py`); dacă serviciul tot nu răspunde, rezultatul este `eroare` cu mesajul serviciului și `isError: true`.
- `server.py`: aceeași rezervă SOAP pentru aliasuri, începutul paginii primite în avertisment, `eroare` + `isError: true` în `extrage_articole_din_act`, `cauta_in_interiorul_actului` și `exploreaza_cuprinsul_actului` când nu există text.

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

### Clasament mai bun (test „locuința socială”, Worker + `server.py`)
- Articolul care răspundea exact (Legea 114/1996 art. 39, un rând) ieșea pe locul 7, după articole lungi care pomeneau des termenii; modelul nu l-a văzut și a inventat un „art. 38”.
- Clasament BM25 normalizat după lungime + bonus pentru termenii care apar împreună în același alineat și pentru denumirea marginală; articolele abrogate coboară. 12/12 cazuri de test (față de 8/12), identic în Python și JS.
- Articolele lungi se întorc ca fragment (titlu + alineatele relevante, `fragment: true`); 6 rezultate în loc de 5; harta actului (`cuprins_articole`) pentru acte de până la 120 de articole.
- Căutarea fără act: fraza exactă, apoi fraze mai scurte; mai multe acte găsite → listă de candidați în loc de ghicit.

### Skill (`skills/`)
- `SKILL.md`: ambele variante de conector (local și remote), cum se interpretează `ambiguu`, lipsa potrivirilor, `cuprins_articole`, `articole_negasite`, `avertisment`; verificarea fiecărei afirmații concrete în textul returnat.
- `references/DOMENII_SI_LEGI.md`: toate articolele citate au fost verificate pe textul consolidat; corectate trimiterile greșite (Cod adm. art. 356 → 358/360, art. 109 eliminat, art. 536 reformulat; Legea 119/1996 art. 41 → 43 lit. i); OUG 84/2001 → OG 84/2001; Legea dialogului social art. 211 inexistent → Codul muncii art. 269; Legea 554/2004 art. 11 alin. (2) curge de la comunicare, nu de la emitere) și adăugat un vocabular „limbaj uzual → termenii legii” pentru căutări.
