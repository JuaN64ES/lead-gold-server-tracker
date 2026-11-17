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
- La columna «Respuesta A2S» mide el tiempo que tarda una consulta A2S desde el backend alojado (Render). No es el ping real del jugador dentro del juego y puede ser muy distinto. Un navegador web normal no puede enviar las consultas UDP/A2S directamente al servidor del juego; por eso, sin instalar un auxiliar en el PC, no es posible obtener desde la página el mismo ping que calcula el cliente del juego. El campo `response_ms` identifica esta medición; `ping_ms` se conserva como alias de compatibilidad.
- La API key debe mantenerse como secreto del servidor.
- La web es un proyecto comunitario no oficial y no está afiliada a Valve ni Fatshark.


## Notificaciones push de servidores (Chrome/Windows)
La versión incluye Web Push mediante Service Worker y suscripciones guardadas en la misma base de datos configurada en `DATABASE_URL` (Neon).

Configura estas variables en Render > Environment:
- `VAPID_PRIVATE_KEY`: clave privada PEM generada para este proyecto. Mantenerla como secreto; no subirla a GitHub.
- `VAPID_SUBJECT`: contacto VAPID, por ejemplo `mailto:tu-correo@example.com`.

El endpoint `/api/health` actualiza la lista de servidores y detecta el cruce de 5 o menos a 6 o más jugadores. `cron-job.org` debe llamar a `https://TU-DOMINIO/api/health` cada minuto. El control de transición se guarda en la base de datos para evitar avisos repetidos mientras el servidor siga por encima de 5 jugadores. El primer sondeo crea la línea base; solo avisa en un cruce posterior.

Para activar avisos, abre la web en Chrome/Edge en Windows y pulsa **AVISAR** y acepta el permiso. El navegador debe permitir notificaciones de ese sitio. Los avisos push pueden mostrarse aunque la pestaña esté cerrada; el equipo y el navegador deben conservar la capacidad de recibir notificaciones push.

La frecuencia práctica de detección con la configuración gratuita actual es de aproximadamente **1 minuto**, porque cron-job.org ejecuta como mínimo cada minuto en la configuración usada. El refresco de la página continúa siendo cada 45 segundos cuando está abierta.


## Identidad única de la comunidad

La comunidad permite reservar un nick global mediante `POST /api/identity/register`. El servidor genera un código privado aleatorio y almacena únicamente su hash SHA-256. El nick se normaliza y se reserva sin distinguir mayúsculas/minúsculas. El código se muestra una sola vez; debe guardarse para recuperar la identidad en otro dispositivo mediante `POST /api/identity/login`.

Las acciones de crear/editar/eliminar quedadas y votar requieren el código privado, que se valida en el servidor. No se requiere correo electrónico ni cuenta tradicional. La identidad y los nicks se almacenan en la misma base de datos configurada por `DATABASE_URL` o `COMMUNITY_DB_PATH`.
