#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sugarcube Corner — Servidor Full-Stack Seguro (Python ThreadingHTTPServer + SQLite Relacional)
- Isolamento estrito de arquivos estáticos em public/ e uploads/
- Autenticação server-side com hashlib.scrypt + Cookie HttpOnly assinado via HMAC-SHA256
- Tabelas SQLite relacionais com incrementos atômicos (reações, votos, sugestões)
- Rate limit por IP, validação de magic bytes no upload e backups automáticos do banco
- Injeção Server-Side de SEO (Title, Meta Description, Open Graph, Canonical e JSON-LD) para rotas reais
"""

import base64
import hashlib
import hmac
import html
import json
import mimetypes
import os
import re
import secrets
import shutil
import sqlite3
import sys
import threading
import time
import unicodedata
import urllib.parse
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
DATA_DIR = BASE_DIR / "data"
BACKUP_DIR = DATA_DIR / "backups"
UPLOADS_DIR = BASE_DIR / "uploads"

DB_PATH = DATA_DIR / "sugarcube.db"
SEED_PATH = DATA_DIR / "seed.json"
SECRET_KEY_PATH = DATA_DIR / "session_secret.key"
INITIAL_CREDENTIALS_PATH = DATA_DIR / "admin_credentials_local.txt"

PUBLIC_DIR.mkdir(exist_ok=True)
DATA_DIR.mkdir(exist_ok=True)
BACKUP_DIR.mkdir(exist_ok=True)
UPLOADS_DIR.mkdir(exist_ok=True)

MAX_JSON_BODY = 128 * 1024        # 128 KB para payloads JSON
MAX_UPLOAD_BODY = 5 * 1024 * 1024 # 5 MB para upload de fotos no Admin
SESSION_TTL_SECONDS = 60 * 60 * 12 # 12 horas

# URL canônica para Sitemap e Open Graph (em produção, defina SUGARCUBE_SITE_URL=https://seudominio.com.br)
SITE_BASE_URL = os.environ.get("SUGARCUBE_SITE_URL", "").rstrip("/")


def get_secret_key() -> bytes:
    env_secret = os.environ.get("SUGARCUBE_SECRET_KEY")
    if env_secret:
        return env_secret.encode("utf-8")
    if SECRET_KEY_PATH.exists():
        return SECRET_KEY_PATH.read_bytes()
    key = secrets.token_bytes(32)
    SECRET_KEY_PATH.write_bytes(key)
    return key


SECRET_KEY = get_secret_key()


def slugify(text: str) -> str:
    norm = unicodedata.normalize("NFD", str(text or ""))
    clean = "".join(ch for ch in norm if unicodedata.category(ch) != "Mn")
    slug = re.sub(r"[^a-z0-9]+", "-", clean.lower()).strip("-")
    return slug or "item"


def hash_password_scrypt(password: str, salt: bytes = None) -> tuple[str, str]:
    if salt is None:
        salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=16384,
        r=8,
        p=1,
        dklen=64
    )
    return salt.hex(), derived.hex()


def verify_password_scrypt(password: str, salt_hex: str, hash_hex: str) -> bool:
    try:
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=16384,
            r=8,
            p=1,
            dklen=64
        )
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def create_session_token(username: str) -> str:
    exp = int(time.time()) + SESSION_TTL_SECONDS
    payload = f"{username}|{exp}"
    sig = hmac.new(SECRET_KEY, payload.encode("utf-8"), hashlib.sha256).hexdigest()
    raw = f"{payload}|{sig}".encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def verify_session_token(token: str) -> str | None:
    if not token:
        return None
    try:
        decoded = base64.urlsafe_b64decode(token.encode("ascii")).decode("utf-8")
        username, exp_str, sig = decoded.split("|", 2)
        payload = f"{username}|{exp_str}"
        expected_sig = hmac.new(SECRET_KEY, payload.encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected_sig):
            return None
        if int(exp_str) < int(time.time()):
            return None
        return username
    except Exception:
        return None


# Rate Limiter em memória por IP (protegido por Lock)
_rate_lock = threading.Lock()
_rate_buckets: dict[str, list[float]] = {}


def check_rate_limit(bucket_key: str, max_requests: int, window_seconds: int) -> bool:
    now = time.time()
    with _rate_lock:
        timestamps = _rate_buckets.get(bucket_key, [])
        timestamps = [t for t in timestamps if now - t < window_seconds]
        if len(timestamps) >= max_requests:
            _rate_buckets[bucket_key] = timestamps
            return False
        timestamps.append(now)
        _rate_buckets[bucket_key] = timestamps
        return True


def get_db():
    conn = sqlite3.connect(str(DB_PATH), timeout=15.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def backup_database():
    """Cria backup seguro do banco SQLite em data/backups/ mantendo os 10 mais recentes."""
    if not DB_PATH.exists():
        return
    try:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dest_path = BACKUP_DIR / f"sugarcube-{stamp}.db"
        src_conn = sqlite3.connect(str(DB_PATH))
        dst_conn = sqlite3.connect(str(dest_path))
        with dst_conn:
            src_conn.backup(dst_conn)
        dst_conn.close()
        src_conn.close()

        backups = sorted(BACKUP_DIR.glob("sugarcube-*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old_b in backups[10:]:
            try:
                old_b.unlink()
            except Exception:
                pass
    except Exception as e:
        print(f"[Backup Warning] Falha ao criar backup: {e}", flush=True)


def init_db(reset_to_clean=False, new_admin_password=None):
    conn = get_db()
    cur = conn.cursor()

    if reset_to_clean:
        backup_database()
        cur.executescript("""
            DROP TABLE IF EXISTS cakes;
            DROP TABLE IF EXISTS bakeries;
            DROP TABLE IF EXISTS upcoming_bakeries;
            DROP TABLE IF EXISTS public_suggestions;
            DROP TABLE IF EXISTS visitor_rate_log;
            DROP TABLE IF EXISTS settings;
            DROP TABLE IF EXISTS kv_store;
        """)

    # Remover tabela legada kv_store caso exista de versão anterior
    cur.execute("DROP TABLE IF EXISTS kv_store")

    cur.executescript("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS admin_auth (
            username TEXT PRIMARY KEY,
            salt_hex TEXT NOT NULL,
            hash_hex TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bakeries (
            id TEXT PRIMARY KEY,
            slug TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            neighborhood TEXT NOT NULL,
            address TEXT NOT NULL,
            lat REAL NOT NULL DEFAULT -12.2545,
            lng REAL NOT NULL DEFAULT -38.9550,
            instagram TEXT NOT NULL DEFAULT '',
            whatsapp TEXT NOT NULL DEFAULT '',
            opening_hours TEXT NOT NULL DEFAULT '',
            price_range TEXT NOT NULL DEFAULT '$$',
            cover_photo TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            is_featured_partner INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS cakes (
            id TEXT PRIMARY KEY,
            bakery_id TEXT NOT NULL,
            slug TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'Fatia de Vitrine',
            flavor_type TEXT NOT NULL DEFAULT '',
            photos_json TEXT NOT NULL DEFAULT '[]',
            score_flavor REAL NOT NULL DEFAULT 0,
            score_dough REAL NOT NULL DEFAULT 0,
            score_texture REAL NOT NULL DEFAULT 0,
            score_filling REAL NOT NULL DEFAULT 0,
            kai_verdict TEXT NOT NULL DEFAULT '',
            sensory_notes_json TEXT NOT NULL DEFAULT '{}',
            approx_price REAL NOT NULL DEFAULT 0,
            visited_at TEXT NOT NULL,
            reevaluated_at TEXT,
            reevaluation_note TEXT NOT NULL DEFAULT '',
            edition_year INTEGER NOT NULL DEFAULT 2026,
            react_water INTEGER NOT NULL DEFAULT 0,
            react_agree INTEGER NOT NULL DEFAULT 0,
            react_try INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            FOREIGN KEY (bakery_id) REFERENCES bakeries(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS upcoming_bakeries (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            neighborhood TEXT NOT NULL,
            specialty TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            votes INTEGER NOT NULL DEFAULT 1,
            planned_month TEXT NOT NULL DEFAULT 'Em breve'
        );

        CREATE TABLE IF NOT EXISTS public_suggestions (
            id TEXT PRIMARY KEY,
            bakery_name TEXT NOT NULL,
            neighborhood TEXT NOT NULL,
            cake_suggested TEXT NOT NULL,
            submitted_by TEXT NOT NULL DEFAULT 'Visitante',
            comment TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
        );

        CREATE TABLE IF NOT EXISTS visitor_rate_log (
            actor_hash TEXT NOT NULL,
            action_key TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (actor_hash, action_key)
        );
    """)

    # Inicializar settings se não existir
    cur.execute("SELECT value FROM settings WHERE key = 'site_settings'")
    if cur.fetchone() is None:
        default_settings = {}
        if SEED_PATH.exists():
            try:
                seed_obj = json.loads(SEED_PATH.read_text(encoding="utf-8"))
                default_settings = seed_obj.get("settings", {})
            except Exception:
                pass
        # Garantir que nenhuma chave de senha vá para settings
        default_settings.pop("adminPassHash", None)
        default_settings.pop("adminUser", None)
        cur.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?)",
            ("site_settings", json.dumps(default_settings, ensure_ascii=False))
        )

    # Semear confeitarias, bolos e em-breve de data/seed.json caso o banco esteja vazio (ex: CI / GitHub Actions)
    cur.execute("SELECT COUNT(*) as cnt FROM bakeries")
    bak_cnt = cur.fetchone()["cnt"]
    if bak_cnt == 0 and not reset_to_clean and SEED_PATH.exists():
        try:
            seed_obj = json.loads(SEED_PATH.read_text(encoding="utf-8"))
            today = time.strftime("%Y-%m-%d")
            for b in seed_obj.get("bakeries", []):
                cur.execute(
                    """INSERT OR IGNORE INTO bakeries
                       (id, slug, name, neighborhood, address, lat, lng, instagram, whatsapp,
                        opening_hours, price_range, cover_photo, description, is_featured_partner, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        b["id"], b["slug"], b["name"], b["neighborhood"], b["address"],
                        float(b.get("lat", -12.2545)), float(b.get("lng", -38.9550)),
                        b.get("instagram", ""), b.get("whatsapp", ""), b.get("openingHours", ""),
                        b.get("priceRange", "$$"), b.get("coverPhoto", "/assets/og-sugarcube.svg"),
                        b.get("description", ""), 1 if b.get("isFeaturedPartner") else 0, today
                    )
                )
            for c in seed_obj.get("cakes", []):
                rx = c.get("reactions", {})
                cur.execute(
                    """INSERT OR IGNORE INTO cakes
                       (id, bakery_id, slug, name, category, flavor_type, photos_json,
                        score_flavor, score_dough, score_texture, score_filling, kai_verdict,
                        sensory_notes_json, approx_price, visited_at, reevaluated_at,
                        reevaluation_note, edition_year, react_water, react_agree, react_try, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        c["id"], c["bakeryId"], c["slug"], c["name"],
                        c.get("category", "Fatia de Vitrine"), c.get("flavorType", "Especial"),
                        json.dumps(c.get("photos", ["/assets/og-sugarcube.svg"]), ensure_ascii=False),
                        float(c.get("scoreFlavor", 0)), float(c.get("scoreDough", 0)),
                        float(c.get("scoreTexture", 0)), float(c.get("scoreFilling", 0)),
                        c.get("kaiVerdict", ""), json.dumps(c.get("sensoryNotes", {}), ensure_ascii=False),
                        float(c.get("approxPrice", 0)), c.get("visitedAt", today),
                        c.get("reevaluatedAt"), c.get("reevaluationNote", ""),
                        int(c.get("editionYear", 2026)),
                        int(rx.get("waterInMouth", 0)), int(rx.get("agreeWithKai", 0)), int(rx.get("wantToTry", 0)),
                        today
                    )
                )
            for u in seed_obj.get("upcomingBakeries", []):
                cur.execute(
                    """INSERT OR IGNORE INTO upcoming_bakeries
                       (id, name, neighborhood, specialty, reason, votes, planned_month)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (
                        u["id"], u["name"], u["neighborhood"],
                        u.get("specialty", ""), u.get("reason", ""),
                        int(u.get("votes", 1)), u.get("plannedMonth", "Em breve")
                    )
                )
        except Exception as e:
            print(f"[WARN] Falha ao importar seed inicial: {e}")

    # Inicializar credencial de admin com hashlib.scrypt
    cur.execute("SELECT username FROM admin_auth WHERE username = 'kai'")
    existing_admin = cur.fetchone()
    if existing_admin is None or new_admin_password:
        raw_pass = (
            new_admin_password
            or os.environ.get("SUGARCUBE_ADMIN_PASSWORD")
            or secrets.token_urlsafe(10)
        )
        salt_hex, hash_hex = hash_password_scrypt(raw_pass)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        cur.execute(
            "INSERT OR REPLACE INTO admin_auth (username, salt_hex, hash_hex, updated_at) VALUES (?, ?, ?, ?)",
            ("kai", salt_hex, hash_hex, now)
        )
        INITIAL_CREDENTIALS_PATH.write_text(
            f"=== CREDENCIAIS LOCAIS DO PAINEL ADMIN (NÃO COMPARTILHAR) ===\n"
            f"URL do Painel: http://localhost:8080/admin\n"
            f"Login: kai\n"
            f"Senha: {raw_pass}\n"
            f"Gerado em: {now}\n"
            f"Nota: Este arquivo fica em data/ (fora da pasta public/) e nunca é servido na web.\n",
            encoding="utf-8"
        )

    conn.commit()
    conn.close()
    sync_static_snapshot()


def ensure_unique_slug(conn, table: str, base_slug: str, exclude_id: str = None) -> str:
    candidate = base_slug
    counter = 2
    cur = conn.cursor()
    while True:
        if exclude_id:
            cur.execute(f"SELECT id FROM {table} WHERE slug = ? AND id != ?", (candidate, exclude_id))
        else:
            cur.execute(f"SELECT id FROM {table} WHERE slug = ?", (candidate,))
        if cur.fetchone() is None:
            return candidate
        candidate = f"{base_slug}-{counter}"
        counter += 1


def compute_cake_score(cake_row_or_dict: dict, weights: dict) -> float:
    w_f = float(weights.get("flavor", 25))
    w_d = float(weights.get("dough", 25))
    w_t = float(weights.get("texture", 25))
    w_l = float(weights.get("filling", 25))
    total_w = (w_f + w_d + w_t + w_l) or 100.0

    s_f = float(cake_row_or_dict.get("scoreFlavor", cake_row_or_dict.get("score_flavor", 0)))
    s_d = float(cake_row_or_dict.get("scoreDough", cake_row_or_dict.get("score_dough", 0)))
    s_t = float(cake_row_or_dict.get("scoreTexture", cake_row_or_dict.get("score_texture", 0)))
    s_l = float(cake_row_or_dict.get("scoreFilling", cake_row_or_dict.get("score_filling", 0)))

    weighted = (s_f * w_f + s_d * w_d + s_t * w_t + s_l * w_l) / total_w
    # Arredondado a 1 casa decimal para consistência total entre exibição e selo
    return round(weighted, 1)


def get_public_data_payload() -> dict:
    conn = get_db()
    cur = conn.cursor()

    cur.execute("SELECT value FROM settings WHERE key = 'site_settings'")
    row_s = cur.fetchone()
    settings = json.loads(row_s["value"]) if row_s else {}
    settings.pop("adminPassHash", None)
    settings.pop("adminUser", None)

    cur.execute("SELECT * FROM bakeries ORDER BY created_at DESC, name ASC")
    bakeries = []
    for r in cur.fetchall():
        bakeries.append({
            "id": r["id"],
            "slug": r["slug"],
            "name": r["name"],
            "neighborhood": r["neighborhood"],
            "address": r["address"],
            "lat": r["lat"],
            "lng": r["lng"],
            "instagram": r["instagram"],
            "whatsapp": r["whatsapp"],
            "openingHours": r["opening_hours"],
            "priceRange": r["price_range"],
            "coverPhoto": r["cover_photo"],
            "description": r["description"],
            "isFeaturedPartner": bool(r["is_featured_partner"]),
            "createdAt": r["created_at"]
        })

    cur.execute("SELECT * FROM cakes ORDER BY visited_at DESC, created_at DESC")
    cakes = []
    for r in cur.fetchall():
        try:
            photos = json.loads(r["photos_json"] or "[]")
        except Exception:
            photos = []
        try:
            sensory = json.loads(r["sensory_notes_json"] or "{}")
        except Exception:
            sensory = {}
        cakes.append({
            "id": r["id"],
            "bakeryId": r["bakery_id"],
            "slug": r["slug"],
            "name": r["name"],
            "category": r["category"],
            "flavorType": r["flavor_type"],
            "photos": photos,
            "scoreFlavor": r["score_flavor"],
            "scoreDough": r["score_dough"],
            "scoreTexture": r["score_texture"],
            "scoreFilling": r["score_filling"],
            "kaiVerdict": r["kai_verdict"],
            "sensoryNotes": sensory,
            "approxPrice": r["approx_price"],
            "visitedAt": r["visited_at"],
            "reevaluatedAt": r["reevaluated_at"],
            "reevaluationNote": r["reevaluation_note"],
            "editionYear": r["edition_year"],
            "reactions": {
                "waterInMouth": r["react_water"],
                "agreeWithKai": r["react_agree"],
                "wantToTry": r["react_try"]
            }
        })

    cur.execute("SELECT * FROM upcoming_bakeries ORDER BY votes DESC, name ASC")
    upcoming = []
    for r in cur.fetchall():
        upcoming.append({
            "id": r["id"],
            "name": r["name"],
            "neighborhood": r["neighborhood"],
            "specialty": r["specialty"],
            "reason": r["reason"],
            "votes": r["votes"],
            "plannedMonth": r["planned_month"]
        })

    conn.close()
    return {
        "settings": settings,
        "bakeries": bakeries,
        "cakes": cakes,
        "upcomingBakeries": upcoming
    }


def sync_static_snapshot():
    """
    Sincroniza o estado público do banco SQLite com public/data/public.json e data/seed.json,
    permitindo que o site funcione 100% estático no GitHub Pages via git commit + git push.
    """
    try:
        payload = get_public_data_payload()
        pub_data_dir = PUBLIC_DIR / "data"
        pub_data_dir.mkdir(parents=True, exist_ok=True)
        json_str = json.dumps(payload, ensure_ascii=False, indent=2)
        (pub_data_dir / "public.json").write_text(json_str, encoding="utf-8")
        SEED_PATH.write_text(json_str, encoding="utf-8")
    except Exception as e:
        print(f"[WARN] Falha ao sincronizar snapshot estático: {e}")


def resolve_base_url(handler_headers) -> str:
    if SITE_BASE_URL:
        return SITE_BASE_URL
    host = handler_headers.get("Host", "localhost:8080")
    proto = handler_headers.get("X-Forwarded-Proto", "http")
    return f"{proto}://{host}"


def render_html_with_seo(route_path: str, base_url: str) -> bytes:
    """
    Injeta <title>, <meta name="description">, <link rel="canonical">, Open Graph tags
    e Schema.org JSON-LD diretamente no HTML no servidor para Googlebot, WhatsApp e Instagram.
    """
    index_file = PUBLIC_DIR / "index.html"
    if not index_file.exists():
        return b"<h1>Arquivo public/index.html nao encontrado</h1>"

    raw_html = index_file.read_text(encoding="utf-8")
    data = get_public_data_payload()
    settings = data.get("settings", {})
    weights = settings.get("weights", {"flavor": 25, "dough": 25, "texture": 25, "filling": 25})
    bakeries = data.get("bakeries", [])
    cakes = data.get("cakes", [])

    default_title = "Sugarcube Corner — O Ranking de Bolos de Feira de Santana por Kai Tavares"
    default_desc = settings.get(
        "subtitle",
        "Avaliações sinceras, sensoriais e autorais dos melhores bolos e confeitarias de Feira de Santana - BA por Kai Tavares."
    )
    default_img = f"{base_url}/assets/og-sugarcube.svg"

    page_title = default_title
    page_desc = default_desc
    page_img = default_img
    canonical_url = f"{base_url}{route_path if route_path != '/' else '/'}"

    json_ld = {
        "@context": "https://schema.org",
        "@type": "WebSite",
        "name": "Sugarcube Corner",
        "url": base_url,
        "description": default_desc,
        "author": {"@type": "Person", "name": "Kai Tavares"}
    }

    if route_path == "/ranking":
        page_title = "Ranking de Bolos e Confeitarias em Feira de Santana | Sugarcube Corner"
        page_desc = "Ordene os bolos de Feira de Santana por Textura, Massa, Sabor ou Recheio. Avaliações autorais de Kai Tavares."
    elif route_path == "/mapa":
        page_title = "Mapa das Confeitarias de Feira de Santana | Sugarcube Corner"
        page_desc = "Veja no mapa interativo onde ficam as confeitarias avaliadas por Kai Tavares em Feira de Santana - BA."
    elif route_path == "/em-breve":
        page_title = "Em Breve & Sugestões de Confeitarias | Sugarcube Corner"
        page_desc = "Vote nas próximas confeitarias que Kai Tavares vai avaliar em Feira de Santana ou envie sua sugestão."
    elif route_path == "/sobre":
        page_title = "Sobre Kai Tavares & Metodologia Sensorial | Sugarcube Corner"
        page_desc = "Conheça a metodologia de avaliação de Textura, Massa, Sabor e Recheio de Kai Tavares no Sugarcube Corner."
    elif route_path.startswith("/confeitaria/"):
        slug = urllib.parse.unquote(route_path[len("/confeitaria/"):].strip("/"))
        bakery = next((b for b in bakeries if b["slug"] == slug or b["id"] == slug), None)
        if bakery:
            b_cakes = [c for c in cakes if c["bakeryId"] == bakery["id"]]
            scores = [compute_cake_score(c, weights) for c in b_cakes]
            avg_score = round(sum(scores) / len(scores), 1) if scores else 0.0
            page_title = f"{bakery['name']} ({bakery['neighborhood']}) — Nota {avg_score:.1f} | Sugarcube Corner"
            page_desc = bakery["description"] or f"Avaliações dos bolos da {bakery['name']} em Feira de Santana por Kai Tavares."
            if bakery.get("coverPhoto"):
                cov = bakery["coverPhoto"]
                page_img = cov if cov.startswith("http") else f"{base_url}{cov}"
            json_ld = {
                "@context": "https://schema.org",
                "@type": "Bakery",
                "name": bakery["name"],
                "description": page_desc,
                "image": page_img,
                "priceRange": bakery.get("priceRange", "$$"),
                "address": {
                    "@type": "PostalAddress",
                    "streetAddress": bakery.get("address", ""),
                    "addressLocality": "Feira de Santana",
                    "addressRegion": "BA",
                    "addressCountry": "BR"
                }
            }
            if scores:
                json_ld["aggregateRating"] = {
                    "@type": "AggregateRating",
                    "ratingValue": f"{avg_score:.1f}",
                    "bestRating": "10",
                    "worstRating": "0",
                    "ratingCount": len(scores)
                }
    elif route_path.startswith("/bolo/"):
        slug = urllib.parse.unquote(route_path[len("/bolo/"):].strip("/"))
        cake = next((c for c in cakes if c["slug"] == slug or c["id"] == slug), None)
        if cake:
            bakery = next((b for b in bakeries if b["id"] == cake["bakeryId"]), {})
            f_score = compute_cake_score(cake, weights)
            b_name = bakery.get("name", "Confeitaria")
            page_title = f"{cake['name']} ({b_name}) — Nota {f_score:.1f}/10 por Kai Tavares"
            page_desc = (
                f"Nota Final {f_score:.1f}/10 (Textura {cake['scoreTexture']:.1f} | Massa {cake['scoreDough']:.1f} | "
                f"Sabor {cake['scoreFlavor']:.1f} | Recheio {cake['scoreFilling']:.1f}). {cake['kaiVerdict'][:180]}"
            )
            if cake.get("photos") and len(cake["photos"]) > 0:
                ph = cake["photos"][0]
                page_img = ph if ph.startswith("http") else f"{base_url}{ph}"
            json_ld = {
                "@context": "https://schema.org",
                "@type": "Review",
                "name": f"Avaliação: {cake['name']}",
                "reviewBody": cake["kaiVerdict"],
                "datePublished": cake["visitedAt"],
                "author": {"@type": "Person", "name": "Kai Tavares"},
                "itemReviewed": {
                    "@type": "MenuItem",
                    "name": cake["name"],
                    "offers": {
                        "@type": "Offer",
                        "price": cake["approxPrice"],
                        "priceCurrency": "BRL"
                    }
                },
                "reviewRating": {
                    "@type": "Rating",
                    "ratingValue": f"{f_score:.1f}",
                    "bestRating": "10",
                    "worstRating": "0"
                }
            }

    esc_title = html.escape(page_title, quote=True)
    esc_desc = html.escape(page_desc, quote=True)
    esc_img = html.escape(page_img, quote=True)
    esc_canon = html.escape(canonical_url, quote=True)
    json_ld_str = json.dumps(json_ld, ensure_ascii=False, indent=2)

    raw_html = raw_html.replace("__SEO_TITLE__", esc_title)
    raw_html = raw_html.replace("__SEO_DESCRIPTION__", esc_desc)
    raw_html = raw_html.replace("__SEO_IMAGE__", esc_img)
    raw_html = raw_html.replace("__SEO_CANONICAL__", esc_canon)
    raw_html = raw_html.replace("__SEO_JSONLD__", json_ld_str)

    return raw_html.encode("utf-8")


def generate_sitemap_xml(base_url: str) -> bytes:
    data = get_public_data_payload()
    today = time.strftime("%Y-%m-%d")

    static_routes = [
        ("/", "daily", "1.0"),
        ("/ranking", "daily", "0.9"),
        ("/mapa", "weekly", "0.8"),
        ("/em-breve", "weekly", "0.7"),
        ("/sobre", "monthly", "0.7")
    ]

    urls = [
        f"  <url><loc>{html.escape(base_url + path)}</loc><lastmod>{today}</lastmod><changefreq>{freq}</changefreq><priority>{prio}</priority></url>"
        for path, freq, prio in static_routes
    ]

    for b in data.get("bakeries", []):
        loc = html.escape(f"{base_url}/confeitaria/{urllib.parse.quote(b['slug'])}")
        urls.append(f"  <url><loc>{loc}</loc><lastmod>{today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>")

    for c in data.get("cakes", []):
        loc = html.escape(f"{base_url}/bolo/{urllib.parse.quote(c['slug'])}")
        urls.append(f"  <url><loc>{loc}</loc><lastmod>{today}</lastmod><changefreq>weekly</changefreq><priority>0.9</priority></url>")

    xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    xml += "\n".join(urls)
    xml += "\n</urlset>\n"
    return xml.encode("utf-8")


def validate_image_magic_bytes(raw_bytes: bytes) -> str | None:
    """Verifica assinatura real do arquivo (JPEG, PNG ou WebP)."""
    if len(raw_bytes) < 12:
        return None
    if raw_bytes[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if raw_bytes[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if raw_bytes[:4] == b"RIFF" and raw_bytes[8:12] == b"WEBP":
        return ".webp"
    return None


class SugarcubeSecureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.request.settimeout(15.0)

    def get_client_ip(self) -> str:
        forwarded = self.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return self.client_address[0] if self.client_address else "0.0.0.0"

    def get_actor_hash(self) -> str:
        ip = self.get_client_ip()
        ua = self.headers.get("User-Agent", "")[:80]
        return hashlib.sha256(f"{ip}|{ua}".encode("utf-8")).hexdigest()[:32]

    def get_authenticated_user(self) -> str | None:
        cookie_header = self.headers.get("Cookie", "")
        if not cookie_header:
            return None
        c = cookies.SimpleCookie()
        try:
            c.load(cookie_header)
            if "sugarcube_session" in c:
                return verify_session_token(c["sugarcube_session"].value)
        except Exception:
            return None
        return None

    def send_json(self, data: dict, status: int = 200, extra_headers: list[tuple[str, str]] = None):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        if status >= 400:
            self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        if status >= 400:
            self.send_header("Connection", "close")
        if extra_headers:
            for k, v in extra_headers:
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(payload)

    def read_json_body(self, max_bytes: int = MAX_JSON_BODY) -> tuple[dict | None, str | None, int]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None, "Cabeçalho Content-Length inválido.", 400
        if length <= 0:
            return {}, None, 200
        if length > max_bytes:
            return None, f"Requisição excede o limite permitido ({max_bytes // 1024} KB).", 413
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8")), None, 200
        except Exception:
            return None, "JSON malformado.", 400

    def serve_static_file(self, base_folder: Path, rel_path: str):
        target = (base_folder / rel_path).resolve()
        try:
            if not target.is_relative_to(base_folder.resolve()):
                return self.send_json({"ok": False, "error": "Acesso negado."}, 403)
        except AttributeError:
            if str(base_folder.resolve()) not in str(target):
                return self.send_json({"ok": False, "error": "Acesso negado."}, 403)

        if not target.exists() or not target.is_file():
            return self.send_json({"ok": False, "error": "Arquivo não encontrado."}, 404)

        mime, _ = mimetypes.guess_type(str(target))
        if not mime:
            mime = "application/octet-stream"
        if mime.startswith("text/") or mime in ("application/javascript", "image/svg+xml"):
            mime += "; charset=utf-8"

        content = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(content)

    # =========================================================================
    # ROTAS GET
    # =========================================================================
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # 1. Dados públicos do site
        if path == "/api/public/data":
            return self.send_json({"ok": True, "data": get_public_data_payload()})

        # 2. Sessão atual de Admin
        if path == "/api/auth/me":
            user = self.get_authenticated_user()
            return self.send_json({"ok": True, "authenticated": bool(user), "username": user})

        # 3. Rotas GET restritas ao Admin
        if path == "/api/admin/suggestions":
            if not self.get_authenticated_user():
                return self.send_json({"ok": False, "error": "Não autorizado. Faça login no painel."}, 401)
            conn = get_db()
            cur = conn.cursor()
            cur.execute("SELECT * FROM public_suggestions ORDER BY created_at DESC")
            rows = [
                {
                    "id": r["id"],
                    "bakeryName": r["bakery_name"],
                    "neighborhood": r["neighborhood"],
                    "cakeSuggested": r["cake_suggested"],
                    "submittedBy": r["submitted_by"],
                    "comment": r["comment"],
                    "createdAt": r["created_at"],
                    "status": r["status"]
                }
                for r in cur.fetchall()
            ]
            conn.close()
            return self.send_json({"ok": True, "suggestions": rows})

        if path == "/api/admin/backup":
            if not self.get_authenticated_user():
                return self.send_json({"ok": False, "error": "Não autorizado."}, 401)
            backup_database()
            payload = get_public_data_payload()
            conn = get_db()
            cur = conn.cursor()
            cur.execute("SELECT * FROM public_suggestions ORDER BY created_at DESC")
            payload["publicSuggestions"] = [dict(r) for r in cur.fetchall()]
            conn.close()
            return self.send_json({"ok": True, "backup": payload})

        # 4. Sitemap.xml e Robots.txt com rotas reais (sem #/)
        if path == "/sitemap.xml":
            base_url = resolve_base_url(self.headers)
            xml_bytes = generate_sitemap_xml(base_url)
            self.send_response(200)
            self.send_header("Content-Type", "application/xml; charset=utf-8")
            self.send_header("Content-Length", str(len(xml_bytes)))
            self.end_headers()
            self.wfile.write(xml_bytes)
            return

        if path == "/robots.txt":
            base_url = resolve_base_url(self.headers)
            txt = f"User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nSitemap: {base_url}/sitemap.xml\n".encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(txt)))
            self.end_headers()
            self.wfile.write(txt)
            return

        # 5. Arquivos enviados (Uploads)
        if path.startswith("/uploads/"):
            rel = path[len("/uploads/"):]
            return self.serve_static_file(UPLOADS_DIR, rel)

        # 6. Arquivos estáticos em public/ (css/, js/, assets/, data/, favicon)
        if path == "/favicon.ico":
            return self.serve_static_file(PUBLIC_DIR, "assets/sugarcube-icon.png")
        if path == "/data/public.json":
            return self.serve_static_file(PUBLIC_DIR, "data/public.json")
        if path.startswith(("/css/", "/js/", "/assets/")):
            rel = path.lstrip("/")
            return self.serve_static_file(PUBLIC_DIR, rel)

        # 7. Rotas de Páginas Reais (History API + Injeção Server-Side de SEO)
        spa_routes = ("/", "/ranking", "/mapa", "/em-breve", "/sobre", "/admin")
        if path in spa_routes or path.startswith("/confeitaria/") or path.startswith("/bolo/"):
            base_url = resolve_base_url(self.headers)
            html_bytes = render_html_with_seo(path, base_url)
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html_bytes)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(html_bytes)
            return

        return self.send_json({"ok": False, "error": "Página ou recurso não encontrado."}, 404)

    # =========================================================================
    # ROTAS POST
    # =========================================================================
    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        ip = self.get_client_ip()

        # --- AUTENTICAÇÃO ---
        if path == "/api/auth/login":
            if not check_rate_limit(f"login:{ip}", max_requests=8, window_seconds=300):
                return self.send_json(
                    {"ok": False, "error": "Muitas tentativas de login. Aguarde 5 minutos."},
                    429
                )
            body, err, status = self.read_json_body()
            if err:
                return self.send_json({"ok": False, "error": err}, status)

            username = str(body.get("username", "")).strip().lower()
            password = str(body.get("password", ""))

            conn = get_db()
            cur = conn.cursor()
            cur.execute("SELECT salt_hex, hash_hex FROM admin_auth WHERE username = ?", (username,))
            row = cur.fetchone()
            conn.close()

            if not row or not verify_password_scrypt(password, row["salt_hex"], row["hash_hex"]):
                return self.send_json({"ok": False, "error": "Login ou senha incorretos."}, 401)

            token = create_session_token(username)
            cookie_val = (
                f"sugarcube_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_TTL_SECONDS}"
            )
            return self.send_json(
                {"ok": True, "username": username, "message": "Sessão iniciada com sucesso."},
                200,
                extra_headers=[("Set-Cookie", cookie_val)]
            )

        if path == "/api/auth/logout":
            cookie_val = "sugarcube_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
            return self.send_json(
                {"ok": True, "message": "Sessão encerrada."},
                200,
                extra_headers=[("Set-Cookie", cookie_val)]
            )

        if path == "/api/auth/password":
            user = self.get_authenticated_user()
            if not user:
                return self.send_json({"ok": False, "error": "Não autorizado."}, 401)
            body, err, status = self.read_json_body()
            if err:
                return self.send_json({"ok": False, "error": err}, status)

            current_pass = str(body.get("currentPassword", ""))
            new_pass = str(body.get("newPassword", "")).strip()
            if len(new_pass) < 8:
                return self.send_json({"ok": False, "error": "A nova senha deve ter pelo menos 8 caracteres."}, 400)

            conn = get_db()
            cur = conn.cursor()
            cur.execute("SELECT salt_hex, hash_hex FROM admin_auth WHERE username = ?", (user,))
            row = cur.fetchone()
            if not row or not verify_password_scrypt(current_pass, row["salt_hex"], row["hash_hex"]):
                conn.close()
                return self.send_json({"ok": False, "error": "A senha atual informada está incorreta."}, 403)

            salt_hex, hash_hex = hash_password_scrypt(new_pass)
            now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            cur.execute(
                "UPDATE admin_auth SET salt_hex = ?, hash_hex = ?, updated_at = ? WHERE username = ?",
                (salt_hex, hash_hex, now, user)
            )
            conn.commit()
            conn.close()
            return self.send_json({"ok": True, "message": "Senha atualizada com segurança."})

        # --- ROTAS PÚBLICAS ATÔMICAS (REAÇÕES, VOTOS E SUGESTÕES) ---
        m_react = re.match(r"^/api/public/cakes/([a-zA-Z0-9_-]+)/react$", path)
        if m_react:
            if not check_rate_limit(f"public:{ip}", max_requests=25, window_seconds=60):
                return self.send_json({"ok": False, "error": "Muitas ações seguidas. Aguarde um instante."}, 429)
            cake_id = m_react.group(1)
            body, err, status = self.read_json_body()
            if err:
                return self.send_json({"ok": False, "error": err}, status)

            r_type = str(body.get("reaction", ""))
            col_map = {
                "waterInMouth": "react_water",
                "agreeWithKai": "react_agree",
                "wantToTry": "react_try"
            }
            if r_type not in col_map:
                return self.send_json({"ok": False, "error": "Tipo de reação inválido."}, 400)

            actor = self.get_actor_hash()
            action_key = f"react:{cake_id}:{r_type}"

            conn = get_db()
            cur = conn.cursor()
            cur.execute(
                "SELECT 1 FROM visitor_rate_log WHERE actor_hash = ? AND action_key = ?",
                (actor, action_key)
            )
            if cur.fetchone() is not None:
                conn.close()
                return self.send_json({"ok": False, "error": "Você já registrou essa reação para este bolo!"}, 409)

            col = col_map[r_type]
            cur.execute(f"UPDATE cakes SET {col} = {col} + 1 WHERE id = ?", (cake_id,))
            if cur.rowcount == 0:
                conn.close()
                return self.send_json({"ok": False, "error": "Bolo não encontrado."}, 404)

            cur.execute(
                "INSERT INTO visitor_rate_log (actor_hash, action_key, created_at) VALUES (?, ?, ?)",
                (actor, action_key, int(time.time()))
            )
            cur.execute("SELECT react_water, react_agree, react_try FROM cakes WHERE id = ?", (cake_id,))
            updated = cur.fetchone()
            conn.commit()
            conn.close()
            return self.send_json({
                "ok": True,
                "reactions": {
                    "waterInMouth": updated["react_water"],
                    "agreeWithKai": updated["react_agree"],
                    "wantToTry": updated["react_try"]
                }
            })

        m_vote = re.match(r"^/api/public/upcoming/([a-zA-Z0-9_-]+)/vote$", path)
        if m_vote:
            if not check_rate_limit(f"public:{ip}", max_requests=20, window_seconds=60):
                return self.send_json({"ok": False, "error": "Muitas ações seguidas. Aguarde um instante."}, 429)
            up_id = m_vote.group(1)
            actor = self.get_actor_hash()
            action_key = f"vote:{up_id}"

            conn = get_db()
            cur = conn.cursor()
            cur.execute(
                "SELECT 1 FROM visitor_rate_log WHERE actor_hash = ? AND action_key = ?",
                (actor, action_key)
            )
            if cur.fetchone() is not None:
                conn.close()
                return self.send_json({"ok": False, "error": "Seu voto para esta confeitaria já foi registrado!"}, 409)

            cur.execute("UPDATE upcoming_bakeries SET votes = votes + 1 WHERE id = ?", (up_id,))
            if cur.rowcount == 0:
                conn.close()
                return self.send_json({"ok": False, "error": "Item não encontrado."}, 404)

            cur.execute(
                "INSERT INTO visitor_rate_log (actor_hash, action_key, created_at) VALUES (?, ?, ?)",
                (actor, action_key, int(time.time()))
            )
            cur.execute("SELECT votes FROM upcoming_bakeries WHERE id = ?", (up_id,))
            new_votes = cur.fetchone()["votes"]
            conn.commit()
            conn.close()
            return self.send_json({"ok": True, "votes": new_votes})

        if path == "/api/public/suggestions":
            if not check_rate_limit(f"suggest:{ip}", max_requests=5, window_seconds=300):
                return self.send_json({"ok": False, "error": "Limite de sugestões atingido. Tente novamente mais tarde."}, 429)
            body, err, status = self.read_json_body()
            if err:
                return self.send_json({"ok": False, "error": err}, status)

            bakery_name = str(body.get("bakeryName", "")).strip()[:120]
            neighborhood = str(body.get("neighborhood", "")).strip()[:80]
            cake_suggested = str(body.get("cakeSuggested", "")).strip()[:140]
            submitted_by = str(body.get("submittedBy", "")).strip()[:80] or "Visitante"
            comment = str(body.get("comment", "")).strip()[:600]

            if not bakery_name or not neighborhood or not cake_suggested:
                return self.send_json({"ok": False, "error": "Preencha o nome da confeitaria, bairro e bolo sugerido."}, 400)

            sug_id = f"sug-{int(time.time() * 1000)}-{secrets.token_hex(2)}"
            today = time.strftime("%Y-%m-%d")
            conn = get_db()
            cur = conn.cursor()
            cur.execute(
                """INSERT INTO public_suggestions
                   (id, bakery_name, neighborhood, cake_suggested, submitted_by, comment, created_at, status)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')""",
                (sug_id, bakery_name, neighborhood, cake_suggested, submitted_by, comment, today)
            )
            conn.commit()
            conn.close()
            return self.send_json({"ok": True, "message": "Sugestão enviada para a fila de moderação de Kai!"}, 201)

        # --- TODAS AS ROTAS ABAIXO EXIGEM AUTENTICAÇÃO DE ADMIN ---
        if not self.get_authenticated_user():
            return self.send_json({"ok": False, "error": "Sessão expirada ou não autorizada. Faça login novamente."}, 401)

        if path == "/api/admin/upload":
            body, err, status = self.read_json_body(max_bytes=MAX_UPLOAD_BODY)
            if err:
                return self.send_json({"ok": False, "error": err}, status)

            data_url = str(body.get("dataUrl", ""))
            filename_hint = str(body.get("filename", "foto-bolo.jpg"))
            match = re.match(r"^data:image/[a-zA-Z0-9.+-]+;base64,(.+)$", data_url)
            if not match:
                return self.send_json({"ok": False, "error": "Formato DataURL de imagem inválido."}, 400)

            try:
                raw_bytes = base64.b64decode(match.group(1), validate=True)
            except Exception:
                return self.send_json({"ok": False, "error": "Base64 inválido."}, 400)

            if len(raw_bytes) > 4 * 1024 * 1024:
                return self.send_json({"ok": False, "error": "A imagem otimizada não pode ultrapassar 4 MB."}, 413)

            ext = validate_image_magic_bytes(raw_bytes)
            if not ext:
                return self.send_json({"ok": False, "error": "Arquivo rejeitado: apenas imagens JPEG, PNG ou WebP reais são aceitas."}, 400)

            safe_stem = slugify(Path(filename_hint).stem)[:36]
            out_name = f"{safe_stem}-{int(time.time() * 1000)}-{secrets.token_hex(3)}{ext}"
            (UPLOADS_DIR / out_name).write_bytes(raw_bytes)
            return self.send_json({"ok": True, "url": f"/uploads/{out_name}"})

        if path == "/api/admin/bakeries":
            body, err, status = self.read_json_body()
            if err:
                return self.send_json({"ok": False, "error": err}, status)
            return self._upsert_bakery(body, existing_id=None)

        if path == "/api/admin/cakes":
            body, err, status = self.read_json_body()
            if err:
                return self.send_json({"ok": False, "error": err}, status)
            return self._upsert_cake(body, existing_id=None)

        if path == "/api/admin/upcoming":
            body, err, status = self.read_json_body()
            if err:
                return self.send_json({"ok": False, "error": err}, status)
            name = str(body.get("name", "")).strip()
            neighborhood = str(body.get("neighborhood", "")).strip()
            if not name or not neighborhood:
                return self.send_json({"ok": False, "error": "Informe nome e bairro."}, 400)
            up_id = f"up-{int(time.time() * 1000)}"
            conn = get_db()
            conn.execute(
                """INSERT INTO upcoming_bakeries (id, name, neighborhood, specialty, reason, votes, planned_month)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    up_id,
                    name,
                    neighborhood,
                    str(body.get("specialty", "")).strip(),
                    str(body.get("reason", "")).strip(),
                    int(body.get("votes", 1)),
                    str(body.get("plannedMonth", "Em breve")).strip()
                )
            )
            conn.commit()
            conn.close()
            sync_static_snapshot()
            return self.send_json({"ok": True, "id": up_id}, 201)

        m_promo = re.match(r"^/api/admin/suggestions/([a-zA-Z0-9_-]+)/promote$", path)
        if m_promo:
            sug_id = m_promo.group(1)
            conn = get_db()
            cur = conn.cursor()
            cur.execute("SELECT * FROM public_suggestions WHERE id = ?", (sug_id,))
            sug = cur.fetchone()
            if not sug:
                conn.close()
                return self.send_json({"ok": False, "error": "Sugestão não encontrada."}, 404)

            up_id = f"up-{int(time.time() * 1000)}"
            cur.execute(
                """INSERT INTO upcoming_bakeries (id, name, neighborhood, specialty, reason, votes, planned_month)
                   VALUES (?, ?, ?, ?, ?, 1, 'Na fila de Kai')""",
                (
                    up_id,
                    sug["bakery_name"],
                    sug["neighborhood"],
                    sug["cake_suggested"],
                    f"Sugerido por {sug['submitted_by']}: \"{sug['comment']}\""
                )
            )
            cur.execute("DELETE FROM public_suggestions WHERE id = ?", (sug_id,))
            conn.commit()
            conn.close()
            sync_static_snapshot()
            return self.send_json({"ok": True, "message": "Sugestão aprovada para a lista Em Breve!"})

        return self.send_json({"ok": False, "error": "Endpoint POST não encontrado."}, 404)

    # =========================================================================
    # ROTAS PUT E DELETE (ADMIN PROTEGIDO)
    # =========================================================================
    def do_PUT(self):
        if not self.get_authenticated_user():
            return self.send_json({"ok": False, "error": "Não autorizado."}, 401)

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body, err, status = self.read_json_body()
        if err:
            return self.send_json({"ok": False, "error": err}, status)

        m_bak = re.match(r"^/api/admin/bakeries/([a-zA-Z0-9_-]+)$", path)
        if m_bak:
            return self._upsert_bakery(body, existing_id=m_bak.group(1))

        m_cake = re.match(r"^/api/admin/cakes/([a-zA-Z0-9_-]+)$", path)
        if m_cake:
            return self._upsert_cake(body, existing_id=m_cake.group(1))

        if path == "/api/admin/settings":
            conn = get_db()
            cur = conn.cursor()
            cur.execute("SELECT value FROM settings WHERE key = 'site_settings'")
            row = cur.fetchone()
            current = json.loads(row["value"]) if row else {}

            if "weights" in body and isinstance(body["weights"], dict):
                current["weights"] = {
                    "texture": max(0, min(100, int(body["weights"].get("texture", 25)))),
                    "dough": max(0, min(100, int(body["weights"].get("dough", 25)))),
                    "flavor": max(0, min(100, int(body["weights"].get("flavor", 25)))),
                    "filling": max(0, min(100, int(body["weights"].get("filling", 25))))
                }
            if "approvalThreshold" in body:
                current["approvalThreshold"] = round(float(body["approvalThreshold"]), 1)
            if "minTextureForApproval" in body:
                current["minTextureForApproval"] = round(float(body["minTextureForApproval"]), 1)
            if "minCakesForConsolidatedRank" in body:
                current["minCakesForConsolidatedRank"] = max(1, int(body["minCakesForConsolidatedRank"]))
            if "kaiBio" in body and isinstance(body["kaiBio"], dict):
                bio = current.get("kaiBio", {})
                bio["title"] = str(body["kaiBio"].get("title", bio.get("title", ""))).strip()
                bio["lead"] = str(body["kaiBio"].get("lead", bio.get("lead", ""))).strip()
                bio["story"] = str(body["kaiBio"].get("story", bio.get("story", ""))).strip()
                current["kaiBio"] = bio

            cur.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('site_settings', ?)",
                (json.dumps(current, ensure_ascii=False),)
            )
            conn.commit()
            conn.close()
            sync_static_snapshot()
            return self.send_json({"ok": True, "settings": current})

        return self.send_json({"ok": False, "error": "Endpoint PUT não encontrado."}, 404)

    def do_DELETE(self):
        if not self.get_authenticated_user():
            return self.send_json({"ok": False, "error": "Não autorizado."}, 401)

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        m_bak = re.match(r"^/api/admin/bakeries/([a-zA-Z0-9_-]+)$", path)
        if m_bak:
            backup_database()
            conn = get_db()
            conn.execute("DELETE FROM cakes WHERE bakery_id = ?", (m_bak.group(1),))
            conn.execute("DELETE FROM bakeries WHERE id = ?", (m_bak.group(1),))
            conn.commit()
            conn.close()
            sync_static_snapshot()
            return self.send_json({"ok": True, "message": "Confeitaria excluída."})

        m_cake = re.match(r"^/api/admin/cakes/([a-zA-Z0-9_-]+)$", path)
        if m_cake:
            backup_database()
            conn = get_db()
            conn.execute("DELETE FROM cakes WHERE id = ?", (m_cake.group(1),))
            conn.commit()
            conn.close()
            sync_static_snapshot()
            return self.send_json({"ok": True, "message": "Avaliação excluída."})

        m_up = re.match(r"^/api/admin/upcoming/([a-zA-Z0-9_-]+)$", path)
        if m_up:
            conn = get_db()
            conn.execute("DELETE FROM upcoming_bakeries WHERE id = ?", (m_up.group(1),))
            conn.commit()
            conn.close()
            sync_static_snapshot()
            return self.send_json({"ok": True})

        m_sug = re.match(r"^/api/admin/suggestions/([a-zA-Z0-9_-]+)$", path)
        if m_sug:
            conn = get_db()
            conn.execute("DELETE FROM public_suggestions WHERE id = ?", (m_sug.group(1),))
            conn.commit()
            conn.close()
            return self.send_json({"ok": True})

        return self.send_json({"ok": False, "error": "Endpoint DELETE não encontrado."}, 404)

    # =========================================================================
    # HELPERS DE UPSERT COM VALIDAÇÃO DE SLUG E DUPLICATAS
    # =========================================================================
    def _upsert_bakery(self, body: dict, existing_id: str | None):
        name = str(body.get("name", "")).strip()
        neighborhood = str(body.get("neighborhood", "")).strip()
        address = str(body.get("address", "")).strip()
        if not name or not neighborhood or not address:
            return self.send_json({"ok": False, "error": "Nome, bairro e endereço são obrigatórios."}, 400)

        conn = get_db()
        cur = conn.cursor()

        # Verificar duplicata de Nome + Bairro
        if existing_id:
            cur.execute(
                "SELECT id FROM bakeries WHERE lower(name) = lower(?) AND lower(neighborhood) = lower(?) AND id != ?",
                (name, neighborhood, existing_id)
            )
        else:
            cur.execute(
                "SELECT id FROM bakeries WHERE lower(name) = lower(?) AND lower(neighborhood) = lower(?)",
                (name, neighborhood)
            )
        if cur.fetchone() is not None:
            conn.close()
            return self.send_json(
                {"ok": False, "error": f"Já existe uma confeitaria '{name}' cadastrada no bairro '{neighborhood}'."},
                409
            )

        bak_id = existing_id or f"bak-{int(time.time() * 1000)}"
        base_slug = slugify(f"{name}-{neighborhood}")
        unique_slug = ensure_unique_slug(conn, "bakeries", base_slug, exclude_id=existing_id)
        today = time.strftime("%Y-%m-%d")

        lat = float(body.get("lat") or -12.2545)
        lng = float(body.get("lng") or -38.9550)
        instagram = str(body.get("instagram", "")).strip()
        whatsapp = re.sub(r"\D", "", str(body.get("whatsapp", "")))
        opening_hours = str(body.get("openingHours", "")).strip()
        price_range = str(body.get("priceRange", "$$")).strip() or "$$"
        cover_photo = str(body.get("coverPhoto", "")).strip() or "/assets/og-sugarcube.svg"
        description = str(body.get("description", "")).strip()
        is_partner = 1 if body.get("isFeaturedPartner") else 0

        if existing_id:
            cur.execute(
                """UPDATE bakeries SET
                   slug = ?, name = ?, neighborhood = ?, address = ?, lat = ?, lng = ?,
                   instagram = ?, whatsapp = ?, opening_hours = ?, price_range = ?,
                   cover_photo = ?, description = ?, is_featured_partner = ?
                   WHERE id = ?""",
                (
                    unique_slug, name, neighborhood, address, lat, lng,
                    instagram, whatsapp, opening_hours, price_range,
                    cover_photo, description, is_partner, existing_id
                )
            )
        else:
            cur.execute(
                """INSERT INTO bakeries
                   (id, slug, name, neighborhood, address, lat, lng, instagram, whatsapp,
                    opening_hours, price_range, cover_photo, description, is_featured_partner, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    bak_id, unique_slug, name, neighborhood, address, lat, lng,
                    instagram, whatsapp, opening_hours, price_range,
                    cover_photo, description, is_partner, today
                )
            )

        conn.commit()
        conn.close()
        sync_static_snapshot()
        return self.send_json({"ok": True, "id": bak_id, "slug": unique_slug})

    def _upsert_cake(self, body: dict, existing_id: str | None):
        bakery_id = str(body.get("bakeryId", "")).strip()
        name = str(body.get("name", "")).strip()
        verdict = str(body.get("kaiVerdict", "")).strip()
        if not bakery_id or not name or not verdict:
            return self.send_json({"ok": False, "error": "Confeitaria, nome do bolo e veredito de Kai são obrigatórios."}, 400)

        conn = get_db()
        cur = conn.cursor()
        cur.execute("SELECT name, neighborhood FROM bakeries WHERE id = ?", (bakery_id,))
        bakery_row = cur.fetchone()
        if not bakery_row:
            conn.close()
            return self.send_json({"ok": False, "error": "Confeitaria selecionada não existe."}, 404)

        def clamp_half(val) -> float:
            v = max(0.0, min(10.0, float(val or 0)))
            return round(v * 2) / 2

        cake_id = existing_id or f"cake-{int(time.time() * 1000)}"
        # Sempre gera slug coerente com o nome real do bolo + bairro
        base_slug = slugify(f"{name}-{bakery_row['neighborhood']}")
        unique_slug = ensure_unique_slug(conn, "cakes", base_slug, exclude_id=existing_id)

        photos = body.get("photos")
        if not isinstance(photos, list) or len(photos) == 0 or not str(photos[0]).strip():
            photos = ["/assets/og-sugarcube.svg"]
        else:
            photos = [str(p).strip() for p in photos if str(p).strip()]

        sensory = body.get("sensoryNotes") if isinstance(body.get("sensoryNotes"), dict) else {}
        sensory_clean = {
            "crumbPoint": str(sensory.get("crumbPoint", "")).strip() or "Massa avaliada por Kai",
            "moisture": str(sensory.get("moisture", "")).strip() or "Equilibrada",
            "sweetness": str(sensory.get("sweetness", "")).strip() or "Equilibrado",
            "mouthfeel": str(sensory.get("mouthfeel", "")).strip() or "Avaliado no garfo"
        }

        s_flavor = clamp_half(body.get("scoreFlavor", 0))
        s_dough = clamp_half(body.get("scoreDough", 0))
        s_texture = clamp_half(body.get("scoreTexture", 0))
        s_filling = clamp_half(body.get("scoreFilling", 0))
        approx_price = max(0.0, float(body.get("approxPrice") or 0))
        visited_at = str(body.get("visitedAt", "")).strip() or time.strftime("%Y-%m-%d")
        reeval_at = str(body.get("reevaluatedAt") or "").strip() or None
        reeval_note = str(body.get("reevaluationNote") or "").strip()
        edition_year = int(body.get("editionYear") or 2026)
        category = str(body.get("category", "Fatia de Vitrine")).strip() or "Fatia de Vitrine"
        flavor_type = str(body.get("flavorType", "")).strip() or "Especial"
        today = time.strftime("%Y-%m-%d")

        if existing_id:
            cur.execute(
                """UPDATE cakes SET
                   bakery_id = ?, slug = ?, name = ?, category = ?, flavor_type = ?,
                   photos_json = ?, score_flavor = ?, score_dough = ?, score_texture = ?,
                   score_filling = ?, kai_verdict = ?, sensory_notes_json = ?,
                   approx_price = ?, visited_at = ?, reevaluated_at = ?, reevaluation_note = ?,
                   edition_year = ?
                   WHERE id = ?""",
                (
                    bakery_id, unique_slug, name, category, flavor_type,
                    json.dumps(photos, ensure_ascii=False), s_flavor, s_dough, s_texture,
                    s_filling, verdict, json.dumps(sensory_clean, ensure_ascii=False),
                    approx_price, visited_at, reeval_at, reeval_note,
                    edition_year, existing_id
                )
            )
        else:
            cur.execute(
                """INSERT INTO cakes
                   (id, bakery_id, slug, name, category, flavor_type, photos_json,
                    score_flavor, score_dough, score_texture, score_filling, kai_verdict,
                    sensory_notes_json, approx_price, visited_at, reevaluated_at,
                    reevaluation_note, edition_year, react_water, react_agree, react_try, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)""",
                (
                    cake_id, bakery_id, unique_slug, name, category, flavor_type,
                    json.dumps(photos, ensure_ascii=False), s_flavor, s_dough, s_texture,
                    s_filling, verdict, json.dumps(sensory_clean, ensure_ascii=False),
                    approx_price, visited_at, reeval_at, reeval_note, edition_year, today
                )
            )

        conn.commit()
        conn.close()
        sync_static_snapshot()
        return self.send_json({"ok": True, "id": cake_id, "slug": unique_slug})


def build_github_pages(out_dir_str: str = "docs"):
    """
    Gera o pacote 100% estático (HTML pré-renderizado com Open Graph + JSON + Assets)
    para publicação direta no GitHub Pages (via GitHub Actions ou pasta docs/).
    """
    init_db(reset_to_clean=False)
    sync_static_snapshot()

    out_dir = (BASE_DIR / out_dir_str).resolve()
    if out_dir.exists():
        shutil.rmtree(out_dir)
    shutil.copytree(PUBLIC_DIR, out_dir)

    if UPLOADS_DIR.exists():
        shutil.copytree(UPLOADS_DIR, out_dir / "uploads", dirs_exist_ok=True)

    base_path = os.environ.get("SUGARCUBE_BASE_PATH", "").rstrip("/")
    site_url = (SITE_BASE_URL or "https://sugarcube-corner.github.io").rstrip("/")
    full_base_url = f"{site_url}{base_path}"

    def rewrite_subpath(html_bytes: bytes) -> bytes:
        if not base_path:
            return html_bytes
        txt = html_bytes.decode("utf-8")
        for prefix in ("/css/", "/js/", "/assets/", "/uploads/", "/favicon.ico", "/ranking", "/mapa", "/em-breve", "/sobre", "/admin", "/confeitaria/", "/bolo/"):
            txt = txt.replace(f'href="{prefix}', f'href="{base_path}{prefix}')
            txt = txt.replace(f'src="{prefix}', f'src="{base_path}{prefix}')
        txt = txt.replace('href="/"', f'href="{base_path}/"')
        return txt.encode("utf-8")

    # 1. Rota raiz e 404.html (fallback SPA nativo do GitHub Pages para novas rotas criadas via API)
    root_html = rewrite_subpath(render_html_with_seo("/", full_base_url))
    (out_dir / "index.html").write_bytes(root_html)
    (out_dir / "404.html").write_bytes(root_html)
    (out_dir / ".nojekyll").write_text("", encoding="utf-8")

    # 2. Rotas fixas pré-renderizadas
    for route in ("ranking", "mapa", "em-breve", "sobre", "admin"):
        r_dir = out_dir / route
        r_dir.mkdir(parents=True, exist_ok=True)
        (r_dir / "index.html").write_bytes(
            rewrite_subpath(render_html_with_seo(f"/{route}", full_base_url))
        )

    # 3. Páginas individuais de Confeitarias e Bolos com Open Graph específico
    payload = get_public_data_payload()
    for b in payload.get("bakeries", []):
        b_dir = out_dir / "confeitaria" / b["slug"]
        b_dir.mkdir(parents=True, exist_ok=True)
        (b_dir / "index.html").write_bytes(
            rewrite_subpath(render_html_with_seo(f"/confeitaria/{b['slug']}", full_base_url))
        )

    for c in payload.get("cakes", []):
        c_dir = out_dir / "bolo" / c["slug"]
        c_dir.mkdir(parents=True, exist_ok=True)
        (c_dir / "index.html").write_bytes(
            rewrite_subpath(render_html_with_seo(f"/bolo/{c['slug']}", full_base_url))
        )

    # 4. Sitemap.xml e Robots.txt
    (out_dir / "sitemap.xml").write_bytes(generate_sitemap_xml(full_base_url))
    robots_txt = f"User-agent: *\nAllow: /\nDisallow: {base_path}/admin\nSitemap: {full_base_url}/sitemap.xml\n"
    (out_dir / "robots.txt").write_text(robots_txt, encoding="utf-8")
    shutil.copy2(PUBLIC_DIR / "assets" / "sugarcube-icon.png", out_dir / "favicon.ico")

    print(f"[OK] Build estático para GitHub Pages concluído em: {out_dir}")


def run_server(port=8080, reset_clean=False, set_password=None):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    init_db(reset_to_clean=reset_clean, new_admin_password=set_password)
    server_address = ("", port)
    httpd = ThreadingHTTPServer(server_address, SugarcubeSecureHandler)
    print("============================================================")
    print("Sugarcube Corner (por Kai Tavares) - Feira de Santana, BA")
    print(f"Servidor Multi-Thread seguro em: http://localhost:{port}")
    print(f"Pasta publica isolada: {PUBLIC_DIR}")
    print(f"Banco SQLite relacional: {DB_PATH}")
    print(f"Credenciais locais salvas em: {INITIAL_CREDENTIALS_PATH}")
    print("============================================================", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nEncerrando servidor...")
        httpd.server_close()


if __name__ == "__main__":
    if "--build-pages" in sys.argv:
        idx = sys.argv.index("--build-pages")
        target_dir = sys.argv[idx + 1] if idx + 1 < len(sys.argv) else "docs"
        build_github_pages(target_dir)
        sys.exit(0)

    reset_flag = "--reset-clean" in sys.argv
    new_pwd = None
    if "--set-password" in sys.argv:
        idx = sys.argv.index("--set-password")
        if idx + 1 < len(sys.argv):
            new_pwd = sys.argv[idx + 1]

    port_num = int(os.environ.get("PORT", 8080))
    for arg in sys.argv[1:]:
        if arg.isdigit():
            port_num = int(arg)
            break

    run_server(port=port_num, reset_clean=reset_flag, set_password=new_pwd)
