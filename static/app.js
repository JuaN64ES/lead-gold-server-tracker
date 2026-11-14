const $ = id => document.getElementById(id);
let allServers = [], refreshTimer, previousPlayers = null;
const voterId = (() => {
  let id = localStorage.getItem("lg_voter_id");
  if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : "lg-"+Date.now()+"-"+Math.random().toString(36).slice(2)); localStorage.setItem("lg_voter_id", id); }
  return id;
})();
function esc(s){return String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function formatTime(ts){if(!ts)return "Sin datos";return new Date(ts*1000).toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit",second:"2-digit"});}
function checkThreshold(servers){
  const over = servers.filter(s=>Number(s.players)>5);
  if (previousPlayers !== null && "Notification" in window && Notification.permission==="granted") {
    over.forEach(s=>{
      const before = previousPlayers[s.address] || 0;
      if (before <= 5) new Notification("¡Servidor con más de 5 jugadores!", {body:`${s.name}: ${s.players}/${s.max_players} · ${s.map}`});
    });
  }
  previousPlayers = Object.fromEntries(servers.map(s=>[s.address,Number(s.players)||0]));
}
async function enableBell(){
  if (!("Notification" in window)) { alert("Este navegador no admite notificaciones."); return; }
  const permission = await Notification.requestPermission();
  $("bellLabel").textContent = permission==="granted" ? "Avisos activados" : "Avisos desactivados";
  if(permission==="granted") new Notification("Lead and Gold Multiplayer", {body:"Te avisaremos cuando un servidor supere los 5 jugadores mientras esta página esté abierta."});
}
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
    if(data.error){$("notice").className="notice error";$("notice").textContent="No se pudo consultar Steam: "+data.error;}
    else if(!allServers.length){$("notice").textContent="Consulta completada. Steam no ha devuelto servidores activos para este juego en este momento.";}
    else{$("notice").textContent=`${allServers.length} servidor(es) respondieron correctamente · Datos reales`;}
    checkThreshold(allServers);render();
  }catch(e){$("notice").className="notice error";$("notice").textContent="No se pudo conectar con el backend."; $("serverRows").innerHTML='<tr><td colspan="5" class="empty">Servicio temporalmente no disponible.</td></tr>';}
  finally{btn.disabled=false;btn.innerHTML="<span>↻</span> Actualizar";}
}
async function loadMeetups(){
  try{
    const res=await fetch("/api/meetups",{cache:"no-store"}); if(!res.ok)throw new Error("No se pudieron cargar las quedadas");
    const data=await res.json(), items=data.meetups||[];
    $("meetupNotice").textContent=`${items.length} quedada(s) publicadas · Los votos son comunitarios`;
    $("meetups").innerHTML=items.length?items.map(m=>{
      const date=m.event_at?new Date(m.event_at).toLocaleString("es-ES",{dateStyle:"full",timeStyle:"short"}):"Fecha por confirmar";
      return `<article class="meetup-card"><div><div class="meetup-title">${esc(m.title)}</div><div class="meetup-date">◷ ${esc(date)}</div>${m.details?`<div class="meetup-details">${esc(m.details)}</div>`:""}</div><div class="vote-actions"><button class="vote-btn yes" data-id="${m.id}" data-vote="1">👍 <span class="vote-count">${m.yes_count||0}</span></button><button class="vote-btn no" data-id="${m.id}" data-vote="-1">👎 <span class="vote-count">${m.no_count||0}</span></button></div></article>`;
    }).join(""):'<div class="empty-meetups">Todavía no hay quedadas. ¡Publica la primera!</div>';
    document.querySelectorAll(".vote-btn").forEach(b=>b.addEventListener("click",()=>sendVote(b)));
  }catch(e){$("meetupNotice").className="notice error";$("meetupNotice").textContent="No se pudo conectar con el tablón. Inténtalo de nuevo más tarde.";}
}
async function sendVote(button){
  button.disabled=true;
  try{
    const res=await fetch(`/api/meetups/${button.dataset.id}/vote`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({voter_id:voterId,vote:Number(button.dataset.vote)})});
    if(!res.ok)throw new Error("No se pudo guardar el voto");
    await loadMeetups();
  }catch(e){alert(e.message);}finally{button.disabled=false;}
}
$("meetupForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const title=$("meetupTitle").value.trim(); if(title.length<2)return;
  const button=e.submitter;button.disabled=true;button.textContent="Publicando…";
  try{
    const res=await fetch("/api/meetups",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title,details:$("meetupDetails").value,event_at:$("meetupDate").value})});
    if(!res.ok)throw new Error("No se pudo publicar la quedada");
    $("meetupForm").reset();await loadMeetups();
  }catch(err){alert(err.message);}finally{button.disabled=false;button.textContent="＋ Publicar quedada";}
});
["search","occupancy","sort"].forEach(id=>$(id).addEventListener(id==="search"?"input":"change",render));
$("refreshBtn").addEventListener("click",()=>load(true));
$("bellBtn").addEventListener("click",enableBell);
if("Notification" in window && Notification.permission==="granted")$("bellLabel").textContent="Avisos activados";
load();loadMeetups();
refreshTimer=setInterval(()=>{load(false);loadMeetups();},45000);
