import os, asyncio, time, sqlite3, json, secrets, hashlib, re, uuid, logging
from typing import Any
from contextlib import contextmanager
import httpx
import a2s
from fastapi import FastAPI, Query, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

logger = logging.getLogger("leadgold.players")

APP_ID = 42120
STEAM_API_KEY = os.getenv("STEAM_API_KEY", "").strip()
MAX_SERVERS = int(os.getenv("MAX_SERVERS", "100"))
QUERY_TIMEOUT = float(os.getenv("QUERY_TIMEOUT", "4.0"))
REFRESH_SECONDS = int(os.getenv("REFRESH_SECONDS", "45"))
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
DB_PATH = os.getenv("COMMUNITY_DB_PATH", "/tmp/leadgold-community.sqlite3")
VAPID_PRIVATE_KEY = os.getenv("VAPID_PRIVATE_KEY", "").replace("\\n", "\n").strip()
VAPID_SUBJECT = os.getenv("VAPID_SUBJECT", "mailto:admin@example.com").strip()
VAPID_PUBLIC_KEY = "BOrm2JJYlBR75a1RpK_429pg6SlLhCH4BdiMdxL9EO7nzjL3-HoWqaxzlTGVassW-AsdCq4Z0Cmi3toj6dSmS8w"

class DBConnection:
    def __init__(self, connection, is_postgres: bool):
        self.connection = connection
        self.is_postgres = is_postgres
    def execute(self, sql, params=()):
        if self.is_postgres:
            sql = sql.replace("?", "%s")
        return self.connection.execute(sql, params)
    def commit(self):
        self.connection.commit()

@contextmanager
def db():
    if DATABASE_URL:
        import psycopg
        from psycopg.rows import dict_row
        raw = psycopg.connect(DATABASE_URL, row_factory=dict_row, connect_timeout=10)
        wrapped = DBConnection(raw, True)
    else:
        raw = sqlite3.connect(DB_PATH, timeout=15)
        raw.row_factory = sqlite3.Row
        wrapped = DBConnection(raw, False)
    try:
        yield wrapped
        raw.commit()
    except Exception:
        raw.rollback()
        raise
    finally:
        raw.close()

_cache: dict[str, Any] = {"at": 0, "servers": [], "error": None}
_lock = asyncio.Lock()

def init_db():
    if DATABASE_URL:
        meetup_sql = """CREATE TABLE IF NOT EXISTS meetups (
            id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL,
            details TEXT NOT NULL DEFAULT '', event_at TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL, creator_id TEXT NOT NULL DEFAULT '')"""
        vote_sql = """CREATE TABLE IF NOT EXISTS votes (
            meetup_id BIGINT NOT NULL, voter_id TEXT NOT NULL,
            voter_name TEXT NOT NULL DEFAULT 'Jugador', avatar TEXT NOT NULL DEFAULT 'blaster', vote INTEGER NOT NULL CHECK(vote IN (-1,1)),
            PRIMARY KEY (meetup_id, voter_id),
            FOREIGN KEY(meetup_id) REFERENCES meetups(id) ON DELETE CASCADE)"""
    else:
        meetup_sql = """CREATE TABLE IF NOT EXISTS meetups (
            id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
            details TEXT NOT NULL DEFAULT '', event_at TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL, creator_id TEXT NOT NULL DEFAULT '')"""
        vote_sql = """CREATE TABLE IF NOT EXISTS votes (
            meetup_id INTEGER NOT NULL, voter_id TEXT NOT NULL,
            voter_name TEXT NOT NULL DEFAULT 'Jugador', avatar TEXT NOT NULL DEFAULT 'blaster', vote INTEGER NOT NULL CHECK(vote IN (-1,1)),
            PRIMARY KEY (meetup_id, voter_id),
            FOREIGN KEY(meetup_id) REFERENCES meetups(id) ON DELETE CASCADE)"""
    with db() as conn:
        conn.execute(meetup_sql)
        conn.execute(vote_sql)
        if DATABASE_URL:
            conn.execute("""CREATE TABLE IF NOT EXISTS player_identities (
                id TEXT PRIMARY KEY, nick TEXT NOT NULL, nick_key TEXT NOT NULL UNIQUE,
                code_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)""")
        else:
            conn.execute("""CREATE TABLE IF NOT EXISTS player_identities (
                id TEXT PRIMARY KEY, nick TEXT NOT NULL, nick_key TEXT NOT NULL UNIQUE,
                code_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)""")
        # One-time reset requested for the community board: remove existing meetups and votes.
        conn.execute("""CREATE TABLE IF NOT EXISTS app_migrations (
            migration_id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)""")
        reset_id = "2026-11-17-clear-existing-meetups"
        applied = conn.execute("SELECT migration_id FROM app_migrations WHERE migration_id=?", (reset_id,)).fetchone()
        if not applied:
            conn.execute("DELETE FROM votes")
            conn.execute("DELETE FROM meetups")
            conn.execute("INSERT INTO app_migrations(migration_id, applied_at) VALUES(?,?)",
                         (reset_id, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
        # Safe migration: store the browser identity that created each meetup.
        if DATABASE_URL:
            conn.execute("ALTER TABLE meetups ADD COLUMN IF NOT EXISTS creator_id TEXT NOT NULL DEFAULT ''")
        else:
            try:
                conn.execute("ALTER TABLE meetups ADD COLUMN creator_id TEXT NOT NULL DEFAULT ''")
            except sqlite3.OperationalError as exc:
                if "duplicate column" not in str(exc).lower():
                    raise
        # Safe migration for databases created by the previous version.
        if DATABASE_URL:
            conn.execute("ALTER TABLE votes ADD COLUMN IF NOT EXISTS voter_name TEXT NOT NULL DEFAULT 'Jugador'")
        else:
            try:
                conn.execute("ALTER TABLE votes ADD COLUMN voter_name TEXT NOT NULL DEFAULT 'Jugador'")
            except sqlite3.OperationalError as exc:
                if "duplicate column" not in str(exc).lower():
                    raise
        if DATABASE_URL:
            conn.execute("ALTER TABLE votes ADD COLUMN IF NOT EXISTS avatar TEXT NOT NULL DEFAULT 'blaster'")
        else:
            try:
                conn.execute("ALTER TABLE votes ADD COLUMN avatar TEXT NOT NULL DEFAULT 'blaster'")
            except sqlite3.OperationalError as exc:
                if "duplicate column" not in str(exc).lower():
                    raise
        if DATABASE_URL:
            conn.execute("""CREATE TABLE IF NOT EXISTS push_subscriptions (
                endpoint TEXT PRIMARY KEY, subscription_json TEXT NOT NULL, created_at TEXT NOT NULL)""")
            conn.execute("""CREATE TABLE IF NOT EXISTS server_player_state (
                address TEXT PRIMARY KEY, players INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)""")
        else:
            conn.execute("""CREATE TABLE IF NOT EXISTS push_subscriptions (
                endpoint TEXT PRIMARY KEY, subscription_json TEXT NOT NULL, created_at TEXT NOT NULL)""")
            conn.execute("""CREATE TABLE IF NOT EXISTS server_player_state (
                address TEXT PRIMARY KEY, players INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)""")

app = FastAPI(title="Lead & Gold Multiplayer")

@app.on_event("startup")
async def startup():
    init_db()

class MeetupIn(BaseModel):
    identity_code: str = Field(min_length=20, max_length=200)
    title: str = Field(min_length=2, max_length=100)
    details: str = Field(default="", max_length=500)
    event_at: str = Field(default="", max_length=40)
    creator_id: str = Field(min_length=8, max_length=80)

class MeetupEditIn(BaseModel):
    identity_code: str = Field(min_length=20, max_length=200)
    title: str = Field(min_length=2, max_length=100)
    details: str = Field(default="", max_length=500)
    event_at: str = Field(default="", max_length=40)
    creator_id: str = Field(min_length=8, max_length=80)

class VoteIn(BaseModel):
    identity_code: str = Field(min_length=20, max_length=200)
    voter_id: str = Field(min_length=8, max_length=80)
    voter_name: str = Field(min_length=1, max_length=24)
    vote: int
    avatar: str = Field(default="blaster", max_length=20)

class IdentityRegisterIn(BaseModel):
    nick: str = Field(min_length=1, max_length=24)

class IdentityLoginIn(BaseModel):
    code: str = Field(min_length=20, max_length=200)

def normalize_nick(nick: str) -> str:
    clean = " ".join(nick.split()).strip()
    if not re.fullmatch(r"[\w .-]{2,24}", clean, flags=re.UNICODE):
        raise HTTPException(400, "El nick debe tener entre 2 y 24 caracteres y solo puede contener letras, números, espacios, puntos o guiones.")
    return clean

def identity_from_code(conn, code: str):
    digest = hashlib.sha256(code.strip().encode("utf-8")).hexdigest()
    row = conn.execute("SELECT id, nick FROM player_identities WHERE code_hash=?", (digest,)).fetchone()
    if not row:
        raise HTTPException(403, "Código de identidad incorrecto. No se ha podido verificar tu nick.")
    return row

AVATARS = {"blaster", "deputy", "gunslinger", "trapper"}

class PushSubscriptionIn(BaseModel):
    subscription: dict

def save_push_subscription(subscription: dict):
    endpoint = str(subscription.get("endpoint", "")).strip()
    keys = subscription.get("keys") or {}
    if not endpoint.startswith("https://") or not keys.get("p256dh") or not keys.get("auth"):
        raise HTTPException(400, "La suscripción de notificaciones no es válida.")
    payload = json.dumps(subscription, separators=(",", ":"))
    with db() as conn:
        conn.execute("""INSERT INTO push_subscriptions(endpoint,subscription_json,created_at)
            VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET subscription_json=excluded.subscription_json""",
            (endpoint, payload, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))

def send_one_push(subscription: dict, payload: dict):
    from pywebpush import webpush
    return webpush(
        subscription_info=subscription,
        data=json.dumps(payload, ensure_ascii=False),
        vapid_private_key=VAPID_PRIVATE_KEY,
        vapid_claims={"sub": VAPID_SUBJECT}
    )

async def process_server_alerts(servers: list[dict]):
    # Only maintain transition state once the VAPID secret is configured.
    if not VAPID_PRIVATE_KEY:
        return
    current = {str(s["address"]): int(s.get("players", 0)) for s in servers if s.get("address")}
    now_text = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    alerts = []
    with db() as conn:
        previous_rows = conn.execute("SELECT address, players FROM server_player_state").fetchall()
        previous = {row["address"]: int(row["players"]) for row in previous_rows}
        for address, players in current.items():
            if previous.get(address, 0) <= 5 and players > 5 and address in previous:
                alerts.append(next((s for s in servers if s.get("address") == address), {"address": address, "players": players}))
            conn.execute("""INSERT INTO server_player_state(address,players,updated_at) VALUES(?,?,?)
                ON CONFLICT(address) DO UPDATE SET players=excluded.players, updated_at=excluded.updated_at""",
                (address, players, now_text))
        # A server missing from the latest master list is considered back to zero.
        for address in set(previous) - set(current):
            conn.execute("UPDATE server_player_state SET players=0, updated_at=? WHERE address=?", (now_text, address))
        if alerts:
            rows = conn.execute("SELECT subscription_json FROM push_subscriptions").fetchall()
            subscriptions = [json.loads(row["subscription_json"]) for row in rows]
        else:
            subscriptions = []
    if not alerts or not subscriptions:
        return
    expired = []
    for server in alerts:
        payload = {
            "title": "¡Servidor con más de 5 jugadores!",
            "body": f'{server.get("name", "Servidor")}: {server.get("players", 0)}/{server.get("max_players", "?")} · {server.get("map", "Mapa desconocido")}',
            "url": "/"
        }
        for subscription in subscriptions:
            try:
                await asyncio.to_thread(send_one_push, subscription, payload)
            except Exception as exc:
                status = getattr(getattr(exc, "response", None), "status_code", None)
                if status in (404, 410):
                    expired.append(subscription.get("endpoint", ""))
    if expired:
        with db() as conn:
            for endpoint in set(expired):
                conn.execute("DELETE FROM push_subscriptions WHERE endpoint=?", (endpoint,))

async def get_master_servers():
    if not STEAM_API_KEY:
        raise RuntimeError("Falta configurar STEAM_API_KEY en las variables de entorno.")
    url = "https://api.steampowered.com/IGameServersService/GetServerList/v1/"
    params = {"key": STEAM_API_KEY, "filter": f"\\appid\\{APP_ID}", "limit": str(MAX_SERVERS)}
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(url, params=params)
        response.raise_for_status()
        return response.json().get("response", {}).get("servers", [])

def query_one(server):
    address = server.get("addr", "")
    if not address or ":" not in address:
        return None
    host, port_s = address.rsplit(":", 1)
    try:
        port = int(port_s)
    except ValueError:
        return None

    # Datos base entregados por la API de Steam como respaldo si el puerto UDP A2S está cerrado
    fallback_players = int(server.get("players", 0) or 0)
    fallback_max = int(server.get("max_players", 0) or 0)
    fallback_name = server.get("name") or "Servidor de Lead and Gold"
    fallback_map = server.get("map") or "Desconocido"

    try:
        started = time.perf_counter()
        info = a2s.info((host, port), timeout=QUERY_TIMEOUT)
        ping_ms = round((time.perf_counter() - started) * 1000, 1)
        a2s_players = int(info.player_count)
        real_players = fallback_players if (a2s_players == 0 and fallback_players > 0) else a2s_players
        return {
            "id": address,
            "name": info.server_name or fallback_name,
            "map": info.map_name or fallback_map,
            "players": real_players,
            "max_players": int(info.max_players) or fallback_max,
            "response_ms": ping_ms,
            "ping_ms": ping_ms,
            "latency_type": "a2s_backend_response",
            "address": address,
            "game": info.game or "Lead and Gold",
            "online": True,
            "last_seen": int(time.time())
        }
    except Exception:
        return {
            "id": address,
            "name": fallback_name,
            "map": fallback_map,
            "players": fallback_players,
            "max_players": fallback_max,
            "response_ms": None,
            "ping_ms": None,
            "latency_type": "steam_master_fallback",
            "address": address,
            "game": "Lead and Gold",
            "online": True,
            "last_seen": int(time.time())
        }

async def refresh():
    async with _lock:
        now = time.time()
        if _cache["at"] and now - _cache["at"] < REFRESH_SECONDS: return _cache
        try:
            master = await get_master_servers(); loop = asyncio.get_running_loop(); sem = asyncio.Semaphore(35)
            async def limited_query(s):
                async with sem: return await loop.run_in_executor(None, query_one, s)
            results = await asyncio.gather(*(limited_query(s) for s in master))
            servers = [x for x in results if x]
            servers.sort(key=lambda s: (-s["players"], s["ping_ms"] or 99999, s["name"].lower()))
            _cache.update({"at": now, "servers": servers, "error": None})
        except Exception as exc: _cache.update({"at": now, "servers": [], "error": str(exc)})
        return _cache

@app.get("/api/health")
async def health():
    # cron-job.org calls this once per minute; refresh server data and detect
    # only the transition from 5-or-fewer to 6-or-more players.
    data = await refresh()
    if not data["error"]:
        await process_server_alerts(data["servers"])
    return {"ok": True, "game_app_id": APP_ID, "servers_checked": len(data["servers"]), "push_configured": bool(VAPID_PRIVATE_KEY)}

@app.get("/api/push/public-key")
async def push_public_key():
    return {"publicKey": VAPID_PUBLIC_KEY, "configured": bool(VAPID_PRIVATE_KEY)}

@app.post("/api/push/subscribe")
async def push_subscribe(item: PushSubscriptionIn):
    save_push_subscription(item.subscription)
    return {"ok": True}

@app.delete("/api/push/subscribe")
async def push_unsubscribe(item: PushSubscriptionIn):
    endpoint = str(item.subscription.get("endpoint", "")).strip()
    with db() as conn:
        conn.execute("DELETE FROM push_subscriptions WHERE endpoint=?", (endpoint,))
    return {"ok": True}

@app.get("/sw.js")
async def service_worker():
    return FileResponse("static/sw.js", media_type="application/javascript", headers={"Service-Worker-Allowed": "/"})

@app.get("/api/server-players")
async def server_players(address: str = Query(..., min_length=3, max_length=128)):
    """Return live A2S player details for a server selected in the browser."""
    if ":" not in address:
        raise HTTPException(400, "Dirección de servidor no válida.")
    host, port_text = address.rsplit(":", 1)
    try:
        port = int(port_text)
        if not host or not (1 <= port <= 65535):
            raise ValueError()
    except ValueError:
        raise HTTPException(400, "Dirección de servidor no válida.")

    # Only allow addresses currently present in the live server list.
    data = await refresh()
    server = next((item for item in data["servers"] if item.get("address") == address), None)
    if not server:
        raise HTTPException(404, "El servidor ya no aparece como disponible.")

    try:
        raw_players = await asyncio.to_thread(a2s.players, (host, port), timeout=QUERY_TIMEOUT)
        players = []
        score_values = []
        for player in raw_players:
            raw_score = getattr(player, "score", None)
            raw_duration = getattr(player, "duration", None)
            # Diagnóstico: registrar disponibilidad/tipo de los campos sin guardar nicks.
            score_values.append(raw_score)
            players.append({
                "name": str(getattr(player, "name", "") or "Jugador sin nombre")[:64],
                "score": int(raw_score or 0),
                "duration_seconds": max(0, int(raw_duration or 0)),
                "score_available": raw_score is not None
            })
        zero_scores = sum(1 for value in score_values if value in (None, 0))
        logger.info(
            "A2S_PLAYER address=%s players=%d score_zero_or_missing=%d score_samples=%s "
            "a2s_library=%s",
            address, len(players), zero_scores, score_values[:20],
            getattr(a2s, "__version__", "version-no-expuesta")
        )
        players.sort(key=lambda player: (-player["score"], player["name"].lower()))

        # Completar si A2S_INFO reporta más jugadores que nombres devuelve A2S_PLAYER
        missing_count = max(0, int(server.get("players", 0)) - len(players))
        for _ in range(missing_count):
            players.append({
                "name": "Jugador conectando / oculto por Steam",
                "score": 0,
                "duration_seconds": 0
            })

        return {
            "server": server,
            "players": players,
            "players_available": True,
            "message": "Datos obtenidos directamente del servidor."
        }
    except Exception as exc:
        logger.exception("A2S_PLAYER failed address=%s error_type=%s", address, type(exc).__name__)
        return {
            "server": server,
            "players": [],
            "players_available": False,
            "message": f"No se pudo consultar A2S_PLAYER ({type(exc).__name__})."
        }

@app.get("/api/servers")
async def servers(force: bool = Query(False)):
    if force: _cache["at"] = 0
    data = await refresh()
    return {"game": "Lead & Gold: Gangs of the Wild West", "app_id": APP_ID,
        "updated_at": data["at"] or None, "refresh_seconds": REFRESH_SECONDS,
        "total_servers": len(data["servers"]), "total_players": sum(s["players"] for s in data["servers"]),
        "servers": data["servers"], "error": data["error"], "live_data": True}

@app.post("/api/identity/register")
async def register_identity(item: IdentityRegisterIn):
    nick = normalize_nick(item.nick)
    nick_key = nick.casefold()
    code = "LG-" + secrets.token_urlsafe(27)
    identity_id = str(uuid.uuid4())
    digest = hashlib.sha256(code.encode("utf-8")).hexdigest()
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with db() as conn:
        try:
            conn.execute("INSERT INTO player_identities(id,nick,nick_key,code_hash,created_at) VALUES(?,?,?,?,?)",
                         (identity_id, nick, nick_key, digest, now))
        except Exception as exc:
            if "unique" in str(exc).lower() or "duplicate" in str(exc).lower():
                raise HTTPException(409, "Ese nick ya está registrado. Elige otro o recupera tu identidad con tu código.")
            raise
    return {"ok": True, "identity_id": identity_id, "nick": nick, "code": code}

@app.post("/api/identity/login")
async def login_identity(item: IdentityLoginIn):
    digest = hashlib.sha256(item.code.strip().encode("utf-8")).hexdigest()
    with db() as conn:
        row = conn.execute("SELECT id,nick FROM player_identities WHERE code_hash=?", (digest,)).fetchone()
    if not row:
        raise HTTPException(403, "No se reconoce ese código de identidad.")
    return {"ok": True, "identity_id": row["id"], "nick": row["nick"]}

@app.get("/api/meetups")
async def list_meetups():
    with db() as conn:
        rows = conn.execute("SELECT * FROM meetups ORDER BY CASE WHEN event_at='' THEN 1 ELSE 0 END, event_at ASC, id DESC").fetchall()
        votes = conn.execute("SELECT meetup_id, voter_name, avatar, vote FROM votes ORDER BY voter_name ASC").fetchall()
    grouped = {}
    for v in votes:
        item = grouped.setdefault(v["meetup_id"], {"yes_voters": [], "no_voters": []})
        item["yes_voters" if v["vote"] == 1 else "no_voters"].append({"name": v["voter_name"], "avatar": v["avatar"]})
    result = []
    for row in rows:
        item = dict(row); names = grouped.get(row["id"], {"yes_voters": [], "no_voters": []})
        item.update(names); item["yes_count"] = len(names["yes_voters"]); item["no_count"] = len(names["no_voters"])
        result.append(item)
    return {"meetups": result}

@app.post("/api/meetups")
async def create_meetup(item: MeetupIn):
    title = item.title.strip()
    if len(title) < 2: raise HTTPException(400, "Escribe un título un poco más largo.")
    with db() as conn:
        identity = identity_from_code(conn, item.identity_code)
        if identity["id"] != item.creator_id.strip(): raise HTTPException(403, "La identidad no coincide con el código.")
        sql = "INSERT INTO meetups(title,details,event_at,created_at,creator_id) VALUES(?,?,?,?,?)"
        params = (title, item.details.strip(), item.event_at.strip(), time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), identity["id"])
        if DATABASE_URL:
            meetup_id = conn.execute(sql + " RETURNING id", params).fetchone()["id"]
        else:
            meetup_id = conn.execute(sql, params).lastrowid
    return {"ok": True, "id": meetup_id}

@app.put("/api/meetups/{meetup_id}")
async def edit_meetup(meetup_id: int, item: MeetupEditIn):
    title = item.title.strip()
    if len(title) < 2:
        raise HTTPException(400, "Escribe un título un poco más largo.")
    with db() as conn:
        identity = identity_from_code(conn, item.identity_code)
        if identity["id"] != item.creator_id.strip(): raise HTTPException(403, "La identidad no coincide con el código.")
        row = conn.execute("SELECT creator_id FROM meetups WHERE id=?", (meetup_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Quedada no encontrada.")
        if not row["creator_id"] or row["creator_id"] != item.creator_id.strip():
            raise HTTPException(403, "Solo quien creó esta quedada puede modificarla.")
        conn.execute("UPDATE meetups SET title=?, details=?, event_at=? WHERE id=?",
                     (title, item.details.strip(), item.event_at.strip(), meetup_id))
    return {"ok": True}

@app.delete("/api/meetups/{meetup_id}")
async def delete_meetup(meetup_id: int, creator_id: str = Query(..., min_length=8, max_length=80), identity_code: str = Query(..., min_length=20, max_length=200)):
    with db() as conn:
        identity = identity_from_code(conn, identity_code)
        if identity["id"] != creator_id.strip(): raise HTTPException(403, "La identidad no coincide con el código.")
        row = conn.execute("SELECT creator_id FROM meetups WHERE id=?", (meetup_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Quedada no encontrada.")
        if not row["creator_id"] or row["creator_id"] != creator_id.strip():
            raise HTTPException(403, "Solo quien creó esta quedada puede eliminarla.")
        conn.execute("DELETE FROM meetups WHERE id=?", (meetup_id,))
    return {"ok": True}

@app.post("/api/meetups/{meetup_id}/vote")
async def vote_meetup(meetup_id: int, item: VoteIn):
    if item.vote not in (-1, 1): raise HTTPException(400, "El voto debe ser 1 o -1.")
    voter = item.voter_id.strip(); name = " ".join(item.voter_name.split()).strip()
    if not name: raise HTTPException(400, "Escribe tu apodo antes de votar.")
    with db() as conn:
        identity = identity_from_code(conn, item.identity_code)
        if identity["id"] != voter: raise HTTPException(403, "La identidad no coincide con el código.")
        name = identity["nick"]
        exists = conn.execute("SELECT id FROM meetups WHERE id=?", (meetup_id,)).fetchone()
        if not exists: raise HTTPException(404, "Quedada no encontrada.")
        conn.execute("""INSERT INTO votes(meetup_id,voter_id,voter_name,avatar,vote) VALUES(?,?,?,?,?)
            ON CONFLICT(meetup_id,voter_id) DO UPDATE SET voter_name=excluded.voter_name, avatar=excluded.avatar, vote=excluded.vote""",
            (meetup_id, voter, name[:24], item.avatar if item.avatar in AVATARS else "blaster", item.vote))
        counts = conn.execute("SELECT SUM(CASE WHEN vote=1 THEN 1 ELSE 0 END) yes_count, SUM(CASE WHEN vote=-1 THEN 1 ELSE 0 END) no_count FROM votes WHERE meetup_id=?", (meetup_id,)).fetchone()
    return {"ok": True, "yes_count": counts["yes_count"] or 0, "no_count": counts["no_count"] or 0}

@app.get("/")
async def home(): return FileResponse("static/index.html")

app.mount("/static", StaticFiles(directory="static"), name="static")