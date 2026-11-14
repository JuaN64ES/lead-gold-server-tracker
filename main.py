import os, asyncio, time, socket
from typing import Any
import httpx
import a2s
from fastapi import FastAPI, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

APP_ID = 42120
STEAM_API_KEY = os.getenv("STEAM_API_KEY", "").strip()
MAX_SERVERS = int(os.getenv("MAX_SERVERS", "100"))
QUERY_TIMEOUT = float(os.getenv("QUERY_TIMEOUT", "2.0"))
REFRESH_SECONDS = int(os.getenv("REFRESH_SECONDS", "45"))

app = FastAPI(title="Lead & Gold Server Tracker")
_cache: dict[str, Any] = {"at": 0, "servers": [], "error": None}
_lock = asyncio.Lock()

async def get_master_servers():
    if not STEAM_API_KEY:
        raise RuntimeError("Falta configurar STEAM_API_KEY en las variables de entorno.")
    url = "https://api.steampowered.com/IGameServersService/GetServerList/v1/"
    params = {
        "key": STEAM_API_KEY,
        "filter": f"\\appid\\{APP_ID}",
        "limit": str(MAX_SERVERS),
    }
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(url, params=params)
        response.raise_for_status()
        payload = response.json()
    return payload.get("response", {}).get("servers", [])

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
            "id": address,
            "name": info.server_name or "Servidor sin nombre",
            "map": info.map_name or "Desconocido",
            "players": int(info.player_count),
            "max_players": int(info.max_players),
            "ping_ms": ping_ms,
            "address": address,
            "game": info.game or "Lead and Gold",
            "online": True,
            "last_seen": int(time.time()),
        }
    except (socket.timeout, TimeoutError, OSError, Exception):
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
        "game": "Lead & Gold: Gangs of the Wild West",
        "app_id": APP_ID,
        "updated_at": data["at"] or None,
        "refresh_seconds": REFRESH_SECONDS,
        "total_servers": len(data["servers"]),
        "total_players": sum(s["players"] for s in data["servers"]),
        "servers": data["servers"],
        "error": data["error"],
        "live_data": True,
    }

@app.get("/")
async def home():
    return FileResponse("static/index.html")

app.mount("/static", StaticFiles(directory="static"), name="static")
