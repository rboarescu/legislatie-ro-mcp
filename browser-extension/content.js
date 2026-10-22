/**
 * content.js — Widget plutitor injectat pe Gemini, ChatGPT și Claude Web
 *
 * Permite utilizatorului de rând:
 * 1. Să scaneze automat conversația / documentul curent pentru trimiteri la legi (Legea X/Y, OUG X/Y, Art. Z)
 * 2. Să caute orice lege / articol direct în `legislatie.just.ro`
 * 3. Să insereze cu 1 click textul oficial la zi direct în căsuța de prompt a lui Gemini / ChatGPT / Claude
 */

(function () {
  if (document.getElementById("legis-ro-floating-root")) return;

  const root = document.createElement("div");
  root.id = "legis-ro-floating-root";
  root.innerHTML = `
    <button id="legis-ro-fab" title="Ancorare în legislația oficială la zi (legislatie.just.ro)">
      ⚖️ Legislație RO
    </button>
    <div id="legis-ro-drawer" class="legis-ro-hidden">
      <div class="legis-ro-header">
        <div>
          <strong>🇷🇴 Ancorare Legislație la Zi</strong>
          <span class="legis-ro-sub">API Oficial legislatie.just.ro</span>
        </div>
        <button id="legis-ro-close" title="Închide">✕</button>
      </div>

      <div class="legis-ro-body">
        <div class="legis-ro-search-row">
          <input
            type="text"
            id="legis-ro-input"
            placeholder="Ex: Legea 114/1996 art 38, 39 sau OUG 57/2019 art 292"
          />
          <button id="legis-ro-search-btn">Caută</button>
        </div>

        <div class="legis-ro-actions-bar">
          <button id="legis-ro-scan-btn" class="legis-ro-secondary-btn">
            🔍 Detectează legile din conversație
          </button>
        </div>

        <div id="legis-ro-detected-chips" class="legis-ro-chips"></div>
        <div id="legis-ro-results" class="legis-ro-results">
          <div class="legis-ro-empty">
            Scrieți o lege și articolul (ex: <code>Legea 554/2004 art 11</code>) sau apăsați
            <b>„Detectează legile din conversație”</b> pentru a verifica automat ce a citat AI-ul sau ce scrie în documentul dvs.
          </div>
        </div>
      </div>

      <div class="legis-ro-footer">
        <button id="legis-ro-inject-btn" class="legis-ro-primary-btn" disabled>
          📌 Atașează textul oficial în căsuța de Chat AI
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(root);

  const fab = document.getElementById("legis-ro-fab");
  const drawer = document.getElementById("legis-ro-drawer");
  const closeBtn = document.getElementById("legis-ro-close");
  const input = document.getElementById("legis-ro-input");
  const searchBtn = document.getElementById("legis-ro-search-btn");
  const scanBtn = document.getElementById("legis-ro-scan-btn");
  const chipsContainer = document.getElementById("legis-ro-detected-chips");
  const resultsContainer = document.getElementById("legis-ro-results");
  const injectBtn = document.getElementById("legis-ro-inject-btn");

  let lastPayloadForPrompt = "";

  fab.addEventListener("click", () => {
    drawer.classList.toggle("legis-ro-hidden");
    if (!drawer.classList.contains("legis-ro-hidden")) {
      input.focus();
    }
  });

  closeBtn.addEventListener("click", () => {
    drawer.classList.add("legis-ro-hidden");
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runQuery(input.value);
    }
  });

  searchBtn.addEventListener("click", () => {
    runQuery(input.value);
  });

  scanBtn.addEventListener("click", () => {
    const refs = scanPageForLegalReferences();
    chipsContainer.innerHTML = "";
    if (refs.length === 0) {
      chipsContainer.innerHTML = `<span class="legis-ro-chip-muted">Nu am găsit referințe explicite în pagină.</span>`;
      return;
    }
    refs.forEach((ref) => {
      const chip = document.createElement("button");
      chip.className = "legis-ro-chip";
      chip.textContent = ref;
      chip.addEventListener("click", () => {
        input.value = ref;
        runQuery(ref);
      });
      chipsContainer.appendChild(chip);
    });
  });

  injectBtn.addEventListener("click", () => {
    if (!lastPayloadForPrompt) return;
    insertIntoChatPrompt(lastPayloadForPrompt);
  });

  function runQuery(q) {
    const query = (q || "").trim();
    if (!query) return;
    resultsContainer.innerHTML = `<div class="legis-ro-loading">⏳ Se interoghează API-ul oficial legislatie.just.ro...</div>`;
    injectBtn.disabled = true;

    chrome.runtime.sendMessage({ type: "QUERY_LEGISLATIE", query }, (resp) => {
      if (chrome.runtime.lastError) {
        resultsContainer.innerHTML = `<div class="legis-ro-error">Eroare extensie: ${chrome.runtime.lastError.message}</div>`;
        return;
      }
      if (!resp || !resp.ok) {
        resultsContainer.innerHTML = `<div class="legis-ro-error">${(resp && resp.error) || "Eroare necunoscută"}</div>`;
        return;
      }
      renderResults(resp);
    });
  }

  function renderResults(data) {
    const { act, articole } = data;
    const artsHtml = articole
      .map(
        (a) => `
        <div class="legis-ro-art-card">
          <div class="legis-ro-art-title">${escapeHtml(a.label)}</div>
          <pre class="legis-ro-art-text">${escapeHtml(a.content)}</pre>
        </div>
      `
      )
      .join("");

    resultsContainer.innerHTML = `
      <div class="legis-ro-act-meta">
        <div><strong>${escapeHtml(act.tipAct)} nr. ${escapeHtml(act.numar)}</strong> (${escapeHtml(act.dataVigoare)})</div>
        <div class="legis-ro-act-title">${escapeHtml(act.titlu)}</div>
        ${
          act.linkHtml
            ? `<a href="${escapeHtml(act.linkHtml)}" target="_blank" rel="noopener noreferrer" class="legis-ro-link">🔗 Deschide pe legislatie.just.ro</a>`
            : ""
        }
      </div>
      ${artsHtml}
    `;

    // Construim blocul de ancorare pentru promptul AI
    const lines = [
      `[ANCORARE LEGISLAȚIE OFICIALĂ LA ZI — Sursă: legislatie.just.ro]`,
      `Act normativ: ${act.tipAct} nr. ${act.numar} (Data intrării în vigoare: ${act.dataVigoare})`,
      `Link oficial: ${act.linkHtml || "https://legislatie.just.ro"}`,
      `---`
    ];
    articole.forEach((a) => {
      lines.push(a.content);
      lines.push(`---`);
    });
    lines.push(
      `Instrucțiune: Răspunde cerinței mele bazându-te strict pe textul oficial de mai sus extras din legislatie.just.ro, fără a presupune alt conținut al articolelor.`
    );

    lastPayloadForPrompt = lines.join("\n");
    injectBtn.disabled = false;
  }

  function scanPageForLegalReferences() {
    const bodyText = document.body.innerText || "";
    const found = new Set();

    // 1. Căutăm tipare de genul "art. 38 din Legea nr. 114/1996" sau "art. 11 alin. (2) din Legea 554/2004"
    const artInActRe = /\b(?:articolul|art\.?)\s*([0-9]{1,4})(?:\s*alin\.?\s*\(?[0-9]+\)?)?\s*(?:și\s*(?:art\.?\s*)?([0-9]{1,4}))?\s*din\s*(Legea|O\.?U\.?G\.?|O\.?G\.?|H\.?G\.?)\s*(?:nr\.?\s*)?([0-9]{1,5}\/[0-9]{4})/gi;
    let m;
    while ((m = artInActRe.exec(bodyText)) !== null) {
      const actType = m[3].replace(/\./g, "").toUpperCase();
      const arts = m[2] ? `${m[1]}, ${m[2]}` : m[1];
      found.add(`${actType} ${m[4]} art ${arts}`);
    }

    // 2. Căutăm acte generale menționate în pagină (ex: Legea nr. 114/1996, OUG nr. 57/2019, Legea 169/2026)
    const simpleActRe = /\b(Legea|O\.?U\.?G\.?|O\.?G\.?|H\.?G\.?)\s*(?:nr\.?\s*)?([0-9]{1,5}\/(?:19|20)[0-9]{2})\b/gi;
    while ((m = simpleActRe.exec(bodyText)) !== null) {
      const actType = m[1].replace(/\./g, "").toUpperCase();
      found.add(`${actType} ${m[2]}`);
    }

    // 3. Căutăm Coduri uzuale
    const codRe = /\b(Codul\s+administrativ|Codul\s+muncii|Codul\s+civil|Codul\s+de\s+procedură\s+civilă|Codul\s+fiscal)\b/gi;
    while ((m = codRe.exec(bodyText)) !== null) {
      found.add(m[1]);
    }

    return Array.from(found).slice(0, 10);
  }

  function insertIntoChatPrompt(textToInsert) {
    // 1. Textarea clasic (ChatGPT fallback / interfețe standard)
    const textarea =
      document.querySelector("#prompt-textarea") ||
      document.querySelector("textarea");

    // 2. Editor contenteditable (Gemini rich-textarea, Claude ProseMirror, ChatGPT ProseMirror)
    const editable =
      document.querySelector('div.ql-editor[contenteditable="true"]') ||
      document.querySelector('div.ProseMirror[contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"][role="textbox"]') ||
      document.querySelector('[contenteditable="true"]');

    if (editable) {
      editable.focus();
      const existing = editable.innerText.trim();
      const combined = existing ? `${existing}\n\n${textToInsert}` : textToInsert;
      // Folosim execCommand sau manipulare directă + evenimente input pentru React/Angular
      document.execCommand("insertText", false, (existing ? "\n\n" : "") + textToInsert);
      editable.dispatchEvent(new Event("input", { bubbles: true }));
      injectBtn.textContent = "✅ Atașat în căsuța de Chat!";
      setTimeout(() => {
        injectBtn.textContent = "📌 Atașează textul oficial în căsuța de Chat AI";
      }, 2500);
      return;
    }

    if (textarea) {
      textarea.focus();
      const existing = textarea.value.trim();
      textarea.value = existing ? `${existing}\n\n${textToInsert}` : textToInsert;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      injectBtn.textContent = "✅ Atașat în căsuța de Chat!";
      setTimeout(() => {
        injectBtn.textContent = "📌 Atașează textul oficial în căsuța de Chat AI";
      }, 2500);
      return;
    }

    // Fallback: copiere în clipboard
    navigator.clipboard.writeText(textToInsert).then(() => {
      injectBtn.textContent = "📋 Copiat în Clipboard (dați Paste în chat)!";
      setTimeout(() => {
        injectBtn.textContent = "📌 Atașează textul oficial în căsuța de Chat AI";
      }, 2500);
    });
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
