#!/usr/bin/env python3
"""
legislatie-ro-mcp — Conector MCP (Model Context Protocol) fara dependente externe
pentru Legislatia Consolidata a Romaniei (legislatie.just.ro SOAP API oficial)
si Legislatia Uniunii Europene in limba romana (EUR-Lex REST API).

Arhitectura "Zero Risc":
- 100% API-uri publice oficiale (FreeWebService.svc WSDL al Ministerului Justitiei & EUR-Lex).
- Fara scraping pe rejust.ro sau ocolire de mecanisme anti-bot.
- Stateless Search-Only (GDPR-Safe): nu primeste si nu salveaza documentele utilizatorului.
- Zero dependente externe: ruleaza direct pe Python 3.10+ stdlib (urllib, xml, sqlite3, json).
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

# ============================================================================
# Configurare & Constante Oficiale
# ============================================================================

SOAP_URL = "https://legislatie.just.ro/apiws/FreeWebService.svc/SOAP"
SOAP_ACTION_TOKEN = "http://tempuri.org/IFreeWebService/GetToken"
SOAP_ACTION_SEARCH = "http://tempuri.org/IFreeWebService/Search"

NS_SOAP = "http://schemas.xmlsoap.org/soap/envelope/"
NS_TEMPURI = "http://tempuri.org/"
NS_DATA = "http://schemas.datacontract.org/2004/07/FreeWebService"
NS_XSI = "http://www.w3.org/2001/XMLSchema-instance"

CACHE_DIR = Path(
    os.environ.get(
        "LEGISLATIE_RO_CACHE_DIR",
        Path.home() / ".cache" / "legislatie-ro-mcp",
    )
)
CACHE_DB_PATH = CACHE_DIR / "cache.sqlite"

# Rate-limiting politicos si plafoane de siguranta fata de serverul Ministerului Justitiei
MIN_REQUEST_INTERVAL_SEC = 1.0
MAX_REQUESTS_PER_MINUTE = 20
MAX_REQUESTS_PER_HOUR = 300

DISCLAIMER_LEGAL = (
    "Sursa: Portalul Legislativ N-Lex (legislatie.just.ro — Ministerul Justitiei). "
    "Conform Termenilor si Conditiilor portalului (https://legislatie.just.ro/Public/Termeni) "
    "si art. 9 lit. b) din Legea nr. 8/1996, textele oficiale de natura legislativa nu beneficiaza "
    "de protectia dreptului de autor si pot fi reutilizate, insa versiunile consolidate au caracter "
    "strict informativ/consultativ. Singura baza legala autentica la care se poate face referire "
    "in documentele oficiale este textul publicat in Monitorul Oficial al Romaniei (Legea nr. 202/1998). "
    "Acest conector tehnic nu ofera consultanta juridica (Legea nr. 51/1995)."
)

# Aliasuri uzuale pentru ca omul de rand sau LLM-ul sa poata scrie direct "Codul Muncii", "Codul Administrativ" etc.
ALIASURI_ACTE: dict[str, dict[str, str]] = {
    "codul administrativ": {"numar": "57", "an": "2019", "titlu": "Codul administrativ", "doc_id": "215925"},
    "oug 57/2019": {"numar": "57", "an": "2019", "titlu": "Codul administrativ", "doc_id": "215925"},
    "cod administrativ": {"numar": "57", "an": "2019", "titlu": "Codul administrativ", "doc_id": "215925"},
    "codul muncii": {"numar": "53", "an": "2003", "titlu": "Codul muncii", "doc_id": "41625"},
    "legea 53/2003": {"numar": "53", "an": "2003", "titlu": "Codul muncii", "doc_id": "41625"},
    "codul civil": {"numar": "287", "an": "2009", "titlu": "Codul civil", "doc_id": "109884"},
    "codul de procedura civila": {"numar": "134", "an": "2010", "titlu": "Codul de procedură civilă", "doc_id": "120611"},
    "cod procedura civila": {"numar": "134", "an": "2010", "titlu": "Codul de procedură civilă", "doc_id": "120611"},
    "codul penal": {"numar": "286", "an": "2009", "titlu": "Codul penal", "doc_id": "109855"},
    "codul de procedura penala": {"numar": "135", "an": "2010", "titlu": "Codul de procedură penală", "doc_id": "120612"},
    "codul fiscal": {"numar": "227", "an": "2015", "titlu": "Codul fiscal", "doc_id": "171282"},
    "codul de procedura fiscala": {"numar": "207", "an": "2015", "titlu": "Codul de procedură fiscală", "doc_id": "170011"},
    "codul rutier": {"numar": "195", "an": "2002", "titlu": "circulația pe drumurile publice", "doc_id": "41023"},
    "oug 195/2002": {"numar": "195", "an": "2002", "titlu": "circulația pe drumurile publice", "doc_id": "41023"},
    "codul silvic": {"numar": "331", "an": "2024", "titlu": "Codul silvic"},
    "codul urbanismului": {"numar": "169", "an": "2026", "titlu": "amenajării teritoriului, urbanismului și construcțiilor"},
    "catuc": {"numar": "169", "an": "2026", "titlu": "amenajării teritoriului, urbanismului și construcțiilor"},
    "contencios administrativ": {"numar": "554", "an": "2004", "titlu": "contenciosului administrativ", "doc_id": "57426"},
    "legea contenciosului administrativ": {"numar": "554", "an": "2004", "titlu": "contenciosului administrativ", "doc_id": "57426"},
    "legea 554/2004": {"numar": "554", "an": "2004", "titlu": "contenciosului administrativ", "doc_id": "57426"},
    "legea locuintei": {"numar": "114", "an": "1996", "titlu": "legea locuinţei", "tip_act": "LEGE", "doc_id": "8597"},
    "legea 114/1996": {"numar": "114", "an": "1996", "titlu": "legea locuinţei", "tip_act": "LEGE", "doc_id": "8597"},
    "legea societatilor": {"numar": "31", "an": "1990", "titlu": "societăţilor", "tip_act": "LEGE", "doc_id": "737"},
    "legea 31/1990": {"numar": "31", "an": "1990", "titlu": "societăţilor", "tip_act": "LEGE", "doc_id": "737"},
    "legea urbanismului": {"numar": "350", "an": "2001", "titlu": "amenajarea teritoriului", "tip_act": "LEGE", "doc_id": "29453"},
    "legea 350/2001": {"numar": "350", "an": "2001", "titlu": "amenajarea teritoriului", "tip_act": "LEGE", "doc_id": "29453"},
    "autorizarea constructiilor": {"numar": "50", "an": "1991", "titlu": "autorizarea executării lucrărilor de construcţii", "tip_act": "LEGE", "doc_id": "1449"},
    "legea 50/1991": {"numar": "50", "an": "1991", "titlu": "autorizarea executării lucrărilor de construcţii", "tip_act": "LEGE", "doc_id": "1449"},
    "regimul contraventiilor": {"numar": "2", "an": "2001", "titlu": "regimul juridic al contravenţiilor", "tip_act": "ORDONANȚĂ", "doc_id": "29779"},
    "og 2/2001": {"numar": "2", "an": "2001", "titlu": "regimul juridic al contravenţiilor", "tip_act": "ORDONANȚĂ", "doc_id": "29779"},
    "og nr. 2/2001": {"numar": "2", "an": "2001", "titlu": "regimul juridic al contravenţiilor", "tip_act": "ORDONANȚĂ", "doc_id": "29779"},
    "ordonanta 2/2001": {"numar": "2", "an": "2001", "titlu": "regimul juridic al contravenţiilor", "tip_act": "ORDONANȚĂ", "doc_id": "29779"},
    "stare civila": {"numar": "119", "an": "1996", "titlu": "actele de stare civilă", "tip_act": "LEGE", "doc_id": "8613"},
    "legea 119/1996": {"numar": "119", "an": "1996", "titlu": "actele de stare civilă", "tip_act": "LEGE", "doc_id": "8613"},
    "legea 7/1996": {"numar": "7", "an": "1996", "titlu": "cadastrului şi a publicităţii imobiliare", "tip_act": "LEGE", "doc_id": "7863"},
    "asociatii de proprietari": {"numar": "196", "an": "2018", "titlu": "asociaţiilor de proprietari", "tip_act": "LEGE", "doc_id": "203233"},
    "legea 196/2018": {"numar": "196", "an": "2018", "titlu": "asociaţiilor de proprietari", "tip_act": "LEGE", "doc_id": "203233"},
    "accesul la informatii de interes public": {"numar": "544", "an": "2001", "titlu": "liberul acces la informaţiile de interes public", "tip_act": "LEGE", "doc_id": "31413"},
    "transparenta decizionala": {"numar": "52", "an": "2003", "titlu": "transparenţa decizională", "tip_act": "LEGE", "doc_id": "41571"},
    "norme de tehnica legislativa": {"numar": "24", "an": "2000", "titlu": "normele de tehnică legislativă", "tip_act": "LEGE", "doc_id": "21698"},
    "legea 24/2000": {"numar": "24", "an": "2000", "titlu": "normele de tehnică legislativă", "tip_act": "LEGE", "doc_id": "21698"},
    "achizitii publice": {"numar": "98", "an": "2016", "titlu": "achiziţiile publice", "tip_act": "LEGE", "doc_id": "178667"},
}


def strip_diacritics_lower(text: str) -> str:
    replacements = {
        "ă": "a", "â": "a", "î": "i", "ș": "s", "ş": "s", "ț": "t", "ţ": "t",
        "Ă": "a", "Â": "a", "Î": "i", "Ș": "s", "Ş": "s", "Ț": "t", "Ţ": "t",
    }
    out = "".join(replacements.get(ch, ch) for ch in text)
    return out.lower().strip()


# ============================================================================
# Smart Cache Local SQLite (cu FTS5 pentru cautare instantanee in articole)
# ============================================================================

class LocalLegisCache:
    def __init__(self, db_path: Path = CACHE_DB_PATH) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.db_path))
        self.conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        with self.conn:
            self.conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS token_store (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    token_key TEXT NOT NULL,
                    created_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS search_cache (
                    query_hash TEXT PRIMARY KEY,
                    response_json TEXT NOT NULL,
                    cached_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS acts (
                    act_key TEXT PRIMARY KEY,
                    tip_act TEXT,
                    numar TEXT,
                    an TEXT,
                    titlu TEXT,
                    emitent TEXT,
                    publicatie TEXT,
                    data_vigoare TEXT,
                    link_html TEXT,
                    raw_text TEXT,
                    cached_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS articles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    act_key TEXT NOT NULL,
                    art_num TEXT NOT NULL,
                    art_label TEXT NOT NULL,
                    section_path TEXT,
                    content TEXT NOT NULL,
                    notes TEXT,
                    ord_index INTEGER NOT NULL,
                    UNIQUE(act_key, art_num, ord_index)
                );

                CREATE INDEX IF NOT EXISTS idx_articles_act_art
                    ON articles(act_key, art_num);
                """
            )

    def get_token(self, max_age_sec: float = 1200.0) -> str | None:
        cur = self.conn.execute(
            "SELECT token_key, created_at FROM token_store WHERE id = 1"
        )
        row = cur.fetchone()
        if row and (time.time() - row["created_at"]) < max_age_sec:
            return str(row["token_key"])
        return None

    def save_token(self, token_key: str) -> None:
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO token_store (id, token_key, created_at)
                VALUES (1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    token_key = excluded.token_key,
                    created_at = excluded.created_at
                """,
                (token_key, time.time()),
            )

    def get_search_cache(self, params: dict[str, Any], max_age_sec: float = 86400.0) -> list[dict[str, Any]] | None:
        h = hashlib.sha256(json.dumps(params, sort_keys=True).encode("utf-8")).hexdigest()
        cur = self.conn.execute(
            "SELECT response_json, cached_at FROM search_cache WHERE query_hash = ?",
            (h,),
        )
        row = cur.fetchone()
        if row and (time.time() - row["cached_at"]) < max_age_sec:
            return json.loads(row["response_json"])
        return None

    def set_search_cache(self, params: dict[str, Any], results: list[dict[str, Any]]) -> None:
        h = hashlib.sha256(json.dumps(params, sort_keys=True).encode("utf-8")).hexdigest()
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO search_cache (query_hash, response_json, cached_at)
                VALUES (?, ?, ?)
                ON CONFLICT(query_hash) DO UPDATE SET
                    response_json = excluded.response_json,
                    cached_at = excluded.cached_at
                """,
                (h, json.dumps(results, ensure_ascii=False), time.time()),
            )

    def save_act_and_articles(self, act: dict[str, Any]) -> str:
        link = act.get("link_html") or ""
        doc_id_match = re.search(r"(\d+)$", link)
        act_key = doc_id_match.group(1) if doc_id_match else hashlib.md5(
            f"{act.get('tip_act')}:{act.get('numar')}:{act.get('data_vigoare')}:{act.get('titlu')}".encode("utf-8")
        ).hexdigest()[:12]

        raw_text = act.get("text") or ""
        year_match = re.search(r"\b(19\d\d|20\d\d)\b", f"{act.get('data_vigoare', '')} {act.get('titlu', '')}")
        an = year_match.group(1) if year_match else ""

        with self.conn:
            self.conn.execute(
                """
                INSERT INTO acts (
                    act_key, tip_act, numar, an, titlu, emitent,
                    publicatie, data_vigoare, link_html, raw_text, cached_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(act_key) DO UPDATE SET
                    tip_act = excluded.tip_act,
                    numar = excluded.numar,
                    an = excluded.an,
                    titlu = excluded.titlu,
                    emitent = excluded.emitent,
                    publicatie = excluded.publicatie,
                    data_vigoare = excluded.data_vigoare,
                    link_html = excluded.link_html,
                    raw_text = CASE WHEN length(excluded.raw_text) > 0 THEN excluded.raw_text ELSE acts.raw_text END,
                    cached_at = excluded.cached_at
                """,
                (
                    act_key,
                    act.get("tip_act", ""),
                    act.get("numar", ""),
                    an,
                    act.get("titlu", ""),
                    act.get("emitent", ""),
                    act.get("publicatie", ""),
                    act.get("data_vigoare", ""),
                    link,
                    raw_text,
                    time.time(),
                ),
            )

            if raw_text:
                parsed_articles = parse_articles_from_text(raw_text)
                if parsed_articles:
                    self.conn.execute("DELETE FROM articles WHERE act_key = ?", (act_key,))
                    self.conn.executemany(
                        """
                        INSERT INTO articles (act_key, art_num, art_label, section_path, content, notes, ord_index)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        [
                            (
                                act_key,
                                a["art_num"],
                                a["art_label"],
                                a["section_path"],
                                a["content"],
                                a["notes"],
                                idx,
                            )
                            for idx, a in enumerate(parsed_articles)
                        ],
                    )
        return act_key


# ============================================================================
# Parser Determinist de Structura si Articole din Textul Consolidat
# ============================================================================

ARTICLE_HEADER_RE = re.compile(
    r"(?:^|\n|\s{3,})(Articolul\s+([0-9]+(?:\^[0-9]+)?|[IVXLCDM]+)|Art\.\s*([0-9]+(?:\^[0-9]+)?|[IVXLCDM]+))\b[.\s:-]*"
)

STRUCTURE_HEADER_RE = re.compile(
    r"(?:^|\n|\s{3,})((?:TITLUL|CAPITOLUL|SECȚIUNEA|SECTIUNEA|PARTEA|CARTEA|ANEXA|ANEXĂ)\s+[^\n]+)"
)

NOTE_LINE_RE = re.compile(
    r"(?im)(?:Notă|Nota|La data de [0-9]{2}-[0-9]{2}-[0-9]{4}|Decizia (?:ÎCCJ|ICCJ|CCR)|Recurs în interesul legii|Hotărâre prealabilă)[^\n]*"
)


def clean_soap_text(raw_text: str) -> str:
    if not raw_text:
        return ""
    txt = html.unescape(raw_text).lstrip("\ufeff")
    txt = re.sub(r"<br\s*/?>", "\n", txt, flags=re.IGNORECASE)
    txt = re.sub(r"</(p|div|li|tr|h[1-6])>", "\n", txt, flags=re.IGNORECASE)
    txt = re.sub(r"<[^>]+>", "", txt)
    txt = txt.replace("\xa0", " ").replace("\r\n", "\n").replace("\r", "\n")
    # Eliminam artefactele UI din SOAP (+ de la expandare si ... intre alineate)
    txt = re.sub(r"\s*\.\.\.\s*", "\n  ", txt)
    txt = re.sub(r"\s*\+\s*(?=\n|$)", "\n", txt)
    # Inseram newline inainte de Articolul X / Capitolul X / (1) / Notă cand vin lipite cu spatii multiple
    txt = re.sub(
        r"\s{2,}(?=(?:Articolul\s+[0-9IVXLCDM]+|CAPITOLUL\s+[0-9IVXLCDM]+|TITLUL\s+[0-9IVXLCDM]+|SECȚIUNEA\s+|SECTIUNEA\s+|Notă|Nota|La data de\s+[0-9]{2}-[0-9]{2}-[0-9]{4}))",
        "\n\n",
        txt,
    )
    txt = re.sub(r"\s{2,}(?=\([0-9]+\)\s+[A-ZĂÂÎȘȚ])", "\n  ", txt)
    txt = re.sub(r"[ \t]{2,}", " ", txt)
    txt = re.sub(r"\n{3,}", "\n\n", txt)
    return txt.strip()


def parse_articles_from_consolidated_html(raw_html: str) -> list[dict[str, str]]:
    """
    Parseaza direct clasele oficiale CTCE din pagina `LinkHtml` (DetaliiDocument/{id}):
    - `.S_ART_TTL` + `.S_ART_BDY` (textul consolidat la zi al articolului, cu toate modificarile integrate!)
    - `.S_NTA` si `.S_PAR` (notele de modificare, Deciziile CCR si RIL/HP ICCJ atasate direct sub alineat!)
    """
    if not raw_html or "S_ART_TTL" not in raw_html:
        return []

    # Colectam pozitiile titlurilor/capitolelor
    struct_re = re.compile(
        r'<span\s+class="S_(?:TTL|CAP|SEC|PRT|CRT)_TTL"[^>]*>([\s\S]*?)</span>',
        flags=re.IGNORECASE,
    )
    struct_positions: list[tuple[int, str]] = [
        (m.start(), clean_soap_text(m.group(1))) for m in struct_re.finditer(raw_html)
    ]

    def get_section_at(pos: int) -> str:
        recent = [label for p, label in struct_positions if p < pos and label]
        return " > ".join(recent[-2:]) if recent else "Dispoziții generale"

    art_ttl_re = re.compile(
        r'<span\s+class="S_ART_TTL"[^>]*>([\s\S]*?)</span>',
        flags=re.IGNORECASE,
    )
    matches = list(art_ttl_re.finditer(raw_html))
    if not matches:
        return []

    note_span_re = re.compile(
        r'<span\s+class="S_(?:NTA|PAR)"[^>]*>([\s\S]*?)</span>',
        flags=re.IGNORECASE,
    )

    articles: list[dict[str, str]] = []
    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(raw_html)
        block_html = raw_html[start:end]

        # Taiem la inceputul urmatorului Capitol/Titlu/Subsol daca se afla in interiorul blocului
        next_structs = [p for p, _ in struct_positions if start < p < end]
        if next_structs:
            block_html = raw_html[start : next_structs[0]]

        art_label = clean_soap_text(m.group(1))
        num_m = re.search(
            r"(?i)^(?:articolul|art\.?)\s*([0-9]+(?:\^[0-9]+)?|[IVXLCDM]+)\b",
            art_label.strip(),
        )
        art_num = num_m.group(1).lower() if num_m else str(i + 1)

        content_clean = clean_soap_text(block_html)
        notes_found = [
            line.strip()
            for line in content_clean.splitlines()
            if re.search(
                r"(?i)(\(la\s+[0-9]{2}-[0-9]{2}-[0-9]{4}|Notă|Nota|Decizia\s+(?:ÎCCJ|ICCJ|CCR)|Recurs\s+în\s+interesul\s+legii|Hotărâre\s+prealabilă|neconstituțional)",
                line,
            )
        ]
        articles.append(
            {
                "art_num": art_num,
                "art_label": art_label,
                "section_path": get_section_at(start),
                "content": content_clean,
                "notes": "\n".join(notes_found[:12]),
            }
        )

    return articles


def parse_articles_from_text(raw_text: str) -> list[dict[str, str]]:
    text = clean_soap_text(raw_text)
    if not text:
        return []

    # Colectam pozitiile titlurilor/capitolelor pentru a sti in ce capitol se afla fiecare articol
    struct_positions: list[tuple[int, str]] = [
        (m.start(), m.group(1).strip()) for m in STRUCTURE_HEADER_RE.finditer(text)
    ]

    def get_section_at(pos: int) -> str:
        recent = [label for p, label in struct_positions if p < pos]
        return " > ".join(recent[-2:]) if recent else "Preambul / Dispoziții generale"

    matches = list(ARTICLE_HEADER_RE.finditer(text))
    if not matches:
        return [
            {
                "art_num": "INTEGRAL",
                "art_label": "Textul actului",
                "section_path": "Text integral",
                "content": text[:15000],
                "notes": "\n".join(NOTE_LINE_RE.findall(text)[:10]),
            }
        ]

    articles: list[dict[str, str]] = []

    # Pastram si preambulul / emitentul inainte de Articolul 1
    first_start = matches[0].start()
    if first_start > 40:
        preambul = text[:first_start].strip()
        articles.append(
            {
                "art_num": "0",
                "art_label": "Preambul / Emitent / Temei",
                "section_path": "Preambul",
                "content": preambul[:6000],
                "notes": "\n".join(NOTE_LINE_RE.findall(preambul)),
            }
        )

    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        chunk = text[start:end].strip()

        # Daca la finalul acestui articol incepe urmatorul Capitol/Titlu, il decupam curat
        next_structs = [p for p, _ in struct_positions if start < p < end]
        if next_structs:
            chunk = text[start : next_structs[0]].strip()

        art_num = (m.group(2) or m.group(3) or "").strip()
        art_label = m.group(1).strip()
        notes_found = NOTE_LINE_RE.findall(chunk)

        articles.append(
            {
                "art_num": art_num.lower(),
                "art_label": art_label,
                "section_path": get_section_at(start),
                "content": chunk,
                "notes": "\n".join(notes_found),
            }
        )

    return articles


def extract_outline_from_text(raw_text: str) -> list[dict[str, str]]:
    text = clean_soap_text(raw_text)
    if not text:
        return []
    outline: list[dict[str, str]] = []
    lines = text.splitlines()
    current_heading = "Începutul actului"
    current_arts: list[str] = []

    for line in lines:
        s = line.strip()
        if not s:
            continue
        if STRUCTURE_HEADER_RE.match(s):
            if current_arts or current_heading != "Începutul actului":
                outline.append(
                    {
                        "sectiune": current_heading,
                        "articole": (
                            f"Art. {current_arts[0]} .. Art. {current_arts[-1]} ({len(current_arts)} articole)"
                            if current_arts
                            else "fără articole directe"
                        ),
                    }
                )
            # Luam si linia urmatoare daca este titlul capitolului
            current_heading = s
            current_arts = []
        else:
            am = ARTICLE_HEADER_RE.match(s)
            if am:
                num = (am.group(2) or am.group(3) or "").strip()
                if num:
                    current_arts.append(num)

    if current_arts or current_heading:
        outline.append(
            {
                "sectiune": current_heading,
                "articole": (
                    f"Art. {current_arts[0]} .. Art. {current_arts[-1]} ({len(current_arts)} articole)"
                    if current_arts
                    else "—"
                ),
            }
        )
    return outline


# ============================================================================
# Client Oficial SOAP legislatie.just.ro (FreeWebService.svc)
# ============================================================================

class LegislatieJustRoClient:
    def __init__(self, cache: LocalLegisCache) -> None:
        self.cache = cache
        self._last_call_ts = 0.0
        self._call_timestamps: list[float] = []

    def _throttle(self) -> None:
        now = time.time()
        # Curatam apelurile mai vechi de 1 ora
        self._call_timestamps = [t for t in self._call_timestamps if (now - t) < 3600.0]

        if len(self._call_timestamps) >= MAX_REQUESTS_PER_HOUR:
            raise RuntimeError(
                f"Limita de siguranta atinsa ({MAX_REQUESTS_PER_HOUR} interogari externe/ora catre legislatie.just.ro). "
                "Interogarile din cache-ul local SQLite continua sa functioneze normal."
            )

        calls_last_min = [t for t in self._call_timestamps if (now - t) < 60.0]
        if len(calls_last_min) >= MAX_REQUESTS_PER_MINUTE:
            wait_sec = max(1.0, 60.0 - (now - calls_last_min[0]))
            time.sleep(min(wait_sec, 10.0))

        elapsed = time.time() - self._last_call_ts
        if elapsed < MIN_REQUEST_INTERVAL_SEC:
            time.sleep(MIN_REQUEST_INTERVAL_SEC - elapsed)

        ts = time.time()
        self._last_call_ts = ts
        self._call_timestamps.append(ts)

    def _soap_post(self, soap_action: str, body_xml: str, timeout: float = 20.0) -> bytes:
        self._throttle()
        req = urllib.request.Request(
            SOAP_URL,
            data=body_xml.encode("utf-8"),
            headers={
                "Content-Type": "text/xml; charset=utf-8",
                "SOAPAction": f'"{soap_action}"',
                "User-Agent": "legislatie-ro-mcp/1.0 (Open-Source Official SOAP Client)",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as err:
            if err.code in (429, 502, 503, 504):
                time.sleep(3.0)
            raise

    def get_token(self, force_refresh: bool = False) -> str:
        if not force_refresh:
            cached = self.cache.get_token()
            if cached:
                return cached

        envelope = f"""<s:Envelope xmlns:s="{NS_SOAP}">
  <s:Body>
    <GetToken xmlns="{NS_TEMPURI}" />
  </s:Body>
</s:Envelope>"""
        raw = self._soap_post(SOAP_ACTION_TOKEN, envelope)
        root = ET.fromstring(raw)
        token_el = root.find(f".//{{{NS_TEMPURI}}}GetTokenResult")
        if token_el is None or not token_el.text:
            raise RuntimeError("Nu s-a putut obtine tokenul oficial de la legislatie.just.ro/apiws.")
        token = token_el.text.strip()
        self.cache.save_token(token)
        return token

    def search(
        self,
        search_an: str = "",
        search_numar: str = "",
        search_text: str = "",
        search_titlu: str = "",
        numar_pagina: int = 0,
        rezultate_pagina: int = 5,
    ) -> list[dict[str, Any]]:
        rezultate_pagina = max(0, min(rezultate_pagina, 30))
        cache_params = {
            "an": search_an.strip(),
            "numar": search_numar.strip(),
            "text": search_text.strip(),
            "titlu": search_titlu.strip(),
            "page": numar_pagina,
            "per_page": rezultate_pagina,
        }
        cached_res = self.cache.get_search_cache(cache_params)
        if cached_res is not None:
            return cached_res

        def _xml_opt(tag: str, val: str) -> str:
            v = val.strip()
            if not v:
                return f'<d4p1:{tag} i:nil="true" />'
            return f"<d4p1:{tag}>{html.escape(v)}</d4p1:{tag}>"

        for attempt in range(2):
            token = self.get_token(force_refresh=(attempt > 0))
            envelope = f"""<s:Envelope xmlns:s="{NS_SOAP}">
  <s:Body>
    <Search xmlns="{NS_TEMPURI}">
      <SearchModel xmlns:d4p1="{NS_DATA}" xmlns:i="{NS_XSI}">
        <d4p1:NumarPagina>{numar_pagina}</d4p1:NumarPagina>
        <d4p1:RezultatePagina>{rezultate_pagina}</d4p1:RezultatePagina>
        {_xml_opt("SearchAn", search_an)}
        {_xml_opt("SearchNumar", search_numar)}
        {_xml_opt("SearchText", search_text)}
        {_xml_opt("SearchTitlu", search_titlu)}
      </SearchModel>
      <tokenKey>{html.escape(token)}</tokenKey>
    </Search>
  </s:Body>
</s:Envelope>"""
            try:
                raw = self._soap_post(SOAP_ACTION_SEARCH, envelope, timeout=25.0)
                root = ET.fromstring(raw)
                legi_els = root.findall(f".//{{{NS_DATA}}}Legi")
                results: list[dict[str, Any]] = []
                for el in legi_els:
                    def _val(tag: str) -> str:
                        child = el.find(f"{{{NS_DATA}}}{tag}")
                        return (child.text or "").strip() if child is not None else ""

                    item = {
                        "tip_act": _val("TipAct"),
                        "numar": _val("Numar"),
                        "data_vigoare": _val("DataVigoare"),
                        "titlu": _val("Titlu"),
                        "emitent": _val("Emitent"),
                        "publicatie": _val("Publicatie"),
                        "link_html": _val("LinkHtml"),
                        "text": _val("Text"),
                    }
                    act_key = self.cache.save_act_and_articles(item)
                    item["act_key"] = act_key
                    results.append(item)

                if results or attempt == 1:
                    self.cache.set_search_cache(cache_params, results)
                    return results
            except urllib.error.HTTPError:
                if attempt == 1:
                    raise
        return []


# ============================================================================
# Rezolvare Inteligenta a Referintelor (ex: "OUG 57/2019", "Codul Muncii", "Legea 114/1996")
# ============================================================================

ACT_REF_RE = re.compile(
    r"(?i)\b(?:(legea|lege|oug|o\.u\.g\.|ordonanta de urgenta|og|o\.g\.|hg|h\.g\.|hotararea|ordinul|ordin|decizia|decizie|ril|hp)\s*)?"
    r"(?:nr\.\s*)?([0-9]{1,5})\s*(?:/|\s+din\s+)(?:[0-9]{1,2}[./][0-9]{1,2}[./])?((?:19|20)[0-9]{2})\b"
)


def normalize_tip_act(raw_prefix: str) -> str:
    p = strip_diacritics_lower(raw_prefix).replace(".", "")
    if p in ("oug", "ordonanta de urgenta"):
        return "ORDONANȚĂ DE URGENȚĂ"
    if p in ("og", "ordonanta"):
        return "ORDONANȚĂ"
    if p in ("hg", "hotararea", "hotarare"):
        return "HOTĂRÂRE"
    if p in ("legea", "lege"):
        return "LEGE"
    if p in ("ordinul", "ordin"):
        return "ORDIN"
    if p in ("decizia", "decizie", "ril", "hp"):
        return "DECIZIE"
    return ""


def parse_act_identifier(act_query: str) -> dict[str, str]:
    norm = strip_diacritics_lower(act_query)
    for alias, meta in ALIASURI_ACTE.items():
        if alias in norm:
            return {
                "doc_id": meta.get("doc_id", ""),
                "tip_act": meta.get("tip_act", ""),
                "numar": meta["numar"],
                "an": meta["an"],
                "titlu": meta.get("titlu", ""),
                "text": "",
            }

    m = ACT_REF_RE.search(norm)
    if m:
        return {
            "doc_id": "",
            "tip_act": normalize_tip_act(m.group(1) or ""),
            "numar": m.group(2),
            "an": m.group(3),
            "titlu": "",
            "text": "",
        }

    return {
        "doc_id": "",
        "tip_act": "",
        "numar": "",
        "an": "",
        "titlu": act_query.strip(),
        "text": "",
    }


def parse_article_numbers(articole_spec: str) -> list[str]:
    """
    Transforma specificatii precum '38, 39', 'art. 38-40', '11', '3^1' intr-o lista de numere de articol.
    """
    cleaned = re.sub(r"(?i)\b(articolul|articolele|art\.?)\b", " ", articole_spec)
    result: list[str] = []
    for part in re.split(r"[,;]+", cleaned):
        part = part.strip()
        if not part:
            continue
        range_m = re.match(r"^(\d+)\s*[-–..]+\s*(\d+)$", part)
        if range_m:
            start_n, end_n = int(range_m.group(1)), int(range_m.group(2))
            if start_n <= end_n and (end_n - start_n) <= 15:
                result.extend(str(n) for n in range(start_n, end_n + 1))
                continue
        tokens = re.findall(r"[0-9]+(?:\^[0-9]+)?|[IVXLCDM]+", part, flags=re.IGNORECASE)
        for tok in tokens:
            t_low = tok.lower()
            if t_low not in result:
                result.append(t_low)
    return result


# ============================================================================
# Implementarea celor 5 Unelte MCP (Tools)
# ============================================================================

class LegislatieMCPTools:
    def __init__(self) -> None:
        self.cache = LocalLegisCache()
        self.client = LegislatieJustRoClient(self.cache)

    def _find_best_act(
        self,
        act: str = "",
        numar: str = "",
        an: str = "",
        cuvinte_cheie_text: str = "",
    ) -> list[dict[str, Any]]:
        parsed = parse_act_identifier(act)
        doc_id = parsed.get("doc_id", "")
        expected_tip = parsed.get("tip_act", "")
        if act and not (numar or an):
            numar = parsed["numar"]
            an = parsed["an"]
            titlu = parsed["titlu"]
        else:
            titlu = parsed["titlu"] or act.strip()

        # Daca actul are ID canonic direct in legislatie.just.ro (ex: Coduri, OG 2/2001, Legea 114/1996, Legea 554/2004),
        # construim direct intrarea catre DetaliiDocument/{doc_id} pentru extragere 100% determinista din forma consolidata la zi!
        if doc_id and not cuvinte_cheie_text:
            link = f"https://legislatie.just.ro/Public/DetaliiDocument/{doc_id}"
            synthetic = {
                "act_key": doc_id,
                "tip_act": expected_tip or "ACT NORMATIV",
                "numar": numar,
                "data_vigoare": an,
                "titlu": f"{expected_tip or 'Act'} nr. {numar}/{an} ({titlu})",
                "emitent": "Parlamentul / Guvernul României",
                "publicatie": "Monitorul Oficial",
                "link_html": link,
                "text": "CONSOLIDATED_LINK",
            }
            self.cache.save_act_and_articles(synthetic)
            return [synthetic]

        # Cand cunoastem Numarul si Anul (ex: 2 / 2001), cautam direct dupa An + Numar (fara SearchTitlu,
        # deoarece SearchTitlu in SOAP este sensibil la cedila vs virgula) cu RezultatePagina=25
        # si filtram determinist in Python dupa TipAct (LEGE vs ORDONANTA vs OUG vs HG) si Titlu!
        if numar and an:
            results = self.client.search(
                search_an=an,
                search_numar=numar,
                search_titlu="",
                search_text=cuvinte_cheie_text,
                numar_pagina=0,
                rezultate_pagina=25,
            )
        else:
            results = self.client.search(
                search_an=an,
                search_numar=numar,
                search_titlu=titlu,
                search_text=cuvinte_cheie_text,
                numar_pagina=0,
                rezultate_pagina=10,
            )
            if not results and titlu:
                results = self.client.search(
                    search_an=an,
                    search_numar=numar,
                    search_titlu="",
                    search_text=titlu,
                    numar_pagina=0,
                    rezultate_pagina=10,
                )

        # Daca avem un sub-sir de titlu din alias (ex: "regimul juridic al contraventiilor"), filtram local fara diacritice
        if titlu and results and (numar and an):
            norm_t = strip_diacritics_lower(titlu)
            if not ACT_REF_RE.search(norm_t):
                title_matches = [
                    r for r in results if norm_t in strip_diacritics_lower(r.get("titlu", ""))
                ]
                if title_matches:
                    return title_matches

        # Daca utilizatorul a cerut explicit OG (si nu OUG/DECIZIE) sau LEGE, filtram prioritizand TipAct exact
        if expected_tip and results:
            norm_exp = strip_diacritics_lower(expected_tip)
            exact_matches = [
                r for r in results if strip_diacritics_lower(r.get("tip_act", "")) == norm_exp
            ]
            if exact_matches:
                return exact_matches
            # Daca pe pagina 0 nu era niciun act cu TipAct-ul cerut (ex: OG nr. 2 e pe pagina 1 dupa Decizii/Ordine),
            # cautam cu SearchTitlu=titlu sau pe pagina 1
            if titlu:
                by_title = self.client.search(
                    search_an=an,
                    search_numar=numar,
                    search_titlu=titlu,
                    search_text=cuvinte_cheie_text,
                    numar_pagina=0,
                    rezultate_pagina=10,
                )
                exact_by_title = [
                    r for r in by_title if strip_diacritics_lower(r.get("tip_act", "")) == norm_exp
                ]
                if exact_by_title:
                    return exact_by_title
            page1 = self.client.search(
                search_an=an,
                search_numar=numar,
                search_titlu="",
                search_text=cuvinte_cheie_text,
                numar_pagina=1,
                rezultate_pagina=25,
            )
            exact_p1 = [
                r for r in page1 if strip_diacritics_lower(r.get("tip_act", "")) == norm_exp
            ]
            if exact_p1:
                return exact_p1
        return results

    def cauta_acte_normative(
        self,
        interogare_sau_act: str = "",
        numar: str = "",
        an: str = "",
        cuvinte_in_text: str = "",
        limita: int = 5,
    ) -> dict[str, Any]:
        """
        Unealta 1: Cauta acte normative (Legi, OUG, OG, HG, Ordine, Decizii ICCJ RIL/HP, Decizii CCR).
        """
        parsed = parse_act_identifier(interogare_sau_act) if interogare_sau_act else {"numar": "", "an": "", "titlu": ""}
        s_numar = numar or parsed["numar"]
        s_an = an or parsed["an"]
        s_titlu = parsed["titlu"] if not (numar or an) else interogare_sau_act

        results = self.client.search(
            search_an=s_an,
            search_numar=s_numar,
            search_titlu=s_titlu if not (s_numar and s_an) else "",
            search_text=cuvinte_in_text,
            numar_pagina=0,
            rezultate_pagina=min(max(limita, 1), 10),
        )
        if not results and s_titlu:
            # Fallback: cautam termenii direct in textul actelor
            results = self.client.search(
                search_an=s_an,
                search_numar=s_numar,
                search_titlu="",
                search_text=f"{s_titlu} {cuvinte_in_text}".strip(),
                numar_pagina=0,
                rezultate_pagina=min(max(limita, 1), 10),
            )

        formatted: list[dict[str, Any]] = []
        for r in results:
            clean_txt = clean_soap_text(r.get("text", ""))
            formatted.append(
                {
                    "act_key": r.get("act_key"),
                    "tip_act": r.get("tip_act"),
                    "numar": r.get("numar"),
                    "data_vigoare": r.get("data_vigoare"),
                    "titlu": r.get("titlu"),
                    "emitent": r.get("emitent"),
                    "publicatie": r.get("publicatie"),
                    "link_oficial": r.get("link_html"),
                    "numar_caractere_text": len(clean_txt),
                    "previzualizare_inceput": clean_txt[:700] + ("..." if len(clean_txt) > 700 else ""),
                }
            )

        return {
            "total_gasite": len(formatted),
            "acte": formatted,
            "disclaimer": DISCLAIMER_LEGAL,
        }

    def _ensure_consolidated_articles(self, act_meta: dict[str, Any]) -> None:
        """
        Daca actul are un `link_html` oficial (ex: http://legislatie.just.ro/Public/DetaliiDocument/29779),
        preia o singura data pagina consolidata la zi si inlocuieste articolele din SQLite cu forma
        consolidata la zi (care include toate modificarile recente + notele .S_NTA/.S_PAR cu RIL/HP/CCR).
        """
        act_key = act_meta.get("act_key") or ""
        link = (act_meta.get("link_html") or "").strip()
        if not act_key or not link:
            return

        cur = self.cache.conn.execute(
            "SELECT COUNT(*) AS cnt FROM articles WHERE act_key = ? AND notes IS NOT NULL AND length(notes) > 0",
            (act_key,),
        )
        row = cur.fetchone()
        if row and row["cnt"] > 0:
            return

        https_link = re.sub(r"^http://", "https://", link)
        try:
            self.client._throttle()
            req = urllib.request.Request(
                https_link,
                headers={"User-Agent": "legislatie-ro-mcp/1.0 (Consolidated View Reader)"},
            )
            with urllib.request.urlopen(req, timeout=20.0) as resp:
                raw_html = resp.read().decode("utf-8", errors="replace")
            consolidated_arts = parse_articles_from_consolidated_html(raw_html)
            if consolidated_arts:
                with self.cache.conn:
                    self.cache.conn.execute("DELETE FROM articles WHERE act_key = ?", (act_key,))
                    self.cache.conn.executemany(
                        """
                        INSERT INTO articles (act_key, art_num, art_label, section_path, content, notes, ord_index)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        [
                            (
                                act_key,
                                a["art_num"],
                                a["art_label"],
                                a["section_path"],
                                a["content"],
                                a["notes"],
                                idx,
                            )
                            for idx, a in enumerate(consolidated_arts)
                        ],
                    )
        except Exception:
            pass

    def extrage_articole_din_act(
        self,
        act: str,
        articole: str,
        numar: str = "",
        an: str = "",
        include_vecini: bool = True,
    ) -> dict[str, Any]:
        """
        Unealta 2: Extrage textul verbatim al unuia sau mai multor articole dintr-un act normativ,
        impreuna cu articolele vecine (±1) si notele de modificare / RIL / HP / CCR.
        """
        req_nums = parse_article_numbers(articole)
        results = self._find_best_act(act=act, numar=numar, an=an)
        if not results:
            return {
                "eroare": f"Nu s-a gasit actul normativ '{act}' (numar={numar}, an={an}) in legislatie.just.ro.",
                "disclaimer": DISCLAIMER_LEGAL,
            }

        # Alegem actul principal (cel cu textul cel mai complet, evitand actele scurte de modificare daca se cauta legea de baza)
        best = max(results, key=lambda x: len(x.get("text") or ""))
        self._ensure_consolidated_articles(best)
        act_key = best["act_key"]

        cur = self.cache.conn.execute(
            "SELECT art_num, art_label, section_path, content, notes, ord_index FROM articles WHERE act_key = ? ORDER BY ord_index ASC",
            (act_key,),
        )
        all_rows = cur.fetchall()

        matched_indices: set[int] = set()
        for idx, row in enumerate(all_rows):
            if row["art_num"].lower() in req_nums:
                matched_indices.add(idx)
                if include_vecini:
                    if idx - 1 >= 0:
                        matched_indices.add(idx - 1)
                    if idx + 1 < len(all_rows):
                        matched_indices.add(idx + 1)

        extracted: list[dict[str, Any]] = []
        for idx in sorted(matched_indices):
            r = all_rows[idx]
            extracted.append(
                {
                    "articol": r["art_label"],
                    "numar_articol": r["art_num"],
                    "este_articol_cerut_direct": r["art_num"].lower() in req_nums,
                    "sectiune_capitol": r["section_path"],
                    "text_oficial": r["content"],
                    "note_modificari_ril_ccr": r["notes"] or None,
                }
            )

        # Daca actul din prima pagina de rezultate nu continea acel articol (ex: mai multe acte cu acelasi numar),
        # cautam direct in API cu SearchText="Articolul X" sau numarul articolului
        if not extracted and req_nums:
            parsed_id = parse_act_identifier(act)
            fallback_res = self.client.search(
                search_an=an or parsed_id["an"],
                search_numar=numar or parsed_id["numar"],
                search_text=f"Articolul {req_nums[0]}",
                rezultate_pagina=5,
            )
            if fallback_res:
                best = max(fallback_res, key=lambda x: len(x.get("text") or ""))
                act_key = best["act_key"]
                cur = self.cache.conn.execute(
                    "SELECT art_num, art_label, section_path, content, notes, ord_index FROM articles WHERE act_key = ? ORDER BY ord_index ASC",
                    (act_key,),
                )
                for r in cur.fetchall():
                    if r["art_num"].lower() in req_nums:
                        extracted.append(
                            {
                                "articol": r["art_label"],
                                "numar_articol": r["art_num"],
                                "este_articol_cerut_direct": True,
                                "sectiune_capitol": r["section_path"],
                                "text_oficial": r["content"],
                                "note_modificari_ril_ccr": r["notes"] or None,
                            }
                        )

        return {
            "act": {
                "tip_act": best.get("tip_act"),
                "numar": best.get("numar"),
                "data_vigoare": best.get("data_vigoare"),
                "titlu": best.get("titlu"),
                "emitent": best.get("emitent"),
                "publicatie": best.get("publicatie"),
                "link_oficial": best.get("link_html"),
            },
            "articole_cerute": req_nums,
            "articole_extrase": extracted,
            "disclaimer": DISCLAIMER_LEGAL,
        }

    def cauta_in_interiorul_actului(
        self,
        cuvinte_cheie: str,
        act: str = "",
        numar: str = "",
        an: str = "",
        limita_articole: int = 8,
    ) -> dict[str, Any]:
        """
        Unealta 3: Cauta cuvinte-cheie sau concepte juridice in interiorul unui act normativ
        (sau in toata legislatia daca actul nu este specificat) si returneaza articolele exacte.
        """
        results = self._find_best_act(
            act=act,
            numar=numar,
            an=an,
            cuvinte_cheie_text=cuvinte_cheie if not act else "",
        )
        if not results:
            return {
                "eroare": f"Nu s-au gasit acte pentru '{act}' / '{cuvinte_cheie}'.",
                "disclaimer": DISCLAIMER_LEGAL,
            }

        query_terms = [
            strip_diacritics_lower(t)
            for t in re.split(r"\s+", cuvinte_cheie.strip())
            if len(t.strip()) >= 2
        ]

        scored_hits: list[tuple[int, dict[str, Any], sqlite3.Row]] = []
        for r in results:
            act_key = r["act_key"]
            cur = self.cache.conn.execute(
                "SELECT art_num, art_label, section_path, content, notes FROM articles WHERE act_key = ? ORDER BY ord_index ASC",
                (act_key,),
            )
            for row in cur.fetchall():
                norm_content = strip_diacritics_lower(row["content"])
                score = sum(norm_content.count(term) for term in query_terms if term in norm_content)
                distinct_matched = sum(1 for term in query_terms if term in norm_content)
                if distinct_matched > 0:
                    total_score = distinct_matched * 100 + score
                    scored_hits.append((total_score, r, row))

        scored_hits.sort(key=lambda x: x[0], reverse=True)
        top_hits = scored_hits[: max(1, min(limita_articole, 15))]

        fragmente: list[dict[str, Any]] = []
        for score, act_meta, row in top_hits:
            fragmente.append(
                {
                    "act": f"{act_meta.get('tip_act')} nr. {act_meta.get('numar')} ({act_meta.get('data_vigoare')})",
                    "titlu_act": act_meta.get("titlu"),
                    "link_oficial": act_meta.get("link_html"),
                    "articol": row["art_label"],
                    "sectiune_capitol": row["section_path"],
                    "text_oficial": row["content"][:4000],
                    "note_modificari_ril_ccr": row["notes"] or None,
                }
            )

        return {
            "cuvinte_cautate": cuvinte_cheie,
            "total_articole_potrivite": len(scored_hits),
            "rezultate": fragmente,
            "disclaimer": DISCLAIMER_LEGAL,
        }

    def exploreaza_cuprinsul_actului(
        self,
        act: str,
        numar: str = "",
        an: str = "",
        filtru_sectiune: str = "",
    ) -> dict[str, Any]:
        """
        Unealta 4: Returneaza cuprinsul pe Titluri / Capitole / Sectiuni si intervalele de articole
        ale unui act normativ (util pentru Coduri si legi ample).
        """
        results = self._find_best_act(act=act, numar=numar, an=an)
        if not results:
            return {
                "eroare": f"Nu s-a gasit actul '{act}'.",
                "disclaimer": DISCLAIMER_LEGAL,
            }
        best = max(results, key=lambda x: len(x.get("text") or ""))
        outline = extract_outline_from_text(best.get("text") or "")
        if filtru_sectiune:
            f_norm = strip_diacritics_lower(filtru_sectiune)
            outline = [
                item for item in outline if f_norm in strip_diacritics_lower(item["sectiune"])
            ]

        return {
            "act": {
                "tip_act": best.get("tip_act"),
                "numar": best.get("numar"),
                "data_vigoare": best.get("data_vigoare"),
                "titlu": best.get("titlu"),
                "link_oficial": best.get("link_html"),
            },
            "numar_sectiuni": len(outline),
            "cuprins": outline[:80],
            "disclaimer": DISCLAIMER_LEGAL,
        }

    def cauta_legislatie_ue(
        self,
        celex: str = "32016R0679",
        articol_sau_termen: str = "",
    ) -> dict[str, Any]:
        """
        Unealta 5: Preia din EUR-Lex (in limba romana) textul unui Regulament, Directiva sau Decizie UE
        dupa codul CELEX (ex: 32016R0679 pentru GDPR).
        """
        celex_clean = re.sub(r"[^0-9A-Za-z]", "", celex.strip()).upper()
        url = f"https://eur-lex.europa.eu/legal-content/RO/TXT/HTML/?uri=CELEX:{celex_clean}"
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "legislatie-ro-mcp/1.0 (EUR-Lex Official RO Connector)",
                "Accept-Language": "ro-RO,ro;q=0.9",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=20.0) as resp:
                raw_html = resp.read().decode("utf-8", errors="replace")
        except Exception as exc:
            return {
                "celex": celex_clean,
                "link_oficial_eurlex": url,
                "eroare": f"Nu s-a putut prelua documentul EUR-Lex ({exc}). Puteti consulta direct linkul oficial.",
            }

        clean_txt = clean_soap_text(raw_html)
        if articol_sau_termen:
            norm_q = strip_diacritics_lower(articol_sau_termen)
            paragraphs = [p.strip() for p in clean_txt.split("\n\n") if p.strip()]
            matches = [
                p for p in paragraphs if norm_q in strip_diacritics_lower(p)
            ]
            excerpt = "\n\n---\n\n".join(matches[:8]) if matches else clean_txt[:4000]
        else:
            excerpt = clean_txt[:4000]

        return {
            "celex": celex_clean,
            "link_oficial_eurlex": url,
            "termen_filtrat": articol_sau_termen or None,
            "extrase_ro": excerpt,
            "sursa": "EUR-Lex (Oficiul pentru Publicatii al Uniunii Europene — text in limba romana)",
        }


# ============================================================================
# Server MCP Standard (JSON-RPC 2.0 peste stdio — zero dependente externe)
# ============================================================================

SERVER_INSTRUCTIONS = (
    "Esti conectat la `legislatie-ro-mcp`, conectorul oficial catre baza de date legislativa "
    "consolidata a Romaniei (legislatie.just.ro — Ministerul Justitiei) si EUR-Lex (UE).\n"
    "REGULI OBLIGATORII DE ANCORARE:\n"
    "1. Cand utilizatorul incarca un document (contract, HCL, cerere de chemare in judecata, "
    "decizie, proces-verbal, carte funciara) sau pune o intrebare juridica, NU cita din memorie "
    "textul articolelor de lege si NU presupune daca o lege este in vigoare sau abrogata.\n"
    "2. Identifica din documentul utilizatorului sau din intrebare actele normative incidente "
    "(Legi, OUG, OG, HG, Ordine, RIL/HP ICCJ, Decizii CCR) si apeleaza `extrage_articole_din_act` "
    "sau `cauta_in_interiorul_actului` pentru a obtine textul oficial consolidat la zi.\n"
    "3. CONFIDENTIALITATE / GDPR: Nu trimite niciodata in parametrii uneltelor MCP nume de persoane, "
    "CNP-uri, adrese sau date personale din documentul utilizatorului. Trimite exclusiv numere de "
    "acte normative, numere de articole si termeni juridici generici.\n"
    "4. In raspunsul final catre utilizator, citeaza exact articolele verificate si include intotdeauna "
    "linkul oficial (`link_oficial`) catre legislatie.just.ro."
)

MCP_TOOLS_SCHEMA: list[dict[str, Any]] = [
    {
        "name": "cauta_acte_normative",
        "description": (
            "Cauta in baza oficiala legislatie.just.ro acte normative romanesti actualizate la zi: "
            "Legi, Coduri, OUG, OG, HG, Ordine de ministru, Decizii ICCJ (RIL / HP) si Decizii CCR. "
            "Poti folosi atat numarul/anul (ex: numar='57', an='2019'), cat si denumirea uzuala "
            "(ex: interogare_sau_act='Codul administrativ', 'Codul muncii', 'Legea 114/1996', "
            "'Legea 554/2004') sau cuvinte-cheie din textul actului."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "interogare_sau_act": {
                    "type": "string",
                    "description": "Denumirea actului sau aliasul (ex: 'Codul administrativ', 'Legea 114/1996', 'OUG 57/2019', 'Decizie ICCJ').",
                },
                "numar": {
                    "type": "string",
                    "description": "Numarul actului normativ (optional, ex: '114', '57', '554').",
                },
                "an": {
                    "type": "string",
                    "description": "Anul adoptarii actului normativ (optional, ex: '1996', '2019', '2004').",
                },
                "cuvinte_in_text": {
                    "type": "string",
                    "description": "Cuvinte-cheie cautate in continutul actului (optional, ex: 'locuinta sociala', 'tardivitate concurs').",
                },
                "limita": {
                    "type": "integer",
                    "description": "Numarul maxim de acte returnate (1-10, implicit 5).",
                    "default": 5,
                },
            },
        },
    },
    {
        "name": "extrage_articole_din_act",
        "description": (
            "Extrage textul oficial exact, consolidat la zi, al unuia sau mai multor articole "
            "dintr-o Lege, OUG, HG sau Cod din Romania (legislatie.just.ro), impreuna cu articolele "
            "vecine (±1 articol pentru context complet) si notele oficiale de modificare, Decizii CCR "
            "sau RIL/HP ICCJ. Foloseste aceasta unealta inainte de a cita orice articol!"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "act": {
                    "type": "string",
                    "description": "Actul normativ (ex: 'Legea 114/1996', 'OUG 57/2019', 'Codul administrativ', 'Legea 554/2004').",
                },
                "articole": {
                    "type": "string",
                    "description": "Articolul sau articolele dorite (ex: '38, 39', '11', '292, 354, 356', '582').",
                },
                "numar": {
                    "type": "string",
                    "description": "Numarul actului (optional daca este deja in parametrul 'act').",
                },
                "an": {
                    "type": "string",
                    "description": "Anul actului (optional daca este deja in parametrul 'act').",
                },
                "include_vecini": {
                    "type": "boolean",
                    "description": "Daca este True (implicit), returneaza si articolul anterior/urmator pentru a nu rata exceptiile.",
                    "default": True,
                },
            },
            "required": ["act", "articole"],
        },
    },
    {
        "name": "cauta_in_interiorul_actului",
        "description": (
            "Cauta cuvinte-cheie sau concepte juridice (ex: 'domeniu public locuinta sociala', "
            "'suspendare de drept', 'termen de decadere', 'calitate procesuala', 'dispozitii tranzitorii') "
            "direct in articolele unui act normativ (sau in legislatia generala) si returneaza "
            "articolele exacte in care apar acei termeni."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "cuvinte_cheie": {
                    "type": "string",
                    "description": "Termenii juridici sau conceptele cautate (fara date personale din documentul utilizatorului).",
                },
                "act": {
                    "type": "string",
                    "description": "Actul normativ in care se cauta (optional, ex: 'Codul administrativ', 'Legea 554/2004').",
                },
                "numar": {
                    "type": "string",
                    "description": "Numarul actului (optional).",
                },
                "an": {
                    "type": "string",
                    "description": "Anul actului (optional).",
                },
                "limita_articole": {
                    "type": "integer",
                    "description": "Numarul maxim de articole relevante returnate (implicit 8).",
                    "default": 8,
                },
            },
            "required": ["cuvinte_cheie"],
        },
    },
    {
        "name": "exploreaza_cuprinsul_actului",
        "description": (
            "Returneaza structura pe Titluri, Capitole si Sectiuni a unui act normativ amplu sau Cod, "
            "impreuna cu intervalele de articole aferente fiecarei sectiuni."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "act": {
                    "type": "string",
                    "description": "Denumirea actului sau numarul/anul (ex: 'OUG 57/2019', 'Codul civil', 'Legea 114/1996').",
                },
                "numar": {
                    "type": "string",
                    "description": "Numarul actului (optional).",
                },
                "an": {
                    "type": "string",
                    "description": "Anul actului (optional).",
                },
                "filtru_sectiune": {
                    "type": "string",
                    "description": "Filtru optional dupa numele capitolului/sectiunii (ex: 'tranzitorii', 'patrimoniu', 'sanctiuni').",
                },
            },
            "required": ["act"],
        },
    },
    {
        "name": "cauta_legislatie_ue",
        "description": (
            "Preia in limba romana acte normative si jurisprudenta UE din portalul oficial EUR-Lex "
            "dupa codul CELEX (ex: '32016R0679' pentru Regulamentul GDPR) si filtreaza optional dupa articol sau termen."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "celex": {
                    "type": "string",
                    "description": "Codul CELEX al actului UE (ex: '32016R0679' pt. GDPR, '31993L0013' pt. clauze abuzive).",
                },
                "articol_sau_termen": {
                    "type": "string",
                    "description": "Termen sau articol cautat in interiorul actului UE (ex: 'Articolul 6', 'dreptul la stergere').",
                },
            },
            "required": ["celex"],
        },
    },
]


def handle_mcp_request(tools_impl: LegislatieMCPTools, msg: dict[str, Any]) -> dict[str, Any] | None:
    method = msg.get("method")
    msg_id = msg.get("id")
    params = msg.get("params") or {}

    # Notificarile JSON-RPC fara id nu primesc raspuns
    if msg_id is None:
        return None

    if method == "initialize":
        client_proto = params.get("protocolVersion", "2024-11-05")
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": client_proto,
                "capabilities": {
                    "tools": {"listChanged": False},
                },
                "serverInfo": {
                    "name": "legislatie-ro-mcp",
                    "version": "1.0.0",
                },
                "instructions": SERVER_INSTRUCTIONS,
            },
        }

    if method == "ping":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {}}

    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {"tools": MCP_TOOLS_SCHEMA},
        }

    if method == "tools/call":
        tool_name = params.get("name")
        args = params.get("arguments") or {}
        try:
            if tool_name == "cauta_acte_normative":
                res = tools_impl.cauta_acte_normative(
                    interogare_sau_act=str(args.get("interogare_sau_act", "")),
                    numar=str(args.get("numar", "")),
                    an=str(args.get("an", "")),
                    cuvinte_in_text=str(args.get("cuvinte_in_text", "")),
                    limita=int(args.get("limita", 5)),
                )
            elif tool_name == "extrage_articole_din_act":
                res = tools_impl.extrage_articole_din_act(
                    act=str(args.get("act", "")),
                    articole=str(args.get("articole", "")),
                    numar=str(args.get("numar", "")),
                    an=str(args.get("an", "")),
                    include_vecini=bool(args.get("include_vecini", True)),
                )
            elif tool_name == "cauta_in_interiorul_actului":
                res = tools_impl.cauta_in_interiorul_actului(
                    cuvinte_cheie=str(args.get("cuvinte_cheie", "")),
                    act=str(args.get("act", "")),
                    numar=str(args.get("numar", "")),
                    an=str(args.get("an", "")),
                    limita_articole=int(args.get("limita_articole", 8)),
                )
            elif tool_name == "exploreaza_cuprinsul_actului":
                res = tools_impl.exploreaza_cuprinsul_actului(
                    act=str(args.get("act", "")),
                    numar=str(args.get("numar", "")),
                    an=str(args.get("an", "")),
                    filtru_sectiune=str(args.get("filtru_sectiune", "")),
                )
            elif tool_name == "cauta_legislatie_ue":
                res = tools_impl.cauta_legislatie_ue(
                    celex=str(args.get("celex", "32016R0679")),
                    articol_sau_termen=str(args.get("articol_sau_termen", "")),
                )
            else:
                return {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "error": {"code": -32601, "message": f"Unealta necunoscuta: {tool_name}"},
                }

            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(res, ensure_ascii=False, indent=2),
                        }
                    ],
                    "isError": False,
                },
            }
        except Exception as exc:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(
                                {"eroare_executie": str(exc), "disclaimer": DISCLAIMER_LEGAL},
                                ensure_ascii=False,
                            ),
                        }
                    ],
                    "isError": True,
                },
            }

    return {
        "jsonrpc": "2.0",
        "id": msg_id,
        "error": {"code": -32601, "message": f"Metoda nesuportata: {method}"},
    }


def run_stdio_server() -> None:
    tools_impl = LegislatieMCPTools()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        resp = handle_mcp_request(tools_impl, msg)
        if resp is not None:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()


def run_self_test() -> None:
    print("=== Testare legislatie-ro-mcp (API Oficial SOAP legislatie.just.ro) ===")
    tools = LegislatieMCPTools()

    print("\n1. Testam Art. 38 si Art. 39 din Legea locuintei nr. 114/1996 (cazul din MCP/examples):")
    res1 = tools.extrage_articole_din_act(act="Legea 114/1996", articole="38, 39", include_vecini=False)
    print(json.dumps(res1, ensure_ascii=False, indent=2)[:2500])

    print("\n2. Testam Art. 11 din Legea contenciosului administrativ nr. 554/2004 (exceptia tardivitatii):")
    res2 = tools.extrage_articole_din_act(act="Legea 554/2004", articole="11", include_vecini=False)
    print(json.dumps(res2, ensure_ascii=False, indent=2)[:2500])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Server MCP pentru Legislatia Consolidata a Romaniei")
    parser.add_argument("--self-test", action="store_true", help="Ruleaza un test live pe API-ul oficial legislatie.just.ro")
    args = parser.parse_args()

    if args.self_test:
        run_self_test()
    else:
        run_stdio_server()
