import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { WebSocketServer } from "ws";

const SECRET=process.env.JWT_SECRET||"troque-esta-chave-em-producao";
const users=new Map(),rooms=new Map();
const __filename=fileURLToPath(import.meta.url),__dirname=path.dirname(__filename);
const app=express(),server=http.createServer(app),wss=new WebSocketServer({server});
app.use(express.json());app.use(express.static(path.join(__dirname,"public")));
const safe=u=>({id:u.id,username:u.username});
app.post("/api/register",async(req,res)=>{const{username,password}=req.body||{};if(!username||!password||username.length<3||password.length<4)return res.status(400).json({error:"Usuário mínimo 3 e senha mínima 4 caracteres."});if([...users.values()].some(u=>u.username.toLowerCase()===username.toLowerCase()))return res.status(409).json({error:"Esse usuário já existe."});const u={id:crypto.randomUUID(),username,password:await bcrypt.hash(password,10)};users.set(u.id,u);res.json({token:jwt.sign({id:u.id},SECRET,{expiresIn:"7d"}),user:safe(u)})});
app.post("/api/login",async(req,res)=>{const{username,password}=req.body||{},u=[...users.values()].find(x=>x.username.toLowerCase()===(username||"").toLowerCase());if(!u||!await bcrypt.compare(password||"",u.password))return res.status(401).json({error:"Usuário ou senha inválidos."});res.json({token:jwt.sign({id:u.id},SECRET,{expiresIn:"7d"}),user:safe(u)})});
function send(w,d){if(w.readyState===1)w.send(JSON.stringify(d))}
function broadcast(r,d,e=null){for(const c of r.clients)if(c!==e)send(c,d)}
function members(r){return[...r.clients].map(c=>({id:c.id,username:c.user.username,role:c.role}))}
function info(id,r){return{id,name:r.name,private:r.private,broadcasters:[...r.broadcasters].map(c=>c.id),viewerCount:[...r.clients].filter(c=>c.role==="viewer").length}}
function notifyBroadcastersOfPeer(r,peer){for(const b of r.broadcasters)if(b!==peer)send(b,{type:"peer-for-stream",peerId:peer.id})}
function notifyPeerOfBroadcasters(r,peer){for(const b of r.broadcasters)if(b!==peer)send(peer,{type:"stream-source",sourceId:b.id})}

wss.on("connection",ws=>{
  ws.id=crypto.randomUUID();ws.user=null;ws.roomId=null;ws.role="viewer";ws.streaming=false;
  ws.on("message",raw=>{let m;try{m=JSON.parse(raw)}catch{return}
    if(m.type==="auth"){try{const p=jwt.verify(m.token,SECRET),u=users.get(p.id);if(!u)throw 0;ws.user=safe(u);send(ws,{type:"authed"})}catch{send(ws,{type:"error",message:"Sessão inválida."})}return}
    if(!ws.user){send(ws,{type:"error",message:"Faça login primeiro."});return}
    if(m.type==="create-room"){const id=crypto.randomUUID().slice(0,8),r={name:(m.name||"Sala sem nome").slice(0,40),private:!!m.private,password:m.password||"",clients:new Set(),broadcasters:new Set()};rooms.set(id,r);send(ws,{type:"room-created",room:info(id,r)});return}
    if(m.type==="list-rooms"){send(ws,{type:"rooms",rooms:[...rooms].map(([id,r])=>info(id,r))});return}
    if(m.type==="join"){
      const r=rooms.get(m.roomId);if(!r)return send(ws,{type:"error",message:"Sala não encontrada."});
      if(r.private&&r.password!==m.password)return send(ws,{type:"error",message:"Código incorreto."});
      if(ws.roomId&&rooms.get(ws.roomId)){const old=rooms.get(ws.roomId);old.clients.delete(ws);old.broadcasters.delete(ws);if(ws.streaming)broadcast(old,{type:"stream-stopped",sourceId:ws.id},ws);if(old.clients.size)broadcast(old,{type:"members",members:members(old)});else rooms.delete(ws.roomId); }
      ws.roomId=m.roomId;ws.role=m.role==="broadcaster"?"broadcaster":"viewer";ws.streaming=false;r.clients.add(ws);
      if(ws.role==="broadcaster")r.broadcasters.add(ws);
      send(ws,{type:"joined",room:info(m.roomId,r),members:members(r)});broadcast(r,{type:"members",members:members(r)});
      if(ws.role==="viewer"){notifyBroadcastersOfPeer(r,ws);notifyPeerOfBroadcasters(r,ws)}
      else {for(const b of r.broadcasters)if(b!==ws&&b.streaming)send(ws,{type:"stream-source",sourceId:b.id});for(const c of r.clients)if(c!==ws&&c.role==="viewer")send(ws,{type:"peer-for-stream",peerId:c.id});for(const b of r.broadcasters)if(b!==ws&&b.streaming)send(b,{type:"peer-for-stream",peerId:ws.id})}
      return;
    }
    const r=rooms.get(ws.roomId);if(!r)return;
    if(m.type==="chat"){broadcast(r,{type:"chat",user:ws.user.username,text:String(m.text||"").slice(0,500)});return}
    if(["offer","answer","candidate"].includes(m.type)){const t=[...r.clients].find(c=>c.id===m.target);if(t)send(t,{...m,from:ws.id});return}
    if(m.type==="voice-join"){for(const c of r.clients)if(c!==ws){send(ws,{type:"voice-peer",peerId:c.id,initiator:true});send(c,{type:"voice-peer",peerId:ws.id,initiator:false})}return}
    if(m.type==="screen-ready"){
      ws.streaming=true;r.broadcasters.add(ws);
      for(const c of r.clients)if(c!==ws)send(ws,{type:"peer-for-stream",peerId:c.id});
      for(const b of r.broadcasters)if(b!==ws&&b.streaming)send(b,{type:"peer-for-stream",peerId:ws.id});
      broadcast(r,{type:"stream-started",sourceId:ws.id},ws);broadcast(r,{type:"members",members:members(r)});return;
    }
    if(m.type==="stream-stopped"){
      ws.streaming=false;r.broadcasters.delete(ws);
      broadcast(r,{type:"stream-stopped",sourceId:ws.id});
      broadcast(r,{type:"members",members:members(r)});return;
    }
  });
  ws.on("close",()=>{const r=rooms.get(ws.roomId);if(!r)return;r.clients.delete(ws);r.broadcasters.delete(ws);if(ws.streaming)broadcast(r,{type:"stream-stopped",sourceId:ws.id});broadcast(r,{type:"members",members:members(r)});if(!r.clients.size)rooms.delete(ws.roomId)})
});
server.listen(process.env.PORT||10000,"0.0.0.0",()=>console.log("Tela Live online"));
