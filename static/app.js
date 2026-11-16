const $ = id => document.getElementById(id);
let allServers = [], refreshTimer, previousPlayers = null, editingMeetupId = null;
const voterId = (() => {
  let id = localStorage.getItem("lg_voter_id");
  if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : "lg-"+Date.now()+"-"+Math.random().toString(36).slice(2)); localStorage.setItem("lg_voter_id", id); }
  return id;
})();
const playerNameKey = "lg_player_name";
const avatarKey = "lg_player_avatar";
const validAvatars = ["blaster","deputy","gunslinger","trapper"];
function currentAvatar(){const saved=localStorage.getItem(avatarKey);return validAvatars.includes(saved)?saved:"blaster";}
function avatarMarkup(avatar, size="small"){
  const safe=validAvatars.includes(avatar)?avatar:"blaster";
  const label=safe.charAt(0).toUpperCase()+safe.slice(1);
  return `<img class="attendee-avatar ${size}" src="/static/img/avatars/${safe}.png" alt="${label}" title="${label}">`;
}
function setAvatar(avatar){
  if(!validAvatars.includes(avatar))return;
  localStorage.setItem(avatarKey,avatar);
  document.querySelectorAll(".avatar-option").forEach(b=>{
    const selected=b.dataset.avatar===avatar;
    b.classList.toggle("selected",selected);
    b.setAttribute("aria-pressed",String(selected));
  });
  $("avatarStatus").textContent="Personaje seleccionado: "+avatar.charAt(0).toUpperCase()+avatar.slice(1);
}
function currentPlayerName(){ return (localStorage.getItem(playerNameKey)||"").trim().slice(0,24); }
function savePlayerName(){
  const value=$("playerName").value.trim().replace(/\s+/g," ").slice(0,24);
  $("playerName").value=value;
  if(value){localStorage.setItem(playerNameKey,value);$("profileStatus").textContent="Apodo guardado en este dispositivo";}
  else{localStorage.removeItem(playerNameKey);$("profileStatus").textContent="Escribe un apodo para votar";}
}
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
  rows.sort((a,b)=>sort==="name"?a.name.localeCompare(b.name):b.players-a.players);
  $("serverRows").innerHTML=rows.map(s=>{
    return `<tr><td><div class="server-cell"><span class="status-dot"></span><div><span class="server-name">${esc(s.name)}</span><span class="server-address">${esc(s.address)}</span></div></div></td><td><span class="map-name">${esc(s.map)}</span></td><td><span class="players">${s.players}<span> / ${s.max_players}</span></span></td><td><button class="join" data-address="${esc(s.address)}" title="Abrir Lead and Gold e intentar conectar con este servidor">▶ JUGAR</button></td></tr>`;
  }).join("");
  $("emptyState").hidden=rows.length!==0;
  $("resultCount").textContent=`${rows.length} servidor${rows.length===1?"":"es"}`;
  document.querySelectorAll(".join").forEach(b=>b.addEventListener("click",async()=>{
    const address = (b.dataset.address || "").trim();
    if (!/^[a-zA-Z0-9.\\-\\[\\]:]+$/.test(address) || !address.includes(":")) {
      alert("La dirección de este servidor no parece válida.");
      return;
    }
    // Steam's connect URI asks the installed Steam client to join this game server.
    // The game-specific direct-join behavior must still be verified on a player's PC.
    const steamUrl = `steam://connect/${address}`;
    const original = b.textContent;
    b.textContent = "Abriendo Steam…";
    window.location.href = steamUrl;
    // Keep a manual fallback in case the browser/Steam client does not handle the URI.
    setTimeout(async()=>{
      try {
        await navigator.clipboard.writeText(address);
        b.textContent = "IP copiada · prueba Steam";
        b.title = `Si no se abrió el juego, pega esta dirección en el navegador de servidores: ${address}`;
      } catch {
        b.textContent = "Steam · " + address;
        b.title = `Si no se abrió el juego, usa esta dirección: ${address}`;
      }
      setTimeout(()=>{ b.textContent = original; }, 3500);
    }, 1600);
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
  }catch(e){$("notice").className="notice error";$("notice").textContent="No se pudo conectar con el backend."; $("serverRows").innerHTML='<tr><td colspan="4" class="empty">Servicio temporalmente no disponible.</td></tr>';}
  finally{btn.disabled=false;btn.innerHTML="<span>↻</span> Actualizar";}
}
async function loadMeetups(){
  try{
    const res=await fetch("/api/meetups",{cache:"no-store"}); if(!res.ok)throw new Error("No se pudieron cargar las quedadas");
    const data=await res.json(), items=data.meetups||[];
    $("meetupNotice").textContent=`${items.length} quedada(s) publicadas · Los votos son comunitarios`;
    $("meetups").innerHTML=items.length?items.map(m=>{
      const date=m.event_at?new Date(m.event_at).toLocaleString("es-ES",{dateStyle:"full",timeStyle:"short"}):"Fecha por confirmar";
      const attendeeList=(list,empty)=>list.length?list.map(v=>`<span class="attendee-person">${avatarMarkup(v.avatar)}<span>${esc(v.name)}</span></span>`).join(""):empty;
      const yesNames=attendeeList(m.yes_voters||[],"Todavía nadie");
      const noNames=attendeeList(m.no_voters||[],"Nadie");
      const ownerActions = m.creator_id && m.creator_id === voterId ? `<div class="meetup-owner-actions"><button class="meetup-edit" data-id="${m.id}">✎ Editar</button><button class="meetup-delete" data-id="${m.id}">🗑 Eliminar</button></div>` : "";
      return `<article class="meetup-card"><div><div class="meetup-title">${esc(m.title)}</div><div class="meetup-date">◷ ${esc(date)}</div>${m.details?`<div class="meetup-details">${esc(m.details)}</div>`:""}${ownerActions}</div><div class="vote-actions"><button class="vote-btn yes" data-id="${m.id}" data-vote="1">👍 <span class="vote-count">${m.yes_count||0}</span></button><button class="vote-btn no" data-id="${m.id}" data-vote="-1">👎 <span class="vote-count">${m.no_count||0}</span></button></div><div class="attendee-lists"><div class="attendee-group yes"><strong>👍 Vienen (${m.yes_count||0})</strong><div class="attendee-names">${yesNames}</div></div><div class="attendee-group no"><strong>👎 No pueden (${m.no_count||0})</strong><div class="attendee-names">${noNames}</div></div></div></article>`;
    }).join(""):'<div class="empty-meetups">Todavía no hay quedadas. ¡Publica la primera!</div>';
    document.querySelectorAll(".vote-btn").forEach(b=>b.addEventListener("click",()=>sendVote(b)));
    document.querySelectorAll(".meetup-edit").forEach(b=>b.addEventListener("click",()=>startMeetupEdit(b.dataset.id,items)));
    document.querySelectorAll(".meetup-delete").forEach(b=>b.addEventListener("click",()=>deleteMeetup(b.dataset.id)));
  }catch(e){$("meetupNotice").className="notice error";$("meetupNotice").textContent="No se pudo conectar con el tablón. Inténtalo de nuevo más tarde.";}
}
function startMeetupEdit(id, items){
  const meetup=items.find(m=>String(m.id)===String(id)); if(!meetup)return;
  editingMeetupId=meetup.id;
  $("meetupTitle").value=meetup.title||"";
  $("meetupDetails").value=meetup.details||"";
  $("meetupDate").value=meetup.event_at||"";
  $("meetupSubmit").textContent="Guardar cambios";
  $("cancelMeetupEdit").hidden=false;
  $("meetupForm").scrollIntoView({behavior:"smooth",block:"center"});
}
function cancelMeetupEdit(){
  editingMeetupId=null; $("meetupForm").reset(); $("meetupSubmit").textContent="＋ Publicar quedada"; $("cancelMeetupEdit").hidden=true;
}
async function deleteMeetup(id){
  if(!confirm("¿Seguro que quieres eliminar esta quedada? También se borrarán sus votos."))return;
  try{
    const res=await fetch(`/api/meetups/${id}?creator_id=${encodeURIComponent(voterId)}`,{method:"DELETE"});
    const data=await res.json().catch(()=>({})); if(!res.ok)throw new Error(data.detail||"No se pudo eliminar la quedada.");
    if(String(editingMeetupId)===String(id))cancelMeetupEdit();
    await loadMeetups();
  }catch(err){alert(err.message);}
}
async function sendVote(button){
  const name=currentPlayerName();
  if(!name){$("playerName").focus();alert("Antes de votar, escribe tu apodo en el apartado de comunidad.");return;}
  button.disabled=true;
  try{
    const res=await fetch(`/api/meetups/${button.dataset.id}/vote`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({voter_id:voterId,voter_name:name,avatar:currentAvatar(),vote:Number(button.dataset.vote)})});
    if(!res.ok)throw new Error("No se pudo guardar el voto");
    await loadMeetups();
  }catch(e){alert(e.message);}finally{button.disabled=false;}
}
$("playerName").value=currentPlayerName();
setAvatar(currentAvatar());
document.querySelectorAll(".avatar-option").forEach(b=>b.addEventListener("click",()=>setAvatar(b.dataset.avatar)));
if(currentPlayerName())$("profileStatus").textContent="Apodo guardado en este dispositivo";
$("playerName").addEventListener("change",savePlayerName);
$("playerName").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();savePlayerName();}});
$("meetupForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const title=$("meetupTitle").value.trim(); if(title.length<2)return;
  const button=$("meetupSubmit");button.disabled=true;button.textContent=editingMeetupId?"Guardando…":"Publicando…";
  const payload={title,details:$("meetupDetails").value,event_at:$("meetupDate").value,creator_id:voterId};
  try{
    const url=editingMeetupId?`/api/meetups/${editingMeetupId}`:"/api/meetups";
    const res=await fetch(url,{method:editingMeetupId?"PUT":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    const data=await res.json().catch(()=>({})); if(!res.ok)throw new Error(data.detail||"No se pudo guardar la quedada");
    cancelMeetupEdit();await loadMeetups();
  }catch(err){alert(err.message);}finally{button.disabled=false;button.textContent=editingMeetupId?"Guardar cambios":"＋ Publicar quedada";}
});
$("cancelMeetupEdit").addEventListener("click",cancelMeetupEdit);
["search","occupancy","sort"].forEach(id=>$(id).addEventListener(id==="search"?"input":"change",render));
$("refreshBtn").addEventListener("click",()=>load(true));
$("bellBtn").addEventListener("click",enableBell);
if("Notification" in window && Notification.permission==="granted")$("bellLabel").textContent="Avisos activados";
load();loadMeetups();
refreshTimer=setInterval(()=>{load(false);loadMeetups();},45000);
