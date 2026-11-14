import os, asyncio, time, socket, sqlite3
from typing import Any
from pathlib import Path
import httpx
import a2s
from fastapi import FastAPI, Query, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

APP_ID = 42120
STEAM_API_KEY = os.getenv("STEAM_API_KEY", "").strip()
MAX_SERVERS = int(os.getenv("MAX_SERVERS", "100"))
QUERY_TIMEOUT = float(os.getenv("QUERY_TIMEOUT", "2.0"))
REFRESH_SECONDS = int(os.getenv("REFRESH_SECONDS", "45"))
DB_PATH = os.getenv("COMMUNITY_DB_PATH", "/tmp/leadgold-community.sqlite3")

app = FastAPI(title="Lead & Gold Multiplayer")
_cache: dict[str, Any] = {"at": 0, "servers": [], "error": None}
_lock = asyncio.Lock()

def db():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with db() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS meetups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            details TEXT NOT NULL DEFAULT '',
            event_at TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS votes (
            meetup_id INTEGER NOT NULL,
            voter_id TEXT NOT NULL,
            vote INTEGER NOT NULL CHECK(vote IN (-1,1)),
            PRIMARY KEY (meetup_id, voter_id),
            FOREIGN KEY(meetup_id) REFERENCES meetups(id) ON DELETE CASCADE
        )""")
        conn.commit()

@app.on_event("startup")
async def startup():
    init_db()

class MeetupIn(BaseModel):
    title: str = Field(min_length=2, max_length=100)
    details: str = Field(default="", max_length=500)
    event_at: str = Field(default="", max_length=40)

class VoteIn(BaseModel):
    voter_id: str = Field(min_length=8, max_length=80)
    vote: int

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
        started = time.perf_counter()
        info = a2s.info((host, port), timeout=QUERY_TIMEOUT)
        ping_ms = round((time.perf_counter() - started) * 1000, 1)
        return {
            "id": address, "name": info.server_name or "Servidor sin nombre",
            "map": info.map_name or "Desconocido", "players": int(info.player_count),
            "max_players": int(info.max_players), "ping_ms": ping_ms,
            "address": address, "game": info.game or "Lead and Gold",
            "online": True, "last_seen": int(time.time())
        }
    except Exception:
        return None

async def refresh():
    async with _lock:
        now = time.time()
        if _cache["at"] and now - _cache["at"] < REFRESH_SECONDS:
            return _cache
        try:
            master = await get_master_servers()
            loop = asyncio.get_running_loop()
            sem = asyncio.Semaphore(35)
            async def limited_query(s):
                async with sem:
                    return await loop.run_in_executor(None, query_one, s)
            results = await asyncio.gather(*(limited_query(s) for s in master))
            servers = [x for x in results if x]
            servers.sort(key=lambda s: (-s["players"], s["ping_ms"] or 99999, s["name"].lower()))
            _cache.update({"at": now, "servers": servers, "error": None})
        except Exception as exc:
            _cache.update({"at": now, "servers": [], "error": str(exc)})
        return _cache

@app.get("/api/health")
async def health():
    return {"ok": True, "game_app_id": APP_ID}

@app.get("/api/servers")
async def servers(force: bool = Query(False)):
    if force:
        _cache["at"] = 0
    data = await refresh()
    return {
        "game": "Lead & Gold: Gangs of the Wild West", "app_id": APP_ID,
        "updated_at": data["at"] or None, "refresh_seconds": REFRESH_SECONDS,
        "total_servers": len(data["servers"]),
        "total_players": sum(s["players"] for s in data["servers"]),
        "servers": data["servers"], "error": data["error"], "live_data": True
    }

@app.get("/api/meetups")
async def list_meetups():
    with db() as conn:
        rows = conn.execute("""
            SELECT m.*,
              SUM(CASE WHEN v.vote=1 THEN 1 ELSE 0 END) AS yes_count,
              SUM(CASE WHEN v.vote=-1 THEN 1 ELSE 0 END) AS no_count
            FROM meetups m LEFT JOIN votes v ON v.meetup_id=m.id
            GROUP BY m.id ORDER BY
              CASE WHEN m.event_at='' THEN 1 ELSE 0 END, m.event_at ASC, m.id DESC
        """).fetchall()
        return {"meetups": [dict(r) for r in rows]}

@app.post("/api/meetups")
async def create_meetup(item: MeetupIn):
    title = item.title.strip()
    if len(title) < 2:
        raise HTTPException(400, "Escribe un título un poco más largo.")
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO meetups(title,details,event_at,created_at) VALUES(?,?,?,?)",
            (title, item.details.strip(), item.event_at.strip(), time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        )
        conn.commit()
        meetup_id = cur.lastrowid
    return {"ok": True, "id": meetup_id}

@app.post("/api/meetups/{meetup_id}/vote")
async def vote_meetup(meetup_id: int, item: VoteIn):
    if item.vote not in (-1, 1):
        raise HTTPException(400, "El voto debe ser 1 o -1.")
    voter = item.voter_id.strip()
    with db() as conn:
        exists = conn.execute("SELECT id FROM meetups WHERE id=?", (meetup_id,)).fetchone()
        if not exists:
            raise HTTPException(404, "Quedada no encontrada.")
        conn.execute("""
            INSERT INTO votes(meetup_id,voter_id,vote) VALUES(?,?,?)
            ON CONFLICT(meetup_id,voter_id) DO UPDATE SET vote=excluded.vote
        """, (meetup_id, voter, item.vote))
        conn.commit()
        counts = conn.execute(
            "SELECT SUM(CASE WHEN vote=1 THEN 1 ELSE 0 END) yes_count, SUM(CASE WHEN vote=-1 THEN 1 ELSE 0 END) no_count FROM votes WHERE meetup_id=?",
            (meetup_id,)
        ).fetchone()
    return {"ok": True, "yes_count": counts["yes_count"] or 0, "no_count": counts["no_count"] or 0}

@app.get("/")
async def home():
    return FileResponse("static/index.html")

app.mount("/static", StaticFiles(directory="static"), name="static")
