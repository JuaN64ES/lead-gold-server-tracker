# Lead & Gold Server Tracker

Web pública para consultar servidores de **Lead & Gold: Gangs of the Wild West** (Steam App ID 42120).

## Qué incluye
- Interfaz moderna y responsive.
- Backend FastAPI que consulta Steam Game Servers Service.
- Consultas A2S_INFO a los servidores encontrados.
- Nombre, mapa, jugadores, slots y dirección.
- Filtros, ordenación, contador y actualización automática.
- No utiliza servidores ni estadísticas ficticias.

## Requisito: clave de Steam Web API
El directorio de servidores de Steam requiere una Steam Web API Key. Solicítala en:
https://steamcommunity.com/dev/apikey

Añade la clave como variable de entorno `STEAM_API_KEY` en el proveedor de hosting. No la pongas en `static/app.js` ni en el HTML.

## Ejecutar en local
Requiere Python 3.11+.

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
```

Configura `STEAM_API_KEY`:
- Windows PowerShell: `$env:STEAM_API_KEY="TU_CLAVE"`
- macOS/Linux: `export STEAM_API_KEY="TU_CLAVE"`

Después:
```bash
uvicorn main:app --reload
```
Abre http://127.0.0.1:8000

## Publicar en Render
1. Sube esta carpeta a un repositorio GitHub.
2. En Render, crea un servicio nuevo desde ese repositorio (Blueprint o Docker).
3. Render detectará `render.yaml`.
4. En Environment, añade `STEAM_API_KEY` con tu clave.
5. Despliega y abre la URL pública que Render asigne.

También puedes desplegar el Dockerfile en cualquier hosting compatible con contenedores.

## Consideraciones importantes
- El servidor de hosting debe permitir tráfico UDP saliente para consultas A2S. Algunos proveedores o planes bloquean UDP; si ocurre, la web puede descubrir servidores en Steam pero no obtener detalles A2S hasta cambiar a un proveedor que permita UDP.
- El directorio de Steam puede no devolver servidores si no hay ninguno publicado/activo o si el filtro de App ID no coincide con el registro del servidor.
- El ping mostrado es el tiempo de respuesta de la consulta A2S medido desde el backend; puede diferir del ping que cada jugador obtiene desde su ubicación.
- La API key debe mantenerse como secreto del servidor.
- La web es un proyecto comunitario no oficial y no está afiliada a Valve ni Fatshark.
