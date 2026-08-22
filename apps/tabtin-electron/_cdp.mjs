import http from 'http';
import WebSocket from 'ws';
import fs from 'fs';

const ACTION = process.argv[2] || 'shot';
const ARG = process.argv[3] || '';

function getJSON(u){return new Promise((res,rej)=>{http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)))}).on('error',rej)})}
const targets = await getJSON('http://127.0.0.1:9222/json');
const main = targets.find(t=>t.type==='page' && t.url==='http://127.0.0.1:5175/');
const ws = new WebSocket(main.webSocketDebuggerUrl);
let id=0; const pending={};
function send(m,p={}){return new Promise(r=>{const i=++id;pending[i]=r;ws.send(JSON.stringify({id:i,method:m,params:p}))})}
ws.on('message',m=>{const o=JSON.parse(m);if(o.id&&pending[o.id]){pending[o.id](o.result);delete pending[o.id]}});
await new Promise(r=>ws.on('open',r));
await send('Runtime.enable');

async function evalJS(expr){const r=await send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});return r.result?r.result.value:r}

if(ACTION==='shot'){
  const {data}=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(ARG||'/tmp/tabtin-cdp.png',Buffer.from(data,'base64'));
  console.log('saved '+(ARG||'/tmp/tabtin-cdp.png'));
}else if(ACTION==='eval'){
  const out=await evalJS(ARG);
  console.log(typeof out==='string'?out:JSON.stringify(out));
}
ws.close();
