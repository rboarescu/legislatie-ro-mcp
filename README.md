# legislatie-ro-mcp 🇷🇴⚖️

**Conector MCP (Model Context Protocol) fără dependențe externe** către baza oficială de legislație consolidată a României (**`legislatie.just.ro` — API-ul public `FreeWebService` al Ministerului Justiției**) și legislația Uniunii Europene în limba română (**`EUR-Lex` CELLAR REST API**).

Proiectat pentru a ancora modelele AI (Claude, ChatGPT, Gemini, Cursor, Antigravity, modele locale) în **textul real, actualizat la zi, al legilor, OUG-urilor, HG-urilor, Ordinelor de ministru, RIL-urilor/HP-urilor ÎCCJ și Deciziilor CCR**, eliminând halucinațiile juridice.

---

## 🛡️ Arhitectură „Zero Risc” & Confidențialitate (Stateless Search-Only)

1. **100% API-uri Publice Oficiale:**
   - **România:** Utilizează serviciul web SOAP public pus la dispoziție gratuit de Ministerul Justiției (`http://legislatie.just.ro/apiws/FreeWebService.svc/SOAP`) și paginile publice oficiale cu link direct (`LinkHtml`) către Monitorul Oficial / Portalul Legislativ.
   - **Uniunea Europeană:** Utilizează API-ul oficial deschis al Oficiului pentru Publicații al UE (`https://eur-lex.europa.eu`).
   - **Fără scraping interzis:** Nu interoghează `rejust.ro` și nu ocolește mecanisme de protecție anti-bot / CAPTCHA.
2. **Zero Date Personale (GDPR-Safe):**
   - Serverul MCP **nu primește și nu stochează** documentele utilizatorului. Documentul rămâne în sesiunea locală dintre utilizator și furnizorul său AI, iar MCP-ul primește exclusiv interogări legislative generice (`număr lege`, `număr articol`, `cuvinte-cheie juridice`).
3. **Zero Dependențe Externe (Pure Python 3.10+ Stdlib):**
   - Funcționează direct cu biblioteca standard Python (`urllib.request`, `xml.etree.ElementTree`, `sqlite3`, `html.parser`, `json`), fără a necesita instalarea de pachete terțe vulnerabile.
4. **Smart Cache Local (`SQLite FTS5`):**
   - Salvează local în `~/.cache/legislatie-ro-mcp/cache.sqlite` actele și articolele deja consultate pentru răspuns instantaneu (`<5ms`) și protejarea serverelor Ministerului Justiției (cu *Rate Limiting* politicos).

---

## 🧰 Unelte MCP Expuse (Tools)

| Unealtă MCP | Descriere & Când o folosește AI-ul |
| :--- | :--- |
| **`cauta_acte_normative`** | Caută Legi, OUG, OG, HG, Ordine, **Decizii ÎCCJ (RIL / HP)** și **Decizii CCR** în API-ul oficial `legislatie.just.ro` (după număr, an, titlu, text sau alias uzual precum *Codul Administrativ*, *Codul Muncii*, *Codul Civil*, *Codul Urbanismului*). |
| **`extrage_articole_din_act`** | Extrage textul exact, la zi, al unuia sau mai multor articole (ex: `art. 38-39`, `art. 582`, `art. 11`) dintr-un act normativ, împreună cu **contextul vecin (`±1 articol`)**, **notele de modificare / RIL / HP / CCR** și linkul oficial. |
| **`cauta_in_interiorul_actului`** | Caută după cuvinte-cheie sau instituții juridice (ex: *„domeniu public”*, *„excepția tardivității”*, *„suspendare de drept”*, *„dispoziții tranzitorii”*) direct în textul unui act normativ și returnează articolele relevante. |
| **`exploreaza_cuprinsul_actului`** | Extrage structura pe Titluri, Capitole și Secțiuni a unei legi mari sau a unui Cod (pentru ca AI-ul să localizeze rapid unde sunt reglementate procedurile, sancțiunile sau dispozițiile tranzitorii). |
| **`cauta_legislatie_ue`** | Preia în limba română Regulamente, Directive și decizii CJUE din **EUR-Lex** (după cod `CELEX`, ex: `32016R0679` pentru GDPR, sau cuvinte-cheie). |

---

## 🚀 Cum funcționează în practică (Fluxul cu Documentul Utilizatorului)

1. **Utilizatorul** încarcă un document (contract, HCL, cerere de chemare în judecată, proces-verbal, decizie) în Claude / ChatGPT / Gemini și pune o întrebare.
2. **LLM-ul** citește documentul, identifică actele normative și articolele invocate (sau deduce ce legi se aplică speței).
3. **LLM-ul apelează automat `legislatie-ro-mcp`** (`cauta_acte_normative` + `extrage_articole_din_act` / `cauta_in_interiorul_actului`) pentru a verifica forma în vigoare la zi și eventualele RIL-uri/HP-uri/Decizii CCR.
4. **LLM-ul răspunde utilizatorului** ancorat strict în textele oficiale și oferă linkurile directe către `legislatie.just.ro`.

---

## ⚙️ Instalare „One-Click” (3 Moduri)

### Modul 1: Extensie de Browser (Pentru utilizatorii de rând în Gemini / ChatGPT / Claude Web — Fără Python!)
Directorul **[`browser-extension/`](./browser-extension)** (și arhiva gata împachetată `dist/legislatie-ro-browser-extension.zip`) conține o extensie Chrome / Edge / Brave / Firefox (Manifest V3) care **rulează 100% în browserul utilizatorului**, fără Python și fără niciun server intermediar:
- Injectează automat butonul plutitor **`⚖️ Legislație RO`** direct peste `gemini.google.com`, `chatgpt.com` și `claude.ai`.
- Are buton de **„🔍 Detectează legile din conversație”** (scanează pagina după `Legea X/Y`, `OUG X/Y`, `HG X/Y`, `Art. Z` și creează butoane rapide).
- Interoghează direct API-ul SOAP oficial `legislatie.just.ro/apiws` din browserul utilizatorului (cu cache local în `chrome.storage.local` și rate-limiting de 1 req/sec) și **inserează cu 1 click textul oficial la zi direct în căsuța de prompt a AI-ului**.

**Instalare rapidă în Chrome / Brave / Edge:**
1. Deschideți `chrome://extensions/` și activați **Developer mode** (dreapta-sus).
2. Apăsați **Load unpacked** (sau trageți arhiva) și selectați folderul `legislatie-ro-mcp/browser-extension`.

### Modul 2: Pachet „One-Click” `.mcpb` pentru Claude Desktop
1. Descărcați fișierul gata construit **`dist/legislatie-ro.mcpb`** (sau generați-l cu `python3 build_bundles.py`).
2. Dați dublu-click pe `legislatie-ro.mcpb` sau trageți-l în **Claude Desktop $\rightarrow$ Settings $\rightarrow$ Extensions** și apăsați **Install**.

### Modul 3: Configurare MCP Standard (`stdio` în Claude Code / Cursor / Antigravity / Windsurf)

Adăugați în fișierul de configurare MCP (`claude_desktop_config.json` sau `mcp_config.json`):

```json
{
  "mcpServers": {
    "legislatie-ro": {
      "command": "python3",
      "args": ["/calea/catre/legislatie-ro-mcp/server.py"]
    }
  }
}
```

### Rulare din linia de comandă (Testare / CLI)

```bash
# Testare conexiune API oficial legislatie.just.ro + căutare și extragere articol
python3 server.py --self-test
```

---

## ⚠️ Disclaimer Legal

> **Acest software este un conector tehnic open-source (licență MIT) către serviciile publice oficiale de informare legislativă (`legislatie.just.ro` și `eur-lex.europa.eu`).**
> - Nu oferă consultanță sau asistență juridică în sensul Legii nr. 51/1995.
> - Conform Legii nr. 202/1998, singura formă a actelor normative care produce efecte juridice oficiale este cea publicată în Monitorul Oficial al României. Verificați întotdeauna linkul oficial `LinkHtml` returnat împreună cu fiecare rezultat.
