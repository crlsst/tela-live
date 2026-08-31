import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const SECRET=process.env.JWT_SECRET||"troque-esta-chave-em-producao";
const users=new Map(), rooms=new Map();
const __filename=fileURLToPath(import.meta.url), __dirname=path.dirname(__filename);
const app=express(), server=http.createServer(app), wss=new WebSocketServer({server});
app.use(express.json()); app.use(express.static(path.join(__dirname,"public")));

const safeUser=u=>({id:u.id,username:u.username});
app.post("/api/register",async(req,res)=>{
 const {username,password}=req.body||{};
 if(!username||!password||username.length<3||password.length<4)return res.status(400).json({error:"Usuário mínimo 3 e senha mínima 4 caracteres."});
 if([...users.values()].some(u=>u.username.toLowerCase()===username.toLowerCase()))return res.status(409).json({error:"Esse usuário já existe."});
 const u={id:crypto.randomUUID(),username,password:await bcrypt.hash(password,10)};users.set(u.id,u);
 res.json({token:jwt.sign({id:u.id},SECRET,{expiresIn:"7d"}),user:safeUser(u)});
});
app.post("/api/login",async(req,res)=>{
 const {username,password}=req.body||{},u=[...users.values()].find(x=>x.username.toLowerCase()===(username||"").toLowerCase());
 if(!u||!await bcrypt.compare(password||"",u.password))return res.status(401).json({error:"Usuário ou senha inválidos."});
 res.json({token:jwt.sign({id:u.id},SECRET,{expiresIn:"7d"}),user:safeUser(u)});
});
app.get("/api/me",(req,res)=>{
 try{const p=jwt.verify((req.headers.authorization||"").replace("Bearer ",""),SECRET),u=users.get(p.id);if(!u)throw 0;res.json(safeUser(u));}catch{res.status(401).json({error:"Não autorizado"});}
});

function send(ws,d){if(ws.readyState===1)ws.send(JSON.stringify(d))}
function members(room){return [...room.clients].filter(x=>x.user).map(x=>({id:x.id,username:x.user.username,role:x.role}))}
function broadcast(room,data,except=null){for(const c of room.clients)if(c!==except)send(c,data)}
function roomInfo(id,r){return {id,name:r.name,private:r.private,broadcaster:r.broadcaster?.id||null,viewerCount:Math.max(0,[...r.clients].filter(c=>c.role==="viewer").length)}}

wss.on("connection",ws=>{
 ws.id=crypto.randomUUID();ws.roomId=null;ws.user=null;ws.role="viewer";
 ws.on("message",async raw=>{
  let m;try{m=JSON.parse(raw)}catch{return}
  if(m.type==="auth"){try{const p=jwt.verify(m.token,SECRET),u=users.get(p.id);if(!u)throw 0;ws.user=safeUser(u);send(ws,{type:"authed",user:ws.user})}catch{send(ws,{type:"error",message:"Sessão inválida."})}return}
  if(!ws.user){send(ws,{type:"error",message:"Faça login primeiro."});return}
  if(m.type==="create-room"){
   const id=crypto.randomUUID().slice(0,8),r={name:(m.name||"Sala sem nome").slice(0,40),private:!!m.private,password:m.password||"",clients:new Set(),broadcaster:null};
   rooms.set(id,r);send(ws,{type:"room-created",room:roomInfo(id,r),password:r.private?r.password:""});return
  }
  if(m.type==="join"){
   const r=rooms.get(m.roomId);if(!r){send(ws,{type:"error",message:"Sala não encontrada."});return}
   if(r.private&&r.password!==m.password){send(ws,{type:"error",message:"Código da sala incorreto."});return}
   if(m.role==="broadcaster"&&r.broadcaster){send(ws,{type:"error",message:"Já existe um transmissor nesta sala."});return}
   ws.roomId=m.roomId;ws.role=m.role==="broadcaster"?"broadcaster":"viewer";r.clients.add(ws);if(ws.role==="broadcaster")r.broadcaster=ws;
   send(ws,{type:"joined",room:roomInfo(m.roomId,r),members:members(r)});
   broadcast(r,{type:"members",members:members(r)},null);
   if(ws.role==="viewer"&&r.broadcaster)send(r.broadcaster,{type:"viewer-joined",viewerId:ws.id});
   return
  }
  if(m.type==="list-rooms"){send(ws,{type:"rooms",rooms:[...rooms].map(([id,r])=>roomInfo(id,r))});return}
  const r=rooms.get(ws.roomId);if(!r)return;
  if(m.type==="chat"){broadcast(r,{type:"chat",id:crypto.randomUUID(),user:ws.user.username,text:String(m.text||"").slice(0,500),time:Date.now()});return}
  if(["offer","answer","candidate"].includes(m.type)){const target=[...r.clients].find(c=>c.id===m.target);if(target)send(target,{...m,from:ws.id});return}
  if(m.type==="stream-stopped")broadcast(r,{type:"stream-stopped"});
 });
 ws.on("close",()=>{
  const r=rooms.get(ws.roomId);if(!r)return;r.clients.delete(ws);
  if(r.broadcaster===ws){r.broadcaster=null;broadcast(r,{type:"stream-stopped"})}
  else if(r.broadcaster)send(r.broadcaster,{type:"viewer-left",viewerId:ws.id});
  broadcast(r,{type:"members",members:members(r)});
  if(!r.clients.size)rooms.delete(ws.roomId);
 });
});
const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Tela Live rodando na porta ${PORT}`);
});
