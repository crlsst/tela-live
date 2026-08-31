const $=id=>document.getElementById(id);
let token=localStorage.token,user=JSON.parse(localStorage.user||"null"),ws,room=null,role="viewer",screenStream=null,micStream=null,micMuted=false,deafened=false;
const voicePeers=new Map(),screenPeers=new Map(),iceQueue=new Map();

async function api(p,b){const r=await fetch(p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)}),d=await r.json();if(!r.ok)throw Error(d.error);return d}
function boot(){if(!token||!user)return;$('auth').classList.add('hidden');$('app').classList.remove('hidden');$('profileName').textContent=user.username;connect()}
$('login').onclick=()=>auth('/api/login');$('register').onclick=()=>auth('/api/register');
async function auth(p){try{const d=await api(p,{username:$('user').value,password:$('pass').value});token=d.token;user=d.user;localStorage.token=token;localStorage.user=JSON.stringify(user);boot()}catch(e){$('authMsg').textContent=e.message}}
function connect(){const p=location.protocol==='https:'?'wss':'ws';ws=new WebSocket(`${p}://${location.host}`);ws.onopen=()=>{send({type:'auth',token});send({type:'list-rooms'})};ws.onmessage=e=>handle(JSON.parse(e.data))}
function send(x){if(ws?.readyState===1)ws.send(JSON.stringify(x))}
function esc(s){return String(s||'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\\':'&#92;'}[c]))}
function renderRooms(rs){$('roomList').innerHTML=rs.map(r=>`<button class="roomItem" data-id="${r.id}">${r.private?'🔒':'#'} ${esc(r.name)}</button>`).join('');document.querySelectorAll('.roomItem').forEach(b=>b.onclick=()=>join(b.dataset.id))}
$('newRoom').onclick=()=>$('modal').classList.remove('hidden');$('closeModal').onclick=()=>$('modal').classList.add('hidden');$('private').onchange=e=>$('roomPassword').classList.toggle('hidden',!e.target.checked);
$('createRoom').onclick=()=>{
  const name=$('newRoomName').value.trim();
  const priv=$('private').checked;
  const password=$('roomPassword').value.trim();
  if(!name)return alert('Dê um nome para a sala.');
  if(priv&&password.length<3)return alert('O código da sala privada precisa ter pelo menos 3 caracteres.');
  send({type:'create-room',name,private:priv,password});
};
function join(id){
  const listed=[...document.querySelectorAll('.roomItem')].find(b=>b.dataset.id===id);
  const isPrivate=listed?.textContent.trim().startsWith('🔒');
  const pw=isPrivate?prompt('Digite o código da sala:'):'';
  if(pw===null)return;
  role='viewer';
  send({type:'join',roomId:id,password:pw,role:'viewer'});
}
$('broadcast').onclick=async()=>{if(!room)return alert('Entre em uma sala primeiro.');if(screenStream)return alert('Você já está transmitindo.');await startScreen();};
$('invite').onclick=async()=>{if(!room)return;await navigator.clipboard.writeText(location.origin+location.pathname+'?room='+room.id);alert('Convite copiado!')};
$('mic').onclick=()=>{if(!micStream)return;micMuted=!micMuted;micStream.getAudioTracks().forEach(t=>t.enabled=!micMuted);$('mic').textContent=micMuted?'🔇 Microfone':'🎤 Microfone'};
$('deafen').onclick=()=>{deafened=!deafened;document.querySelectorAll('audio.voice').forEach(a=>a.muted=deafened);$('deafen').textContent=deafened?'🔇 Surdo':'🎧 Surdo'};
$('stop').onclick=stopScreen;$('send').onclick=chat;$('message').onkeydown=e=>e.key==='Enter'&&chat();
function chat(){const t=$('message').value.trim();if(t&&room){send({type:'chat',text:t});$('message').value=''}}

async function getMic(){
  if(micStream)return micStream;
  try{
    micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}});
    return micStream;
  }catch{return null}
}
function cfg(){return{iceServers:[{urls:'stun:stun.l.google.com:19302'}]}}

async function startScreen(){
  try{
    const [w,h,f,bitrate]=String($('quality').value).split(':').map(Number);
    // Deliberately capture VIDEO ONLY. This prevents captured call audio from being
    // fed back into the call and is the safest simple anti-echo setup.
    screenStream=await navigator.mediaDevices.getDisplayMedia({video:{width:{ideal:w,max:w},height:{ideal:h,max:h},frameRate:{ideal:f,max:f},resizeMode:'crop-and-scale',cursor:'always'},audio:true});
    const local=$('video');local.srcObject=screenStream;local.muted=true;
    $('empty').classList.add('hidden');$('liveBadge').classList.remove('hidden');$('stop').classList.remove('hidden');
    screenStream.getVideoTracks()[0].onended=stopScreen;
    await getMic();
    send({type:'screen-ready'});
  }catch(e){
    screenStream=null;
    $('video').srcObject=null;
    alert(e && e.name==='NotAllowedError' ? 'O navegador bloqueou a captura. Permita o compartilhamento de tela e tente novamente.' : 'Não foi possível iniciar a transmissão. Verifique as permissões do navegador.');
  }
}

function createScreenElement(sourceId,label){
  let v=document.querySelector(`video.remoteStream[data-source="${sourceId}"]`);
  if(v)return v;
  v=document.createElement('video');v.className='remoteStream';v.dataset.source=sourceId;v.autoplay=true;v.playsInline=true;v.controls=true;v.muted=false;v.setAttribute('aria-label',label||'Transmissão');
  $('streamsGrid').appendChild(v);return v;
}
function removeScreen(sourceId){screenPeers.get(sourceId)?.close();screenPeers.delete(sourceId);document.querySelector(`video.remoteStream[data-source="${sourceId}"]`)?.remove();if(!$('streamsGrid').querySelector('.remoteStream'))$('empty').classList.remove('hidden')}

async function makeScreenPeer(targetId){
  if(!screenStream||screenPeers.has(targetId))return;
  const pc=new RTCPeerConnection(cfg());screenPeers.set(targetId,pc);
  screenStream.getTracks().forEach(t=>pc.addTrack(t,screenStream));
  for(const sender of pc.getSenders()){if(sender.track?.kind==='video'){const p=sender.getParameters();p.encodings=p.encodings?.length?p.encodings:[{}];p.encodings[0].maxBitrate=bitrate;p.encodings[0].maxFramerate=f;p.encodings[0].priority='high';try{await sender.setParameters(p)}catch{}}}
  pc.onicecandidate=e=>e.candidate&&send({type:'candidate',channel:'screen',target:targetId,candidate:e.candidate});
  pc.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(pc.connectionState)){pc.close();screenPeers.delete(targetId)}};
  const offer=await pc.createOffer();await pc.setLocalDescription(offer);send({type:'offer',channel:'screen',target:targetId,offer});
}
function stopScreen(){
  if(!screenStream)return;
  screenStream.getTracks().forEach(t=>t.stop());screenStream=null;
  screenPeers.forEach(p=>p.close());screenPeers.clear();
  $('video').srcObject=null;$('empty').classList.remove('hidden');$('liveBadge').classList.add('hidden');$('stop').classList.add('hidden');
  send({type:'stream-stopped'});
}

async function joinVoice(id,initiator=true){
  if(voicePeers.has(id)||!await getMic())return;
  const pc=new RTCPeerConnection(cfg());voicePeers.set(id,pc);
  micStream.getTracks().forEach(t=>pc.addTrack(t,micStream));
  pc.onicecandidate=e=>e.candidate&&send({type:'candidate',channel:'voice',target:id,candidate:e.candidate});
  pc.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(pc.connectionState)){pc.close();voicePeers.delete(id);document.querySelector(`audio[data-peer="${id}"]`)?.remove()}};
  pc.ontrack=e=>{let a=document.querySelector(`audio[data-peer="${id}"]`);if(!a){a=document.createElement('audio');a.className='voice';a.dataset.peer=id;a.autoplay=true;document.body.appendChild(a)}a.srcObject=e.streams[0];a.muted=deafened};
  if(initiator){const o=await pc.createOffer();await pc.setLocalDescription(o);send({type:'offer',channel:'voice',target:id,offer:o})}
}

async function handle(m){
  if(m.type==='error')return alert(m.message);
  if(m.type==='rooms')return renderRooms(m.rooms);
  if(m.type==='room-created'){
  $('modal').classList.add('hidden');
  room=null; role='viewer';
  send({type:'join',roomId:m.room.id,password:m.password||'',role:'viewer'});
  return;
}
  if(m.type==='joined'){
    room=m.room;
    $('title').textContent=room.name;$('subtitle').textContent=room.private?'🔒 Sala privada':'🌐 Sala pública';$('welcome').classList.add('hidden');$('roomView').classList.remove('hidden');updateMembers(m.members);
    await getMic();send({type:'voice-join'});
    return;
  }
  if(m.type==='members'){updateMembers(m.members);if(room){room.broadcasters=m.members.filter(x=>x.role==='broadcaster').map(x=>x.id)}return}
  if(m.type==='chat'){$('messages').insertAdjacentHTML('beforeend',`<div class="msg"><b>${esc(m.user)}</b>: ${esc(m.text)}</div>`);return}
  if(m.type==='peer-for-stream'&&screenStream)return makeScreenPeer(m.peerId);
  if(m.type==='stream-started'){return}
  if(m.type==='voice-peer')return joinVoice(m.peerId,m.initiator);
  if(m.type==='viewer-left'){voicePeers.get(m.viewerId)?.close();voicePeers.delete(m.viewerId);removeScreen(m.viewerId);return}
  if(m.type==='stream-stopped'){removeScreen(m.sourceId);return}

  if(m.type==='offer'&&m.channel==='screen'){
    let pc=screenPeers.get(m.from);
    if(!pc){pc=new RTCPeerConnection(cfg());screenPeers.set(m.from,pc);pc.ontrack=e=>{const v=createScreenElement(m.from,'Transmissão de '+m.from);v.srcObject=e.streams[0];v.muted=false;v.play().catch(()=>{});$('empty').classList.add('hidden')};pc.onicecandidate=e=>e.candidate&&send({type:'candidate',channel:'screen',target:m.from,candidate:e.candidate});pc.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(pc.connectionState))removeScreen(m.from)}}
    await pc.setRemoteDescription(m.offer);for(const c of iceQueue.get(m.from)||[])await pc.addIceCandidate(c);iceQueue.delete(m.from);const ans=await pc.createAnswer();await pc.setLocalDescription(ans);send({type:'answer',channel:'screen',target:m.from,answer:ans});return;
  }
  if(m.type==='offer'&&m.channel==='voice'){
    if(!await getMic())return;let pc=voicePeers.get(m.from);
    if(!pc){pc=new RTCPeerConnection(cfg());voicePeers.set(m.from,pc);micStream.getTracks().forEach(t=>pc.addTrack(t,micStream));pc.ontrack=e=>{let a=document.querySelector(`audio[data-peer="${m.from}"]`);if(!a){a=document.createElement('audio');a.className='voice';a.dataset.peer=m.from;a.autoplay=true;document.body.appendChild(a)}a.srcObject=e.streams[0];a.muted=deafened};pc.onicecandidate=e=>e.candidate&&send({type:'candidate',channel:'voice',target:m.from,candidate:e.candidate})}
    await pc.setRemoteDescription(m.offer);for(const c of iceQueue.get(m.from)||[])await pc.addIceCandidate(c);iceQueue.delete(m.from);const ans=await pc.createAnswer();await pc.setLocalDescription(ans);send({type:'answer',channel:'voice',target:m.from,answer:ans});return;
  }
  if(m.type==='answer'){const map=m.channel==='voice'?voicePeers:screenPeers,pc=map.get(m.from);if(pc){await pc.setRemoteDescription(m.answer);for(const c of iceQueue.get(m.from)||[])await pc.addIceCandidate(c);iceQueue.delete(m.from)}return}
  if(m.type==='candidate'){const map=m.channel==='voice'?voicePeers:screenPeers,pc=map.get(m.from);if(pc?.remoteDescription)await pc.addIceCandidate(m.candidate);else{if(!iceQueue.has(m.from))iceQueue.set(m.from,[]);iceQueue.get(m.from).push(m.candidate)}}
}
function updateMembers(ms){$('memberCount').textContent=ms.length;$('members').innerHTML=ms.map(x=>`<div class="member"><span class="dot">●</span>${esc(x.username)} ${x.role==='broadcaster'?'📺':''}</div>`).join('')}
$('logout').onclick=()=>{localStorage.clear();location.reload()};boot();const q=new URLSearchParams(location.search);if(q.get('room'))setTimeout(()=>join(q.get('room')),1200);
