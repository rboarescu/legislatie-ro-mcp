/**
 * background.js — Service Worker pentru Extensia "Legislație RO — Ancorare AI"
 *
 * Interoghează exclusiv API-ul public oficial SOAP `legislatie.just.ro/apiws/FreeWebService.svc/SOAP`
 * direct din browserul utilizatorului (fără server intermediar, zero risc GDPR).
 * Include:
 * - Rate-limiting strict (minim 1.0s între cereri, max 20 cereri/minut)
 * - Cache local în `chrome.storage.local` pentru token și acte descărcate
 * - Parser determinist pe articole (Articolul X) + rezolvare de aliasuri (Codul Administrativ, Codul Muncii etc.)
 */

const SOAP_URL = "https://legislatie.just.ro/apiws/FreeWebService.svc/SOAP";
const SOAP_ACTION_TOKEN = "http://tempuri.org/IFreeWebService/GetToken";
const SOAP_ACTION_SEARCH = "http://tempuri.org/IFreeWebService/Search";

const MIN_INTERVAL_MS = 1000;
const MAX_REQ_PER_MIN = 20;

let lastRequestTime = 0;
let recentTimestamps = [];

const ALIASURI_ACTE = {
  "codul administrativ": { numar: "57", an: "2019", titlu: "Codul administrativ" },
  "cod administrativ": { numar: "57", an: "2019", titlu: "Codul administrativ" },
  "codul muncii": { numar: "53", an: "2003", titlu: "Codul muncii" },
  "codul civil": { numar: "287", an: "2009", titlu: "Codul civil" },
  "codul de procedura civila": { numar: "134", an: "2010", titlu: "Codul de procedura civila" },
  "cod procedura civila": { numar: "134", an: "2010", titlu: "Codul de procedura civila" },
  "codul penal": { numar: "286", an: "2009", titlu: "Codul penal" },
  "codul de procedura penala": { numar: "135", an: "2010", titlu: "Codul de procedura penala" },
  "codul fiscal": { numar: "227", an: "2015", titlu: "Codul fiscal" },
  "codul de procedura fiscala": { numar: "207", an: "2015", titlu: "Codul de procedura fiscala" },
  "codul rutier": { numar: "195", an: "2002", titlu: "circulatia pe drumurile publice" },
  "codul urbanismului": { numar: "169", an: "2026", titlu: "amenajarii teritoriului, urbanismului si constructiilor" },
  "catuc": { numar: "169", an: "2026", titlu: "amenajarii teritoriului, urbanismului si constructiilor" },
  "contencios administrativ": { numar: "554", an: "2004", titlu: "contenciosului administrativ" },
  "legea contenciosului administrativ": { numar: "554", an: "2004", titlu: "contenciosului administrativ" },
  "legea locuintei": { numar: "114", an: "1996", titlu: "legea locuintei" },
  "legea societatilor": { numar: "31", an: "1990", titlu: "societatilor" },
  "legea urbanismului": { numar: "350", an: "2001", titlu: "amenajarea teritoriului si urbanismul" },
  "autorizarea constructiilor": { numar: "50", an: "1991", titlu: "autorizarea executarii lucrarilor de constructii" },
  "regimul contraventiilor": { numar: "2", an: "2001", titlu: "regimul juridic al contraventiilor" },
  "stare civila": { numar: "119", an: "1996", titlu: "actele de stare civila" },
  "asociatii de proprietari": { numar: "196", an: "2018", titlu: "asociatiilor de proprietari" }
};

function stripDiacriticsLower(str) {
  if (!str) return "";
  return str
    .replace(/[ăâĂÂ]/g, "a")
    .replace(/[îÎ]/g, "i")
    .replace(/[șşȘŞ]/g, "s")
    .replace(/[țţȚŢ]/g, "t")
    .toLowerCase()
    .trim();
}

function escapeXml(unsafe) {
  if (!unsafe) return "";
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function throttle() {
  const now = Date.now();
  recentTimestamps = recentTimestamps.filter((t) => now - t < 60000);
  if (recentTimestamps.length >= MAX_REQ_PER_MIN) {
    const waitMs = Math.min(8000, 60000 - (now - recentTimestamps[0]));
    await new Promise((r) => setTimeout(r, Math.max(1000, waitMs)));
  }
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
  recentTimestamps.push(lastRequestTime);
}

async function soapPost(soapAction, xmlBody) {
  await throttle();
  const resp = await fetch(SOAP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction": `"${soapAction}"`
    },
    body: xmlBody
  });
  if (!resp.ok) {
    throw new Error(`Eroare HTTP ${resp.status} de la legislatie.just.ro`);
  }
  return await resp.text();
}

function extractXmlTagValue(xml, tagName) {
  const re = new RegExp(`<(?:[a-zA-Z0-9_]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_]+:)?${tagName}>`, "i");
  const m = xml.match(re);
  if (!m) return "";
  return decodeXmlEntities(m[1].trim());
}

function decodeXmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

async function getToken(forceRefresh = false) {
  if (!forceRefresh) {
    const data = await chrome.storage.local.get(["soapToken", "soapTokenTs"]);
    if (data.soapToken && data.soapTokenTs && Date.now() - data.soapTokenTs < 15 * 60 * 1000) {
      return data.soapToken;
    }
  }
  const envelope = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <GetToken xmlns="http://tempuri.org/" />
  </s:Body>
</s:Envelope>`;
  const rawXml = await soapPost(SOAP_ACTION_TOKEN, envelope);
  const token = extractXmlTagValue(rawXml, "GetTokenResult");
  if (!token) {
    throw new Error("Nu s-a putut obține tokenul oficial de la legislatie.just.ro.");
  }
  await chrome.storage.local.set({ soapToken: token, soapTokenTs: Date.now() });
  return token;
}

function xmlOptField(tag, val) {
  const v = (val || "").trim();
  if (!v) return `<d4p1:${tag} i:nil="true" />`;
  return `<d4p1:${tag}>${escapeXml(v)}</d4p1:${tag}>`;
}

async function searchLegislatie({ an = "", numar = "", text = "", titlu = "", page = 0, perPage = 4 }) {
  const cacheKey = `search_${an}_${numar}_${stripDiacriticsLower(titlu)}_${stripDiacriticsLower(text)}`;
  const stored = await chrome.storage.local.get([cacheKey]);
  if (stored[cacheKey] && Date.now() - stored[cacheKey].ts < 12 * 3600 * 1000) {
    return stored[cacheKey].items;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(attempt > 0);
    const envelope = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <Search xmlns="http://tempuri.org/">
      <SearchModel xmlns:d4p1="http://schemas.datacontract.org/2004/07/FreeWebService" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
        <d4p1:NumarPagina>${page}</d4p1:NumarPagina>
        <d4p1:RezultatePagina>${Math.min(Math.max(perPage, 1), 8)}</d4p1:RezultatePagina>
        ${xmlOptField("SearchAn", an)}
        ${xmlOptField("SearchNumar", numar)}
        ${xmlOptField("SearchText", text)}
        ${xmlOptField("SearchTitlu", titlu)}
      </SearchModel>
      <tokenKey>${escapeXml(token)}</tokenKey>
    </Search>
  </s:Body>
</s:Envelope>`;

    try {
      const rawXml = await soapPost(SOAP_ACTION_SEARCH, envelope);
      const blocks = rawXml.match(/<(?:[a-zA-Z0-9_]+:)?Legi\b[^>]*>[\s\S]*?<\/(?:[a-zA-Z0-9_]+:)?Legi>/gi) || [];
      const items = blocks.map((b) => ({
        tipAct: extractXmlTagValue(b, "TipAct"),
        numar: extractXmlTagValue(b, "Numar"),
        dataVigoare: extractXmlTagValue(b, "DataVigoare"),
        emitent: extractXmlTagValue(b, "Emitent"),
        publicatie: extractXmlTagValue(b, "Publicatie"),
        linkHtml: extractXmlTagValue(b, "LinkHtml"),
        titlu: cleanSoapText(extractXmlTagValue(b, "Titlu")),
        text: cleanSoapText(extractXmlTagValue(b, "Text"))
      }));

      if (items.length > 0 || attempt === 1) {
        await chrome.storage.local.set({ [cacheKey]: { ts: Date.now(), items } });
        return items;
      }
    } catch (e) {
      if (attempt === 1) throw e;
    }
  }
  return [];
}

function cleanSoapText(raw) {
  if (!raw) return "";
  return raw
    .replace(/^\uFEFF/, "")
    .replace(/\u00A0/g, " ")
    .replace(/\s*\.\.\.\s*/g, "\n  ")
    .replace(/\s*\+\s*(?=\n|$)/g, "\n")
    .replace(/\s{2,}(?=(?:Articolul\s+[0-9IVXLCDM]+|CAPITOLUL\s+[0-9IVXLCDM]+|TITLUL\s+[0-9IVXLCDM]+|SECȚIUNEA\s+|SECTIUNEA\s+|Notă|Nota|La data de\s+[0-9]{2}-[0-9]{2}-[0-9]{4}))/g, "\n\n")
    .replace(/\s{2,}(?=\([0-9]+\)\s+[A-ZĂÂÎȘȚ])/g, "\n  ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseArticles(cleanText) {
  if (!cleanText) return [];
  const regex = /(?:^|\n)(Articolul\s+([0-9]+(?:\^[0-9]+)?|[IVXLCDM]+)|Art\.\s*([0-9]+(?:\^[0-9]+)?|[IVXLCDM]+))\b[.\s:-]*/gi;
  const matches = [];
  let m;
  while ((m = regex.exec(cleanText)) !== null) {
    matches.push({
      index: m.index + (cleanText[m.index] === "\n" ? 1 : 0),
      label: m[1].trim(),
      num: (m[2] || m[3] || "").toLowerCase()
    });
  }
  if (matches.length === 0) {
    return [{ num: "integral", label: "Textul actului", content: cleanText.slice(0, 6000) }];
  }
  return matches.map((item, idx) => {
    const end = idx + 1 < matches.length ? matches[idx + 1].index : cleanText.length;
    return {
      num: item.num,
      label: item.label,
      content: cleanText.slice(item.index, end).trim()
    };
  });
}

function parseUserQuery(rawQuery) {
  const norm = stripDiacriticsLower(rawQuery);
  let numar = "";
  let an = "";
  let titlu = "";
  let articole = [];
  let cuvinte = "";

  // 1. Extragem numere de articole dacă sunt specificate (ex: "art 38, 39" sau "art. 11" sau "articolul 582")
  const artMatch = norm.match(/\b(?:articolele|articolul|art\.?)\s*([0-9]+(?:\s*[-,]\s*[0-9]+)*)/i);
  if (artMatch) {
    const rawArts = artMatch[1];
    rawArts.split(/[,;]+/).forEach((part) => {
      part = part.trim();
      const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        const s = parseInt(range[1], 10);
        const e = parseInt(range[2], 10);
        for (let i = s; i <= e && i - s <= 10; i++) articole.push(String(i));
      } else if (/^\d+$/.test(part)) {
        articole.push(part);
      }
    });
  }

  // 2. Verificăm aliasurile (Codul Administrativ, Codul Muncii, Legea locuinței etc.)
  for (const [alias, meta] of Object.entries(ALIASURI_ACTE)) {
    if (norm.includes(alias)) {
      numar = meta.numar;
      an = meta.an;
      titlu = meta.titlu;
      break;
    }
  }

  // 3. Verificăm tipul "Legea 114/1996", "OUG 57/2019", "HG 525/1996"
  if (!numar || !an) {
    const actMatch = norm.match(/\b(?:legea|lege|oug|o\.u\.g\.|og|hg|h\.g\.|ordinul|ordin|decizia)?\s*(?:nr\.\s*)?([0-9]{1,5})\s*(?:\/|\s+din\s+)((?:19|20)[0-9]{2})\b/i);
    if (actMatch) {
      numar = actMatch[1];
      an = actMatch[2];
    }
  }

  // 4. Dacă nu am găsit niciun număr/an de act, folosim interogarea ca text/titlu
  if (!numar && !an && !titlu) {
    cuvinte = rawQuery.replace(/\b(?:articolele|articolul|art\.?)\s*[0-9,\s-]+/gi, "").trim();
  }

  return { numar, an, titlu, articole, cuvinte };
}

async function handleQueryLegislatie(rawQuery) {
  const parsed = parseUserQuery(rawQuery);
  let items = await searchLegislatie({
    an: parsed.an,
    numar: parsed.numar,
    titlu: !parsed.numar && !parsed.an ? parsed.titlu : "",
    text: parsed.cuvinte
  });

  if (items.length === 0 && (parsed.titlu || parsed.cuvinte)) {
    items = await searchLegislatie({
      an: parsed.an,
      numar: parsed.numar,
      titlu: "",
      text: parsed.titlu || parsed.cuvinte
    });
  }

  if (items.length === 0) {
    return {
      ok: false,
      error: `Nu s-au găsit acte în legislatie.just.ro pentru: "${rawQuery}". Încercați de ex.: "Legea 114/1996 art 39" sau "OUG 57/2019 art 292".`
    };
  }

  // Alegem actul de bază (cel mai amplu ca text consolidat)
  const best = [...items].sort((a, b) => (b.text || "").length - (a.text || "").length)[0];
  const allArts = parseArticles(best.text);

  let selectedArts = [];
  if (parsed.articole.length > 0) {
    const idxSet = new Set();
    allArts.forEach((a, idx) => {
      if (parsed.articole.includes(a.num)) {
        idxSet.add(idx);
        // Adăugăm și vecinul imediat (+1) dacă s-a cerut un singur articol (ex: art. 38 -> arată și art. 39)
        if (parsed.articole.length === 1 && idx + 1 < allArts.length) {
          idxSet.add(idx + 1);
        }
      }
    });
    selectedArts = Array.from(idxSet)
      .sort((a, b) => a - b)
      .map((i) => allArts[i]);
  } else if (parsed.cuvinte) {
    const terms = stripDiacriticsLower(parsed.cuvinte)
      .split(/\s+/)
      .filter((t) => t.length >= 3);
    selectedArts = allArts
      .filter((a) => {
        const c = stripDiacriticsLower(a.content);
        return terms.some((t) => c.includes(t));
      })
      .slice(0, 5);
  }

  if (selectedArts.length === 0) {
    selectedArts = allArts.slice(0, 3);
  }

  return {
    ok: true,
    act: {
      tipAct: best.tipAct,
      numar: best.numar,
      dataVigoare: best.dataVigoare,
      titlu: best.titlu,
      emitent: best.emitent,
      linkHtml: best.linkHtml
    },
    articole: selectedArts
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "QUERY_LEGISLATIE") {
    handleQueryLegislatie(message.query)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true; // răspuns asincron
  }
});
