const $ = id => document.getElementById(id);
let allServers = [], refreshTimer, editingMeetupId = null;
let voterId = localStorage.getItem("lg_identity_id") || "";
let identityCode = localStorage.getItem("lg_identity_code") || "";
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
  if(value && !voterId) $("profileStatus").textContent="Pulsa «Reservar nick» para registrarlo en toda la web";
}
async function registerNick(){
  const nick=$("playerName").value.trim().replace(/\s+/g," ");
  if(nick.length<2){alert("Escribe un nick de al menos 2 caracteres.");return;}
  const button=$("registerNick");button.disabled=true;button.textContent="Reservando…";
  try{
    const res=await fetch("/api/identity/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({nick})});
    const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.detail||"No se pudo reservar el nick.");
    activateIdentity(data.identity_id,data.code,data.nick);
    alert("¡Nick reservado!\n\nTu código privado es:\n\n"+data.code+"\n\nGuárdalo en un lugar seguro. No se volverá a mostrar y permite recuperar tu nick en otro dispositivo.");
  }catch(err){alert(err.message);}finally{button.disabled=false;button.textContent="Reservar nick";}
}
function activateIdentity(id,code,nick){
  voterId=id;identityCode=code||identityCode;
  localStorage.setItem("lg_identity_id",id);if(code)localStorage.setItem("lg_identity_code",code);
  localStorage.setItem(playerNameKey,nick);$("playerName").value=nick;$("playerName").disabled=true;
  $("profileStatus").textContent="✓ Nick protegido y reservado globalmente";
  loadMeetups();
}
async function recoverNick(){
  const code=$("identityCodeInput").value.trim();
  if(!code){alert("Introduce tu código privado.");return;}
  const button=$("recoverNick");button.disabled=true;button.textContent="Verificando…";
  try{
    const res=await fetch("/api/identity/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code})});
    const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.detail||"No se pudo recuperar la identidad.");
    activateIdentity(data.identity_id,code,data.nick);$("identityCodeInput").value="";
    alert("Identidad recuperada: "+data.nick);
  }catch(err){alert(err.message);}finally{button.disabled=false;button.textContent="Recuperar nick";}
}
function esc(s){return String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function formatTime(ts){if(!ts)return "Sin datos";return new Date(ts*1000).toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit",second:"2-digit"});}
function base64UrlToUint8Array(base64String){
  const padding="=".repeat((4-base64String.length%4)%4);
  const base64=(base64String+padding).replace(/-/g,"+").replace(/_/g,"/");
  const raw=atob(base64);
  return Uint8Array.from([...raw].map(char=>char.charCodeAt(0)));
}
async function enablePush(){
  const button=$("notifyBtn");
  if(!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)){
    alert("Este navegador no admite notificaciones push. Prueba con Chrome o Edge en Windows.");
    return;
  }
  if(!window.isSecureContext){
    alert("Las notificaciones necesitan una conexión HTTPS.");
    return;
  }
  button.disabled=true; button.textContent="ACTIVANDO…";
  try{
    const keyResponse=await fetch("/api/push/public-key",{cache:"no-store"});
    if(!keyResponse.ok)throw new Error("No se pudo obtener la configuración de notificaciones.");
    const keyData=await keyResponse.json();
    if(!keyData.configured)throw new Error("Falta configurar la clave privada de notificaciones en Render. La web todavía no está lista para activar los avisos.");
    const permission=await Notification.requestPermission();
    if(permission!=="granted")throw new Error("Has bloqueado los permisos de notificación. Puedes permitirlos desde los ajustes del sitio en Chrome.");
    const registration=await navigator.serviceWorker.register("/sw.js");
    let subscription=await registration.pushManager.getSubscription();
    if(!subscription){
      subscription=await registration.pushManager.subscribe({
        userVisibleOnly:true,
        applicationServerKey:base64UrlToUint8Array(keyData.publicKey)
      });
    }
    const save=await fetch("/api/push/subscribe",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({subscription:subscription.toJSON()})
    });
    if(!save.ok)throw new Error("No se pudo guardar la suscripción de avisos.");
    button.textContent="✓ AVISOS ACTIVOS";
    alert("¡Avisos activados! Chrome/Windows podrá mostrar notificaciones aunque cierres esta página. Recibirás un aviso cuando un servidor cruce de 5 o menos a 6 o más jugadores.");
  }catch(error){
    button.textContent="♧ AVISAR";
    alert(error.message||"No se pudieron activar las notificaciones.");
  }finally{button.disabled=false;}
}
function render(){
  const q=$("search").value.trim().toLowerCase(), occupancy=$("occupancy").value, sort=$("sort").value;
  let rows=allServers.filter(s=>(s.name+" "+s.map+" "+s.address).toLowerCase().includes(q));
  if(occupancy==="players")rows=rows.filter(s=>s.players>0);
  if(occupancy==="empty")rows=rows.filter(s=>s.players===0);
  if(occupancy==="notfull")rows=rows.filter(s=>s.players<s.max_players);
  rows.sort((a,b)=>sort==="name"?a.name.localeCompare(b.name):b.players-a.players);
  $("serverRows").innerHTML=rows.map(s=>{
    return `<tr class="server-row" data-address="${esc(s.address)}" tabindex="0" role="button" aria-label="Ver detalles de ${esc(s.name)}"><td><div class="server-cell"><span class="status-dot"></span><div><span class="server-name">${esc(s.name)}</span><span class="server-address">${esc(s.address)}</span></div></div></td><td><span class="map-name">${esc(s.map)}</span></td><td><span class="players">${s.players}<span> / ${s.max_players}</span></span></td></tr>`;
  }).join("");
  $("emptyState").hidden=rows.length!==0;
  $("resultCount").textContent=`${rows.length} servidor${rows.length===1?"":"es"}`;
}
function formatDuration(seconds){
  const mins=Math.floor((Number(seconds)||0)/60), hours=Math.floor(mins/60);
  return hours?`${hours} h ${mins%60} min`:`${mins} min`;
}
function closeServerModal(){const modal=$("serverModal");modal.hidden=true;document.body.classList.remove("modal-open");}
async function showServerDetails(address){
  const modal=$("serverModal"), content=$("serverModalContent");
  modal.hidden=false;document.body.classList.add("modal-open");
  content.innerHTML='<div class="server-detail-loading">Consultando jugadores conectados…</div>';
  try{
    const res=await fetch(`/api/server-players?address=${encodeURIComponent(address)}`,{cache:"no-store"});
    const data=await res.json(); if(!res.ok)throw new Error(data.detail||"No se pudieron consultar los detalles.");
    const server=data.server||{};
    const stats=`<div class="server-detail-stats"><div><span>JUGADORES</span><strong>${Number(server.players)||0} / ${Number(server.max_players)||0}</strong></div><div><span>MAPA</span><strong>${esc(server.map||"Desconocido")}</strong></div><div><span>RESPUESTA</span><strong>${server.response_ms==null?"—":`${esc(server.response_ms)} ms`}</strong></div></div>`;
    const roster=data.players_available
      ? (data.players.length?`<div class="player-roster">${data.players.map((player,index)=>`<div class="player-roster-row"><span class="player-rank">${index+1}</span><strong>${esc(player.name)}</strong><span class="player-score">${player.exp_available===true && player.exp!=null?`${esc(player.exp)} EXP`:"EXP N/D"}</span><span class="player-duration">${formatDuration(player.duration_seconds)}</span></div>`).join("")}</div>`:'<p class="server-detail-empty">El servidor responde, pero ahora mismo no devuelve nombres de jugadores.</p>')
      : `<p class="server-detail-empty">${esc(data.message||"No se ha podido obtener la lista de jugadores.")}</p>`;
    content.innerHTML=`<div class="server-detail-heading"><div><span class="server-detail-kicker">DETALLES DEL SERVIDOR</span><h3>${esc(server.name||"Servidor")}</h3><p>${esc(server.address||address)} · ${esc(server.game||"Lead and Gold")}</p></div><span class="server-detail-online">● ONLINE</span></div>${stats}<h4>JUGADORES CONECTADOS ${data.players_available?`(${data.players.length})`:""}</h4>${roster}<section class="server-exp-diagnostic"><h4>COMPROBACIÓN DE EXP EN DIRECTO</h4><p id="expDiagnosticStatus" class="server-detail-note">Consultando variables públicas A2S_RULES…</p></section><p class="server-detail-note">La EXP solo se mostrará cuando exista un dato real publicado por el servidor; no se calculará ni inventará.</p>`;
    fetch(`/api/server-exp-diagnostic?address=${encodeURIComponent(address)}`,{cache:"no-store"})
      .then(r=>r.json().then(body=>({ok:r.ok,body})))
      .then(({ok,body})=>{
        const status=$("expDiagnosticStatus"); if(!status || modal.hidden)return;
        if(!ok)throw new Error(body.detail||"No se pudo consultar A2S_RULES.");
        if(body.exp_found){
          status.innerHTML=`${esc(body.message)}<ul>${body.exp_candidates.map(item=>`<li><strong>${esc(item.key)}:</strong> ${esc(item.value)}</li>`).join("")}</ul>`;
        }else{
          status.textContent=`${body.message} (${Number(body.rules_count)||0} variables recibidas).`;
        }
      })
      .catch(error=>{const status=$("expDiagnosticStatus");if(status)status.textContent=error.message||"No se pudo completar la comprobación.";});
  }catch(error){content.innerHTML=`<p class="server-detail-empty">${esc(error.message||"No se pudieron cargar los detalles.")}</p>`;}
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
    render();
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
    const res=await fetch(`/api/meetups/${id}?creator_id=${encodeURIComponent(voterId)}&identity_code=${encodeURIComponent(identityCode)}`,{method:"DELETE"});
    const data=await res.json().catch(()=>({})); if(!res.ok)throw new Error(data.detail||"No se pudo eliminar la quedada.");
    if(String(editingMeetupId)===String(id))cancelMeetupEdit();
    await loadMeetups();
  }catch(err){alert(err.message);}
}
async function sendVote(button){
  const name=currentPlayerName();
  if(!name||!voterId||!identityCode){$("playerName").focus();alert("Primero reserva tu nick o recupera tu identidad con tu código privado.");return;}
  button.disabled=true;
  try{
    const res=await fetch(`/api/meetups/${button.dataset.id}/vote`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({identity_code:identityCode,voter_id:voterId,voter_name:name,avatar:currentAvatar(),vote:Number(button.dataset.vote)})});
    if(!res.ok)throw new Error("No se pudo guardar el voto");
    await loadMeetups();
  }catch(e){alert(e.message);}finally{button.disabled=false;}
}
$("playerName").value=currentPlayerName();
setAvatar(currentAvatar());
document.querySelectorAll(".avatar-option").forEach(b=>b.addEventListener("click",()=>setAvatar(b.dataset.avatar)));
if(currentPlayerName() && voterId && identityCode){$("profileStatus").textContent="✓ Nick protegido y reservado globalmente";$("playerName").disabled=true;}
else if(currentPlayerName())$("profileStatus").textContent="Este apodo aún no está reservado. Regístralo para protegerlo.";
$("playerName").addEventListener("change",savePlayerName);
$("registerNick").addEventListener("click",registerNick);
$("recoverNick").addEventListener("click",recoverNick);
$("playerName").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();savePlayerName();}});
$("meetupForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const title=$("meetupTitle").value.trim(); if(title.length<2)return;
  const button=$("meetupSubmit");button.disabled=true;button.textContent=editingMeetupId?"Guardando…":"Publicando…";
  if(!voterId||!identityCode){alert("Primero reserva tu nick o recupera tu identidad con tu código privado.");button.disabled=false;button.textContent="＋ Publicar quedada";return;}
  const payload={title,details:$("meetupDetails").value,event_at:$("meetupDate").value,creator_id:voterId,identity_code:identityCode};
  try{
    const url=editingMeetupId?`/api/meetups/${editingMeetupId}`:"/api/meetups";
    const res=await fetch(url,{method:editingMeetupId?"PUT":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    const data=await res.json().catch(()=>({})); if(!res.ok)throw new Error(data.detail||"No se pudo guardar la quedada");
    cancelMeetupEdit();await loadMeetups();
  }catch(err){alert(err.message);}finally{button.disabled=false;button.textContent=editingMeetupId?"Guardar cambios":"＋ Publicar quedada";}
});
$("cancelMeetupEdit").addEventListener("click",cancelMeetupEdit);
["search","occupancy","sort"].forEach(id=>$(id).addEventListener(id==="search"?"input":"change",render));
$("serverRows").addEventListener("click",event=>{const row=event.target.closest(".server-row");if(row)showServerDetails(row.dataset.address);});
$("serverRows").addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){const row=event.target.closest(".server-row");if(row){event.preventDefault();showServerDetails(row.dataset.address);}}});
$("serverModalClose").addEventListener("click",closeServerModal);
$("serverModal").addEventListener("click",event=>{if(event.target===$("serverModal"))closeServerModal();});
document.addEventListener("keydown",event=>{if(event.key==="Escape"&&!$("serverModal").hidden)closeServerModal();});
$("refreshBtn").addEventListener("click",()=>load(true));
$("notifyBtn").addEventListener("click",enablePush);
async function updatePushButtonState(){
  if(!("serviceWorker" in navigator) || !("Notification" in window) || Notification.permission!=="granted")return;
  try{
    const registration=await navigator.serviceWorker.register("/sw.js");
    const subscription=await registration.pushManager.getSubscription();
    if(subscription)$("notifyBtn").textContent="✓ AVISOS ACTIVOS";
  }catch(_){}
}
if("serviceWorker" in navigator)navigator.serviceWorker.register("/sw.js").then(updatePushButtonState).catch(()=>{});
load();loadMeetups();
refreshTimer=setInterval(()=>{load(false);loadMeetups();},45000);
