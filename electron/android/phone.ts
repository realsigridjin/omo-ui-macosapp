/** Inline, dependency-free phone client. All server-provided text uses textContent. */
export function phoneHtml(nonce: string): string {
  return String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>OmO Android</title>
<style nonce="${nonce}">
:root{color-scheme:dark;font:16px system-ui,sans-serif;background:#10141b;color:#e8edf5}*{box-sizing:border-box}body{margin:0}main{max-width:900px;margin:auto;padding:16px;padding-bottom:env(safe-area-inset-bottom)}h1{font-size:23px;margin:4px 0}header{display:flex;align-items:center;justify-content:space-between;gap:12px}#status{font-size:13px;color:#9db6d5}section{margin-top:16px}label{font-size:13px;display:block;margin:8px 0;color:#b6c7dc}input,select,textarea,button{font:inherit;color:inherit;border:1px solid #39485d;border-radius:8px;background:#1b2533;padding:11px;max-width:100%}input,select,textarea{width:100%}button{cursor:pointer;min-height:44px}button:disabled{opacity:.5;cursor:default}.row{display:flex;gap:8px;align-items:center}.row>*{min-width:0}.row select{flex:1}.row button{flex-shrink:0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}#messages{min-height:25vh;max-height:55vh;overflow:auto;overflow-wrap:anywhere;padding:4px}.message{white-space:pre-wrap;background:#182131;border-radius:10px;padding:12px;margin:8px 0}.message.user{background:#213447}.message strong{display:block;font-size:12px;color:#a5bedb;margin-bottom:6px}.approval{border:1px solid #a38246;padding:12px;border-radius:10px;margin:12px 0}.approval pre{white-space:pre-wrap;overflow-wrap:anywhere}.approval .row{flex-wrap:wrap}textarea{resize:vertical;min-height:90px}#error{color:#ffb4b4;white-space:pre-wrap;overflow-wrap:anywhere}form .row{justify-content:flex-end;margin-top:8px}@media(max-width:520px){main{padding:12px}.grid{grid-template-columns:1fr}#messages{max-height:48vh}h1{font-size:21px}}
@media(prefers-color-scheme:light){:root{color-scheme:light;background:#f6f8fc;color:#182538}#status,label{color:#486381}input,select,textarea,button{background:#fff;border-color:#bcc9da}.message{background:#e8edf6}.message.user{background:#dceafb}.message strong{color:#3f5e82}.approval{border-color:#967529;background:#fffaf0}#error{color:#a51c30}}
</style></head><body><main><header><h1>OmO Android</h1><span id="status" role="status">Connecting</span></header>
<section class="grid"><div><label for="model">Model</label><select id="model"></select></div><div><label for="cwd">Working directory on desktop</label><input id="cwd" placeholder="P:/coding/project" autocomplete="off"></div></section>
<section><label for="threads">Conversation</label><div class="row"><select id="threads"><option value="">Choose a conversation</option></select><button id="refresh" type="button">Refresh</button><button id="new" type="button">New</button></div></section>
<p id="error" role="alert"></p><section id="approvals" aria-label="Approvals and questions"></section><section id="messages" aria-label="Messages" aria-live="polite"></section>
<form id="composer"><label for="text">Message</label><textarea id="text" required placeholder="Send a message to OmO"></textarea><div class="row"><button id="interrupt" type="button" disabled>Stop turn</button><button id="send" type="submit" disabled>Send</button></div></form></main>
<script nonce="${nonce}">
'use strict';
const $ = id => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
const token = fragment.get('token') || sessionStorage.getItem('omo.android.token');
if (token) sessionStorage.setItem('omo.android.token', token);
history.replaceState(null, '', location.pathname);
let threadId = null, turnId = null, connected = false, busy = false;
const items = new Map(), approvals = new Map();
const showError = error => { $('error').textContent = error instanceof Error ? error.message : String(error); };
function controls() { $('send').disabled = !connected || busy || !threadId; $('interrupt').disabled = !connected || !turnId; $('new').disabled = !connected || busy; }
async function post(path, payload) {
  const response = await fetch(path, {method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify(payload)});
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(body.error && (body.error.message || body.error) || 'Request failed');
  return body.result;
}
const rpc = (method, params) => post('/rpc', {method, params});
const handle = action => async event => { if (event) event.preventDefault(); $('error').textContent = ''; try { await action(); } catch(error) {showError(error);} };
function option(select, value, label) { const node = document.createElement('option'); node.value = value; node.textContent = label; select.append(node); }
async function listThreads() {
  const result = await rpc('thread/list', {limit:50});
  $('threads').replaceChildren(); option($('threads'), '', 'Choose a conversation');
  for (const thread of result.data) option($('threads'), thread.id, thread.name || thread.preview || thread.id);
  $('threads').value = threadId || '';
}
async function loadModels() {
  const result = await rpc('model/list', {includeHidden:false}); $('model').replaceChildren();
  option($('model'), '', 'Server default');
  for (const model of result.data) option($('model'), model.id, model.displayName || model.model);
}
function itemText(item) {
  if (item.type === 'userMessage') return (item.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  if (item.type === 'reasoning') return (item.summary || []).join('\n');
  return item.text || item.command || item.aggregatedOutput || '';
}
function renderItem(item, turn) {
  const key = turn+'/'+item.id; let entry = items.get(key);
  if (!entry) {
    const node = document.createElement('article'), label = document.createElement('strong'), text = document.createElement('div');
    node.className = 'message'+(item.type === 'userMessage' ? ' user' : ''); label.textContent = item.type === 'userMessage' ? 'You' : item.type === 'agentMessage' ? 'OmO' : item.type;
    node.append(label,text); $('messages').append(node); entry = {node,text}; items.set(key,entry);
  }
  entry.text.textContent = itemText(item); $('messages').scrollTop = $('messages').scrollHeight;
  return entry;
}
function selectThread(thread) {
  threadId = thread.id; turnId = null; items.clear(); $('messages').replaceChildren(); $('cwd').value = thread.cwd || $('cwd').value;
  for (const turn of thread.turns || []) { for (const item of turn.items || []) renderItem(item,turn.id); if (turn.status === 'inProgress') turnId = turn.id; }
  controls();
}
function removeApproval(id) { const node = approvals.get(id); if(node) node.remove(); approvals.delete(id); }
function clearApprovals() { for (const id of approvals.keys()) removeApproval(id); }
function approval(request) {
  if (approvals.has(request.id)) return;
  const card = document.createElement('div'); card.className = 'approval';
  const title = document.createElement('strong'), description = document.createElement('pre'), actions = document.createElement('div'); actions.className='row';
  title.textContent = request.method; const params = request.params || {}; description.textContent = params.command || params.reason || params.grantRoot || 'OmO needs your answer.';
  card.append(title,description); $('approvals').append(card); approvals.set(request.id,card);
  const answer = result => handle(async () => { await post('/answer',{id:request.id,result}); removeApproval(request.id); });
  if (request.method === 'item/tool/requestUserInput') {
    const fields = [];
    for (const question of params.questions || []) {
      const label = document.createElement('label'); label.textContent = question.question;
      const input = document.createElement('input'); input.type = question.isSecret ? 'password' : 'text'; label.append(input); card.append(label);
      fields.push({question,input,selected:new Set()});
      const field = fields[fields.length-1];
      for (const choice of question.options || []) {
        const button = document.createElement('button'); button.type='button'; button.textContent=choice.label; button.title=choice.description || '';
        button.onclick = () => {
          if (!question.multiSelect) {field.selected.clear(); for(const sibling of label.querySelectorAll('button')) sibling.setAttribute('aria-pressed','false');}
          if (field.selected.has(choice.label)) field.selected.delete(choice.label); else field.selected.add(choice.label);
          button.setAttribute('aria-pressed',String(field.selected.has(choice.label)));
        }; label.append(button);
      }
    }
    const button = document.createElement('button'); button.textContent='Answer'; button.onclick=handle(async () => {
      const answers = Object.create(null);
      for (const field of fields) { const values = [...field.selected]; if(field.input.value) values.push(field.input.value); answers[field.question.id]={answers:values}; }
      await post('/answer',{id:request.id,result:{answers}}); removeApproval(request.id);
    }); actions.append(button);
  } else if (request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval') {
    for (const decision of params.availableDecisions || ['accept','decline','cancel']) {
      const button=document.createElement('button'); button.textContent=decision; button.onclick=answer({decision}); actions.append(button);
    }
  } else { const text=document.createElement('p'); text.textContent='Answer this request in the desktop app.'; actions.append(text); }
  card.append(actions);
}
function notification(notification) {
  const params = notification.params || {}, method = notification.method;
  if (method === 'serverRequest/resolved') {removeApproval(params.requestId); return;}
  if (params.threadId !== threadId) return;
  if (method === 'item/started' || method === 'item/completed') renderItem(params.item,params.turnId);
  if (method === 'item/agentMessage/delta') {
    const key=params.turnId+'/'+params.itemId; const entry = items.get(key) || renderItem({id:params.itemId,type:'agentMessage',text:''},params.turnId);
    entry.text.textContent += params.delta; $('messages').scrollTop=$('messages').scrollHeight;
  }
  if (method === 'turn/started') {turnId=params.turn.id; controls();}
  if (method === 'turn/completed') {turnId=null; controls(); if(params.turn.error) showError(params.turn.error.message);}
  if (method === 'error') showError(params.error.message);
}
$('refresh').onclick=handle(listThreads);
$('threads').onchange=handle(async () => {
  if (!$('threads').value) return;
  busy=true; controls();
  try { await rpc('thread/resume',{threadId:$('threads').value}); selectThread((await rpc('thread/read',{threadId:$('threads').value,includeTurns:true})).thread); }
  finally {busy=false; controls();}
});
$('new').onclick=handle(async () => {
  if(!$('cwd').value.trim()) throw new Error('Enter a working directory on the desktop.');
  busy=true; controls();
  try { const result=await rpc('thread/start',{cwd:$('cwd').value.trim(),model:$('model').value || null}); selectThread(result.thread); await listThreads(); }
  finally {busy=false; controls();}
});
$('composer').onsubmit=handle(async () => {
  const text=$('text').value.trim(); if(!text || !threadId) return;
  busy=true; controls();
  try { const result=await rpc('turn/start',{threadId,input:[{type:'text',text}],model:$('model').value || null}); $('text').value=''; if(result.turn.status==='inProgress') turnId=result.turn.id; }
  finally {busy=false; controls();}
});
$('interrupt').onclick=handle(async () => {if(threadId && turnId) await rpc('turn/interrupt',{threadId,turnId});});
if(!token) {showError('Connect this phone from Android settings in the desktop app.'); controls();}
else {
  const stream = new EventSource('/events?token='+encodeURIComponent(token));
  stream.onmessage=event => {
    const frame=JSON.parse(event.data);
    if(frame.type==='bridgeStatus') {
      const wasConnected=connected; connected=frame.state==='connected'; $('status').textContent=frame.state;
      if(!connected) {clearApprovals(); turnId=null;} controls();
      if(connected && !wasConnected) handle(async () => {await Promise.all([loadModels(),listThreads()]);})().catch(showError);
    }
    if(frame.type==='notification') notification(frame.notification);
    if(frame.type==='serverRequest') approval(frame);
  };
  stream.onerror=() => {connected=false; $('status').textContent='Disconnected'; controls();};
}
</script></body></html>`;
}
