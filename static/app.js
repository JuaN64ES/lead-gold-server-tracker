const $ = id => document.getElementById(id);
let allServers = [];
let refreshTimer;

function esc(s){return String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function formatTime(ts){if(!ts)return "Sin datos";return new Date(ts*1000).toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit",second:"2-digit"});}
function render(){
  const q=$("search").value.trim().toLowerCase(), occupancy=$("occupancy").value, sort=$("sort").value;
  let rows=allServers.filter(s=>(s.name+" "+s.map+" "+s.address).toLowerCase().includes(q));
  if(occupancy==="players")rows=rows.filter(s=>s.players>0);
  if(occupancy==="empty")rows=rows.filter(s=>s.players===0);
  if(occupancy==="notfull")rows=rows.filter(s=>s.players<s.max_players);
  rows.sort((a,b)=>sort==="name"?a.name.localeCompare(b.name):sort==="ping"?(a.ping_ms??99999)-(b.ping_ms??99999):b.players-a.players);
  $("serverRows").innerHTML=rows.map(s=>{
    const ping=s.ping_ms==null?"—":`${Math.round(s.ping_ms)} ms`;
    const pc=s.ping_ms==null?"":s.ping_ms<80?"good":s.ping_ms<150?"mid":"";
    return `<tr><td><div class="server-cell"><span class="status-dot"></span><div><span class="server-name">${esc(s.name)}</span><span class="server-address">${esc(s.address)}</span></div></div></td><td><span class="map-name">${esc(s.map)}</span></td><td><span class="players">${s.players}<span> / ${s.max_players}</span></span></td><td><span class="ping ${pc}">${ping}</span></td><td><button class="join" data-address="${esc(s.address)}">Copiar IP</button></td></tr>`;
  }).join("");
  $("emptyState").hidden=rows.length!==0;
  $("resultCount").textContent=`${rows.length} servidor${rows.length===1?"":"es"}`;
  document.querySelectorAll(".join").forEach(b=>b.addEventListener("click",async()=>{
    try{await navigator.clipboard.writeText(b.dataset.address);b.textContent="Copiado ✓";setTimeout(()=>b.textContent="Copiar IP",1400);}
    catch{b.textContent=b.dataset.address;}
  }));
}
async function load(force=false){
  const btn=$("refreshBtn");btn.disabled=true;btn.innerHTML="<span>↻</span> Buscando…";
  $("notice").className="notice";$("notice").textContent="Consultando el directorio de servidores de Steam…";
  try{
    const res=await fetch("/api/servers"+(force?"?force=true":""),{cache:"no-store"});
    const data=await res.json();
    allServers=data.servers||[];
    $("totalServers").textContent=data.total_servers??"—";
    $("totalPlayers").textContent=data.total_players??"—";
    $("lastUpdate").textContent=formatTime(data.updated_at);
    $("refreshLabel").textContent=`Cada ${data.refresh_seconds||45} segundos`;
    if(data.error){
      $("notice").className="notice error";
      $("notice").textContent="No se pudo consultar Steam: "+data.error;
    }else if(!allServers.length){
      $("notice").textContent="Consulta completada. Steam no ha devuelto servidores activos para este juego en este momento.";
    }else{
      $("notice").textContent=`${allServers.length} servidor(es) respondieron correctamente · Datos reales`;
    }
    render();
  }catch(e){
    $("notice").className="notice error";$("notice").textContent="No se pudo conectar con el backend. Comprueba que el servicio esté iniciado.";
    $("serverRows").innerHTML='<tr><td colspan="5" class="empty">Servicio temporalmente no disponible.</td></tr>';
  }finally{btn.disabled=false;btn.innerHTML="<span>↻</span> Actualizar";}
}
["search","occupancy","sort"].forEach(id=>$(id).addEventListener(id==="search"?"input":"change",render));
$("refreshBtn").addEventListener("click",()=>load(true));
load();
refreshTimer=setInterval(()=>load(false),45000);
