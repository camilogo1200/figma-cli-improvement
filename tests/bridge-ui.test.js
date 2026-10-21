import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../plugin/ui.html', import.meta.url), 'utf8');
function harness({ scheduled=false }={}) {
  const messages=[],sockets=[],timers=new Map(),frames=new Map();let serial=0,now=1000;
  const dom=new JSDOM(html,{url:'https://plugin.test'}),document=dom.window.document;
  Object.defineProperty(document,'hidden',{value:false,writable:true});
  const elements=new Map([...document.querySelectorAll('[id]')].map(node=>[node.id,node]));
  for(const node of [document,...elements.values()]) {
    const listen=node.addEventListener.bind(node);
    node.addEventListener=(name,fn)=>{node[name]=fn;listen(name,fn);};
  }
  elements.get('pair-code').value='test-pair';
  const parent={postMessage:msg=>messages.push(msg.pluginMessage)},window={addEventListener(name,fn){this[name]=fn;}};
  class Clock extends Date { static now(){return now;} }
  const flush=()=>{
    now+=100;
    for(const [id,timer] of [...timers])if(timer.ms<=100){timers.delete(id);timer.fn();}
    for(const [id,fn] of [...frames]){frames.delete(id);fn();}
  };
  class Socket {
    static OPEN=1;
    constructor(url){this.url=url;this.readyState=0;this.sent=[];sockets.push(this);}
    open(){this.readyState=1;this.onopen();if(!scheduled)flush();}
    send(text){this.sent.push(JSON.parse(text));}
    close(code=1006,reason=''){this.readyState=3;this.onclose?.({code,reason});if(!scheduled)flush();}
    receive(msg){this.onmessage({data:JSON.stringify(msg)});if(!scheduled)flush();}
  }
  const context=vm.createContext({parent,window,WebSocket:Socket,console,document,Date:Clock,
    ...(scheduled?{requestAnimationFrame:fn=>{const id=++serial;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id)}:{}),
    setTimeout(fn,ms){const id=++serial;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
  return {messages,sockets,timers,frames,window,elements,document,dom,flush,
    tick(ms){now+=ms;for(const [id,timer] of [...timers])if(timer.ms<=ms){timers.delete(id);timer.fn();}},
    tab(name){vm.runInContext('showPanel('+JSON.stringify(name)+')',context);if(!scheduled)flush();},
    main(msg,source=parent,origin=''){window.onmessage({source,origin,data:{pluginMessage:msg}});if(!scheduled)flush();},
    connect(){this.main({type:'identity',protocol:4,build:'test',version:'test',busy:false,page:'P'});const ws=sockets.at(-1);ws.open();ws.receive({type:'ready',workerId:'w1',sessionEpoch:'s1',coordinatorEpoch:'c1',credential:'scoped-secret'});return ws;},
  };
}

test('UI connects only to the canonical port and sends the actual sandbox identity', () => {
  const h = harness(); assert.equal(h.messages[0].type, 'identify');
  const ws = h.connect(); assert.equal(h.sockets.length, 1); assert.equal(ws.url, 'ws://127.0.0.1:3456/plugin');
  assert.equal(ws.sent[0].build, 'test'); assert.equal(ws.sent[0].protocol, 4);
  ws.receive({ action: 'cmd', id: 'a', cmd: { op: 'ping' } });
  assert.equal(h.messages.at(-1).session, 1);
  h.window.beforeunload(); assert.equal(h.timers.size, 0);
});

test('live lanes follow admitted batches and disappear on completion while reserved zones remain', () => {
  const h=harness(),ws=h.connect();
  const t={type:'telemetry',schema:1,sequence:1,coordinatorEpoch:'c1',sampledAt:Date.now(),held:0,
    workers:[{workerId:'w1',fileKey:'fileA',file:'Example',connected:true,current:{requestId:'r1',laneId:'batch-1',label:'Batch 1',phase:'running',executionMs:100}}],
    budgets:{jobs:2,maxJobs:32,bytes:100,maxBytes:33554432},
    taskLanes:[{laneId:'idle-saved-lane',fileKey:'fileA',label:'Unused saved lane',state:'waiting',jobs:0}],
    lanes:[{requestId:'r1',workerId:'w1',laneId:'batch-1',label:'Batch 1',state:'running',bytes:50},{requestId:'r2',workerId:'w1',laneId:'batch-2',label:'Batch <2>',state:'queued',bytes:50}],
    reservations:[{fileKey:'fileA',pageId:'p1',laneId:'completed-layout',state:'committed',rect:{x:0,y:0,width:100,height:100}}],recent:[]};
  ws.receive(t);
  assert.match(h.elements.get('overview-workers').innerHTML,/Batch 1/);
  assert.match(h.elements.get('overview-workers').innerHTML,/Batch &lt;2&gt;/);
  assert.doesNotMatch(h.elements.get('overview-workers').innerHTML,/Unused saved lane|completed-layout/);
  ws.receive({...t,sequence:2,workers:t.workers.map(w=>({...w,current:null})),lanes:[],budgets:{...t.budgets,jobs:0}});
  assert.match(h.elements.get('overview-workers').innerHTML,/Lanes appear automatically when work arrives/);
  assert.doesNotMatch(h.elements.get('overview-workers').innerHTML,/Batch 1/);
  assert.match(h.elements.get('overview-zones').innerHTML,/completed-layout/);
  h.window.beforeunload();
});

test('UI does not reconnect while the sandbox is busy and fences old results after reconnect', () => {
  const h = harness(), first = h.connect(); first.close();
  assert.equal(h.messages.at(-1).type, 'cancel');
  h.main({ type: 'identity', busy: true }); assert.equal(h.sockets.length, 1);
  const second = h.connect();
  h.main({ type: 'result', session: 1, id: 'old', result: 'late' });
  assert.equal(second.sent.some(m => m.id === 'old'), false);
  h.main({ type: 'result', session: 2, id: 'new', result: true }); assert.equal(second.sent.at(-1).id, 'new');
  first.onclose({ code: 1006 }); assert.equal(second.readyState, 1);
  h.window.beforeunload();
});
test('policy close requires explicit plugin restart and cannot enter a reconnect loop', () => {
  const h = harness(), ws = h.connect(); ws.close(1008, 'Build mismatch');
  h.main({ type: 'identity', busy: false }); assert.equal(h.sockets.length, 1);
  assert.equal(h.elements.get('status').textContent, 'Build mismatch'); assert.equal(h.timers.size, 0);
});
test('yield watchdog timers are cleared on acknowledgements and UI teardown', () => {
  const h = harness(); h.main({ type: 'yield', k: 1 }); assert.equal(h.messages.at(-1).type, 'yielded');
  assert.equal(h.timers.size, 1); h.main({ type: 'yield-finished', k: 1 }); assert.equal(h.timers.size, 0);
  h.main({ type: 'yield', k: 2 }); const timer = [...h.timers.values()][0]; timer.fn();
  assert.equal(h.messages.at(-1).type, 'yield-timeout');
  h.main({ type: 'yield', k: 3 }); h.window.beforeunload();
  // The fake timer which fired is removed by the runtime in a browser.
  assert.equal([...h.timers.values()].filter(t => t !== timer).length, 0);
});
test('messages from a different frame cannot issue plugin replies', () => {
  const h = harness(); h.main({ type: 'identity', busy: false }, {}); assert.equal(h.sockets.length, 0);
});

test('pairing is required before routing, telemetry is epoch fenced, and hidden subscriptions stop optional samples', () => {
  const h = harness(); h.document.getElementById('pair-code').value = '';
  h.main({ type: 'identity', busy: false }); assert.equal(h.sockets.length, 0);
  h.elements.get('pair-code').value = 'one-time-code'; const ws = h.connect();
  assert.equal(ws.sent[0].pairingCode, 'one-time-code'); assert.equal(h.elements.get('pair-code').value, '');
  const telemetry = { type: 'telemetry', schema: 1, sequence: 2, coordinatorEpoch: 'c1', sampledAt: Date.now(), held: 0,
    workers: [{ workerId: 'w1', file: '<unsafe file>', connected: true, current: null }],
    budgets: { jobs: 1, maxJobs: 32, bytes: 1024 }, lanes: [{ requestId: 'queued', workerId: 'w1', laneId: 'lane', pageId: 'p2', state: 'queued', blockedReason: 'waiting-worker-turn', bytes: 1024, waitMs: 250 }],
    resources: { memory: { rss: 1048576, heapUsed: 100, external: 10 }, eventLoopDelayMs: { p99: 22.5 } }, latency: { count: 0 }, reservations: [], recent: [] };
  ws.receive({ ...telemetry, coordinatorEpoch: 'old' }); assert.equal(h.elements.get('queue-count').textContent, '—');
  ws.receive(telemetry); assert.equal(h.elements.get('queue-count').textContent, '1/32');
  h.tab('resources'); assert.match(h.elements.get('daemon-resources').innerHTML, /22.5 ms/); assert.match(h.elements.get('overview-workers').innerHTML, /&lt;unsafe file&gt;/);
  h.tab('queue'); assert.match(h.elements.get('queue-list').innerHTML, /data-cancel-request="queued"/); h.tab('overview');
  ws.receive({ ...telemetry, sequence: 1, budgets: { jobs: 99 } }); assert.equal(h.elements.get('queue-count').textContent, '1/32');
  h.document.hidden = true; h.document.visibilitychange(); assert.equal(ws.sent.at(-1).visible, false);
  h.main({ type: 'yield', k: 7 }); assert.equal(h.messages.at(-1).type, 'yielded'); h.window.beforeunload();
});

test('graphical dispatch and activity preserve measured state, filtering and untrusted labels', () => {
  const h = harness(), ws = h.connect();
  const t = { type: 'telemetry', schema: 1, sequence: 1, coordinatorEpoch: 'c1', sampledAt: Date.now(), held: 0,
    workers: [{ workerId:'w1',fileKey:'fileA',file:'<unsafe file>',connected:true,current:{requestId:'r1',laneId:'A',pageId:'p1',phase:'running',executionMs:2500,progress:{done:10,total:20}} }],
    budgets: {jobs:2,maxJobs:32,bytes:200,maxBytes:33554432}, reservations: [], lanes:[{requestId:'r2',workerId:'w1',laneId:'B',pageId:'p2',state:'queued',blockedReason:'waiting-dependency',waitMs:500,bytes:100}],
    recent: [{id:'done',workerId:'w1',laneId:'<lane>',pageId:'p1',op:'create',outcome:'succeeded',queueMs:100,executionMs:2500,completedAt:Date.now(),performance:{spatialChecks:51,spatialMs:700,spatialNodes:3000,yieldCount:24}},
      {id:'failed',workerId:'w1',laneId:'B',op:'create',outcome:'rolled-back',kind:'zone-overflow',queueMs:300,executionMs:100}] };
  ws.receive(t);
  h.tab('queue'); const dispatch=h.elements.get('queue-list').innerHTML; h.tab('activity'); const activity=h.elements.get('activity-list').innerHTML;
  assert.match(dispatch,/waiting dependency/); assert.match(dispatch,/10 \/ 20 nodes/); assert.match(dispatch,/data-cancel-request="r2"/);
  assert.match(h.elements.get('dispatch-summary').innerHTML,/2 of 32 coordinator job slots/);
  assert.match(activity,/&lt;lane&gt;/); assert.match(activity,/&lt;unsafe file&gt;/); assert.doesNotMatch(activity,/<unsafe/);
  assert.match(activity,/51 checks/); assert.match(activity,/0.7 s/); assert.match(activity,/Queue 0.1 s, execution 2.5 s/);
  h.elements.get('filter').value='issues'; h.elements.get('filter').change({ target:h.elements.get('filter') });
  assert.doesNotMatch(h.elements.get('activity-list').innerHTML,/succeeded/); assert.match(h.elements.get('activity-list').innerHTML,/rolled-back/);
  // The distribution describes the full retained window, regardless of filter.
  assert.match(h.elements.get('activity-summary').innerHTML,/1 succeeded, 1 stopped or failed/);
  h.window.beforeunload();
});

test('Desktop Developer VM accepts the exact Figma host relay and rejects other origins', () => {
  const h = harness();
  const identity = { type: 'identity', protocol: 4, build: 'desktop', busy: false, page: 'P' };
  for (const origin of ['null', 'https://figma.com', 'https://www.figma.com.example.org', 'http://www.figma.com']) {
    h.main(identity, {}, origin);
    assert.equal(h.sockets.length, 0);
  }
  h.main(identity, {}, 'https://www.figma.com');
  assert.equal(h.sockets.length, 1);
  const ws = h.sockets[0]; ws.open();
  assert.equal(ws.sent[0].build, 'desktop');
  h.main({ type: 'result', session: 1, id: 'live', result: true }, {}, 'https://www.figma.com');
  assert.equal(ws.sent.at(-1).id, 'live');
  h.window.beforeunload();
});

const snapshot = (id = 'job-1') => ({ type: 'status', file: 'Example', page: 'Visible page',
  queued: 1, queuedBytes: 1024, limits: { queueJobs: 8, queueBytes: 16777216 },
  current: { id, op: 'create', ms: 2000, done: 100, total: 300, ownedNodes: 100,
    target: { page: 'Other page', pageId: 'p2' } },
  queue: [{ id: 'next', op: 'create', nodes: 10, bytes: 1024, waitMs: 500, parentId: 'p3' }] });

test('console reports resolved target separately from visible page and cancels only the active request', () => {
  const h = harness(); h.connect(); h.tab('workers'); h.main(snapshot());
  assert.match(h.elements.get('job').innerHTML, /Other page/);
  assert.match(h.elements.get('worker').innerHTML, /Visible page/);
  h.tab('overview'); assert.equal(h.elements.get('queue-count').textContent, '2/8'); h.tab('workers');
  h.elements.get('cancel').click();
  assert.equal(h.messages.at(-1).id, 'job-1');
  assert.equal(h.messages.at(-1).type, 'cancel');
  assert.equal(h.elements.get('cancel').disabled, true);
  assert.match(h.elements.get('cancel-note').textContent, /final outcome/);
  h.main({ type: 'result', session: 1, id: 'job-1', error: 'Stopped', outcome: 'rolled-back' });
  h.main({ type: 'busy', session: 1, id: 'job-1', busy: false });
  assert.match(h.elements.get('recent').innerHTML, /rolled-back/);
  assert.equal(h.elements.get('cancel').disabled, true);
  h.window.beforeunload();
});

test('console escapes untrusted text and caps reply history without retaining result content in the DOM', () => {
  const h = harness(); h.connect();
  h.tab('workers'); const s = snapshot(); s.current.target.page = '<img src=x onerror=alert(1)>'; h.main(s);
  assert.match(h.elements.get('job').innerHTML, /&lt;img/);
  assert.doesNotMatch(h.elements.get('job').innerHTML, /<img/);
  for (let i = 0; i < 25; i++) h.main({ type: 'result', session: 1, id: 'r' + i, result: { base64: 'SECRET_IMAGE_PAYLOAD' } });
  h.tab('activity'); const output = h.elements.get('activity-list').innerHTML;
  assert.equal((output.match(/class="event"/g) || []).length, 20);
  assert.doesNotMatch(output, /SECRET_IMAGE_PAYLOAD/);
  h.window.beforeunload();
});

test('hidden console keeps cancellation/yield transport responsive and repaints on visibility', () => {
  const h = harness(), ws = h.connect(); h.tab('workers'); h.document.hidden = true;
  h.main(snapshot()); h.main({ type: 'yield', k: 8 });
  assert.equal(h.messages.at(-1).type, 'yielded');
  assert.equal(ws.sent.at(-1).type, 'status');
  h.document.hidden = false; h.document.visibilitychange();
  assert.match(h.elements.get('job').innerHTML, /Other page/);
  h.main({ type: 'yield-finished', k: 8 }); h.window.beforeunload();
});

test('mode changes persist through the sandbox and batch uncertainty is not presented as success', () => {
  const h = harness(); h.connect();
  h.elements.get('mode').change({ target: { value: 'console' } });
  assert.equal(h.messages.at(-1).mode, 'console');
  assert.equal(h.document.body.dataset.mode, 'console');
  h.main({ type: 'batch-result', session: 1, id: 'batch', outcome: 'partial', results: [{ success: false, outcome: 'uncertain' }] });
  assert.equal(h.elements.get('alert').hidden, false);
  h.tab('activity'); assert.match(h.elements.get('activity-list').innerHTML, /uncertain/);
  h.window.beforeunload();
});

test('themes synchronize across views without changing subscription, outcomes, or execution controls', () => {
  const h = harness(), ws = h.connect();
  h.main({ type: 'ui-theme', theme: 'ios' });
  assert.equal(h.document.body.dataset.theme, 'ios');
  assert.equal(h.elements.get('ui-theme').value, 'ios');
  assert.equal(h.elements.get('compact-theme').value, 'ios');
  h.main({ type: 'batch-result', session: 1, id: 'uncertain', outcome: 'partial', results: [{ success: false, outcome: 'uncertain' }] });
  const alert = h.elements.get('alert').innerHTML, history = h.elements.get('activity-list').innerHTML;
  h.elements.get('mode').change({ target: { value: 'compact' } });
  const sent = ws.sent.length;
  h.elements.get('compact-theme').change({ target: { value: 'signal' } });
  assert.equal(ws.sent.length, sent); assert.equal(h.document.body.dataset.mode, 'compact');
  assert.equal(h.document.body.dataset.theme, 'signal');
  assert.equal(h.elements.get('ui-theme').value, 'signal');
  assert.equal(h.messages.at(-1).type, 'ui-theme'); assert.equal(h.messages.at(-1).theme, 'signal');
  assert.equal(h.elements.get('alert').innerHTML, alert); assert.equal(h.elements.get('activity-list').innerHTML, history);
  h.main({ type: 'ui-theme', theme: 'constructor' });
  assert.equal(h.document.body.dataset.theme, 'signal');
  h.main({ type: 'yield', k: 42 }); assert.equal(h.messages.at(-1).type, 'yielded');
  h.elements.get('details').click();
  assert.equal(h.document.body.dataset.mode, 'console');
  assert.equal(h.document.body.dataset.theme, 'signal'); assert.equal(h.elements.get('alert').hidden, false);
  h.window.beforeunload();
});

test('compact uses the lightweight coordinator summary and distinguishes local progress from global work', () => {
  const h=harness(), ws=h.connect();
  h.elements.get('mode').change({target:{value:'compact'}});
  h.main(snapshot());
  const fullMarkup=h.elements.get('overview-workers').innerHTML;
  ws.receive({type:'telemetry',schema:1,sequence:1,coordinatorEpoch:'c1',sampledAt:Date.now(),held:1,
    workers:[{workerId:'w2',file:'Other file',connected:true,current:{requestId:'other-job',label:'Do not show as local'}},
      {workerId:'w1',file:'Example',connected:true,current:{requestId:'job-1',label:'<Local job>',pageId:'p2'}}],
    budgets:{jobs:5,maxJobs:32,bytes:1048576,maxBytes:33554432}});
  const focus=h.elements.get('compact-focus').innerHTML, metrics=h.elements.get('compact-metrics').innerHTML;
  assert.match(focus,/&lt;Local job&gt;/); assert.doesNotMatch(focus,/Do not show as local/);
  assert.match(focus,/Other page/); assert.match(focus,/100 \/ 300 nodes/);
  assert.match(metrics,/<strong>2<\/strong>[\s\S]*Running files/);
  assert.match(metrics,/<strong>3<\/strong>[\s\S]*Waiting jobs/);
  assert.match(metrics,/<strong>1<\/strong>[\s\S]*Held · review/);
  assert.match(h.elements.get('compact-network').innerHTML,/1.00 MiB admitted/);
  assert.equal(h.elements.get('overview-workers').innerHTML,fullMarkup,'hidden full dashboard is not repainted');
  h.elements.get('details').click();
  assert.equal(h.document.body.dataset.mode,'console'); assert.equal(ws.sent.at(-1).mode,'console');
  assert.equal(h.messages.at(-1).mode,'console');
  h.window.beforeunload();
});

test('compact never invents a percentage for unmeasured work or displays stale work as running after disconnect', () => {
  const h=harness(), ws=h.connect(); h.elements.get('mode').change({target:{value:'compact'}});
  const s=snapshot(); s.current.total=0; s.current.op='exportImage'; s.current.target=null; h.main(s);
  assert.match(h.elements.get('compact-focus').innerHTML,/Progress unmeasured/);
  assert.match(h.elements.get('compact-focus').innerHTML,/Target not reported/);
  assert.doesNotMatch(h.elements.get('compact-focus').innerHTML,/%|ring-progress/);
  ws.close();
  assert.match(h.elements.get('compact-focus').innerHTML,/Outcome uncertain/);
  assert.doesNotMatch(h.elements.get('compact-focus').innerHTML,/ring-unmeasured|ring-progress|sampled/);
  assert.match(h.elements.get('compact-metrics').innerHTML,/<strong>—<\/strong>/);
  h.elements.get('details').click(); assert.equal(h.document.body.dataset.mode,'standard');
  assert.equal(h.elements.get('section-title').textContent,'Activity');
  h.window.beforeunload();
});


test('saved pairing automatically connects, survives a daemon restart and never opens approval', () => {
  const h = harness(); h.document.getElementById('pair-code').value = '';
  h.main({ type: 'identity', file: 'My file', busy: false, deviceCredential: 'a'.repeat(64) });
  const first = h.sockets[0]; first.open();
  assert.equal(first.sent[0].type, 'hello'); assert.equal(first.sent[0].deviceCredential, 'a'.repeat(64));
  first.receive({ type: 'ready', credential: 'session', workerId: 'w', sessionEpoch: 's', coordinatorEpoch: 'c' });
  assert.equal(h.elements.get('status').textContent, 'Ready · My file');
  first.close(); h.main({ type: 'identity', busy: false }); const second = h.sockets.at(-1); second.open();
  assert.equal(second.sent[0].deviceCredential, 'a'.repeat(64)); assert.equal(second.sent[0].type, 'hello');
  h.window.beforeunload();
});

test('first-use UI approval is explicit, stores its credential and stops after denial or revocation', () => {
  const h = harness(); h.document.getElementById('pair-code').value = '';
  h.main({ type: 'identity', busy: false }); assert.equal(h.sockets.length, 0);
  h.elements.get('connect-computer').click(); h.main({ type: 'identity', busy: false });
  const ws = h.sockets[0]; ws.open(); assert.equal(ws.sent[0].type, 'pair-request');
  ws.receive({ type: 'pair-pending', challenge: '123456' });
  assert.equal(h.elements.get('connection-challenge').textContent, '123456');
  assert.equal(h.elements.get('connect-computer').disabled, true);
  ws.close(4403, 'Declined'); assert.equal(h.timers.size, 0);
  assert.equal(h.elements.get('connect-computer').disabled, false);
  h.elements.get('connect-computer').click(); h.main({ type: 'identity', busy: false });
  const again = h.sockets.at(-1); again.open();
  again.receive({ type: 'ready', deviceCredential: 'b'.repeat(64), credential: 's', workerId: 'w', coordinatorEpoch: 'c' });
  assert.ok(h.messages.some(m => m.type === 'remember-computer' && m.deviceCredential === 'b'.repeat(64)));
  h.elements.get('forget').click(); assert.equal(again.sent.at(-1).type, 'forget-computer');
  again.receive({ type: 'forgotten' }); again.close(4401, 'Forgotten');
  assert.ok(h.messages.some(m => m.type === 'forget-computer')); assert.equal(h.timers.size, 0);
  h.window.beforeunload();
});

test('pairing storage errors are visible without dropping the authenticated connection', () => {
  const h = harness(); h.connect(); h.main({ type: 'pairing-saved', saved: false });
  assert.match(h.elements.get('pairing-storage-note').textContent, /could not save/);
  assert.equal(h.sockets[0].readyState, 1); h.window.beforeunload();
});

function measuredSnapshot(sequence=1) {
  return {type:'telemetry',schema:1,sequence,coordinatorEpoch:'c1',sampledAt:10000,held:0,
    workers:[{workerId:'w1',fileKey:'fileA',file:'Example',connected:true,current:{requestId:'r1',laneId:'batch-1',label:'Batch 1',phase:'running',executionMs:1000,progress:{done:10,total:100}}},
      {workerId:'w2',fileKey:'fileB',file:'Other',connected:true,current:null}],
    budgets:{jobs:2,maxJobs:32,bytes:100,maxBytes:33554432},
    lanes:[{requestId:'r1',workerId:'w1',laneId:'batch-1',label:'Batch 1',state:'running',bytes:50},{requestId:'r2',workerId:'w1',laneId:'batch-2',label:'Batch 2',state:'queued',bytes:50}],
    reservations:[{requestId:'r1',fileKey:'fileA',pageId:'p1',laneId:'batch-1',state:'running',rect:{x:0,y:0,width:100,height:100}}],recent:[]};
}
function mutations(h, target=h.document.body) {
  const observer=new h.dom.window.MutationObserver(()=>{});
  observer.observe(target,{subtree:true,childList:true,attributes:true,characterData:true});
  return observer;
}

test('identical telemetry performs zero DOM mutations; changing one worker preserves unrelated DOM and focused controls',()=>{
  const h=harness(),ws=h.connect(),t=measuredSnapshot();ws.receive(t);
  const doc=h.document,card=doc.querySelector('#overview-workers [data-key="w1"]'),other=doc.querySelector('#overview-workers [data-key="w2"]');
  const button=card.querySelector('button'),zone=doc.querySelector('#overview-zones svg');button.focus();
  const all=mutations(h);ws.receive({...t,sequence:2});
  assert.equal(all.takeRecords().length,0,'a sequence number alone never changes the DOM');
  ws.receive({...t,sequence:3,workers:t.workers.map((w,i)=>i?w:{...w,current:{...w.current,progress:{done:25,total:100}}})});
  const records=all.takeRecords();assert.ok(records.length>0);
  // The worker's own zone on the canvas map shows the same measured progress.
  const zoneParts=[...doc.querySelectorAll('#overview-zones [data-key="r1"]')];assert.equal(zoneParts.length,2,'zone shape and legend row');
  assert.ok(records.every(r=>card.contains(r.target)||zoneParts.some(z=>z.contains(r.target))),'only the changed worker and its zone receive DOM mutations');
  assert.ok(records.some(r=>zoneParts.some(z=>z.contains(r.target))),'the zone progress bar moved');
  assert.equal(doc.querySelector('#overview-workers [data-key="w1"]'),card);
  assert.equal(doc.querySelector('#overview-workers [data-key="w2"]'),other);
  assert.equal(doc.querySelector('#overview-zones svg'),zone);
  assert.equal(doc.activeElement,button);assert.match(card.textContent,/25 \/ 100 create nodes/);
  assert.equal(records.filter(r=>r.type==='childList').length,0,'progress updates text and attributes without replacing nodes');
  h.document.click({target:button});assert.equal(ws.sent.at(-1).type,'coordinator-cancel');assert.equal(ws.sent.at(-1).requestId,'r1');
  all.disconnect();h.window.beforeunload();
});

test('hidden panels are untouched and open with the latest state; keyed queue tickets survive insertion and removal',()=>{
  const h=harness(),ws=h.connect(),t=measuredSnapshot();ws.receive(t);
  assert.equal(h.elements.get('queue-list').childNodes.length,0);
  assert.equal(h.elements.get('visual-resources').childNodes.length,0);
  h.tab('queue');const ticket=h.document.querySelector('.queue-ticket'),button=ticket.querySelector('button');button.focus();
  const first={...t.lanes[1],requestId:'r3',laneId:'batch-3',label:'New first'};
  ws.receive({...t,sequence:2,lanes:[t.lanes[0],first,t.lanes[1]]});
  assert.equal(h.document.querySelectorAll('.queue-ticket')[1],ticket);assert.equal(h.document.activeElement,button);
  ws.receive({...t,sequence:3});assert.equal(h.document.querySelector('.queue-ticket'),ticket);
  const overview=mutations(h,h.elements.get('overview')),dispatch=mutations(h,h.elements.get('queue'));
  h.tab('activity');dispatch.takeRecords();
  ws.receive({...t,sequence:4,lanes:[t.lanes[0]],recent:[{id:'done',op:'create',outcome:'succeeded'}]});
  assert.equal(overview.takeRecords().length,0);assert.equal(dispatch.takeRecords().length,0);
  assert.match(h.elements.get('activity-list').textContent,/succeeded/);
  const entry=h.document.querySelector('.activity-entry');
  ws.receive({...t,sequence:5,lanes:[t.lanes[0]],recent:[{id:'new',op:'create',outcome:'failed'},{id:'done',op:'create',outcome:'succeeded'}]});
  assert.equal(h.document.querySelectorAll('.activity-entry')[1],entry);
  h.tab('queue');assert.equal(h.document.querySelectorAll('.queue-ticket').length,0);
  overview.disconnect();dispatch.disconnect();h.window.beforeunload();
});

test('progress bursts schedule one bounded visual commit without delaying transport; outcomes bypass the budget',()=>{
  const h=harness({scheduled:true}),ws=h.connect();h.tab('workers');h.main(snapshot());h.flush();
  const observer=mutations(h,h.elements.get('job'));
  for(let done=101;done<=200;done++)h.main({type:'progress',session:1,id:'job-1',done,total:300});
  assert.equal(ws.sent.filter(m=>m.type==='progress').length,100);
  assert.equal(h.frames.size,0);assert.equal([...h.timers.values()].filter(t=>t.ms<=100).length,1);
  assert.equal(observer.takeRecords().length,0);
  h.main({type:'yield',k:99});assert.equal(h.messages.at(-1).type,'yielded');
  h.flush();assert.match(h.elements.get('job').textContent,/200 \/ 300 create nodes/);
  assert.equal(h.frames.size,0);assert.equal([...h.timers.values()].filter(t=>t.ms<=100).length,0);
  h.main({type:'progress',session:1,id:'job-1',done:201,total:300});
  assert.equal([...h.timers.values()].filter(t=>t.ms<=100).length,1);
  h.main({type:'result',session:1,id:'job-1',outcome:'succeeded'});
  assert.equal([...h.timers.values()].filter(t=>t.ms<=100).length,0);assert.equal(h.frames.size,1);
  h.flush();assert.match(h.elements.get('recent').textContent,/succeeded/);
  h.main({type:'yield-finished',k:99});h.window.beforeunload();assert.equal(h.frames.size,0);assert.equal(h.timers.size,0);
  observer.disconnect();
});

test('hiding cancels pending presentation work and reopening paints the latest snapshot once',()=>{
  const h=harness({scheduled:true});h.connect();h.tab('workers');h.main(snapshot());h.flush();
  h.main({type:'progress',session:1,id:'job-1',done:120,total:300});
  h.document.hidden=true;h.document.visibilitychange();assert.equal(h.frames.size,0);assert.equal(h.timers.size,0);
  const observer=mutations(h);h.main({type:'progress',session:1,id:'job-1',done:250,total:300});h.flush();
  assert.equal(observer.takeRecords().length,0);
  h.document.hidden=false;h.document.visibilitychange();assert.equal(h.frames.size,1);h.flush();
  assert.match(h.elements.get('job').textContent,/250 \/ 300 create nodes/);assert.equal(h.frames.size,0);
  observer.disconnect();h.window.beforeunload();
});

test('compact progress keeps its gauge and card; reconnect refreshes selectors after missing telemetry',()=>{
  const h=harness(),ws=h.connect(),t=measuredSnapshot();h.main(snapshot());ws.receive(t);
  h.elements.get('mode').change({target:{value:'compact'}});
  const gauge=h.document.querySelector('.ring-progress'),focus=h.elements.get('compact-focus').firstChild;
  h.main({type:'progress',session:1,id:'job-1',done:150,total:300});
  assert.equal(h.document.querySelector('.ring-progress'),gauge);assert.equal(h.elements.get('compact-focus').firstChild,focus);
  assert.equal(gauge.style.getPropertyValue('--value'),'50');
  h.elements.get('mode').change({target:{value:'console'}});
  ws.close();assert.match(h.elements.get('overview-workers').textContent,/Pair a worker/);
  const next=h.connect();next.receive({...t,sequence:2});assert.match(h.elements.get('overview-workers').textContent,/Batch 1/);
  h.window.beforeunload();
});

test('chart caches distinguish the overview budget scale from resource auto scaling',()=>{
  const h=harness(),ws=h.connect(),t=measuredSnapshot();
  t.resources={memory:{rss:1000000,heapUsed:200000,external:0},eventLoopDelayMs:{p99:10}};
  ws.receive(t);ws.receive({...t,sequence:2,sampledAt:11000});
  const overview=h.document.querySelector('#spark-bytes .spark-line').getAttribute('d');
  h.tab('resources');const resource=h.document.querySelector('[data-key="bytes"] .spark-line').getAttribute('d');
  assert.notEqual(resource,overview,'equal samples can have distinct chart scales');
  h.tab('overview');assert.equal(h.document.querySelector('#spark-bytes .spark-line').getAttribute('d'),overview);
  h.window.beforeunload();
});

test('progress deltas update only the matching worker and cannot rewind newer local progress',()=>{
  const h=harness(),ws=h.connect(),t=measuredSnapshot();
  Object.assign(t.workers[0],{sessionEpoch:'s1'});t.workers[0].current.wireId='wire-1';
  ws.receive(t);const card=h.document.querySelector('#overview-workers [data-key="w1"]'),zone=h.document.querySelector('#overview-zones svg');
  const update={type:'worker-progress',schema:1,coordinatorEpoch:'c1',sequence:2,workerId:'w1',sessionEpoch:'s1',requestId:'r1',wireId:'wire-1',progress:{done:35,total:100}};
  ws.receive(update);assert.match(card.textContent,/35 \/ 100 create nodes/);assert.equal(h.document.querySelector('#overview-zones svg'),zone);
  h.main({type:'status',current:{id:'wire-1',op:'create',done:35,total:100},queue:[]});
  h.main({type:'progress',session:1,id:'wire-1',done:60,total:100});assert.match(card.textContent,/60 \/ 100 create nodes/);
  ws.receive({...update,sequence:3,progress:{done:40,total:100}});assert.match(card.textContent,/60 \/ 100 create nodes/);
  ws.receive({...t,sequence:4});assert.match(card.textContent,/60 \/ 100 create nodes/,'older full snapshots cannot rewind local progress');
  ws.receive({...update,sequence:5,requestId:'different-job',progress:{done:99,total:100}});assert.doesNotMatch(card.textContent,/99 \/ 100/);
  ws.receive({...update,sequence:6,sessionEpoch:'old-session',progress:{done:99,total:100}});assert.doesNotMatch(card.textContent,/99 \/ 100/);
  h.elements.get('mode').change({target:{value:'compact'}});assert.match(h.elements.get('compact-focus').textContent,/Batch 1/,'wire IDs correlate local progress with the public request label');
  h.main({type:'result',session:1,id:'wire-1',outcome:'succeeded'});assert.match(h.elements.get('compact-focus').textContent,/Ready for the next job/);
  h.window.beforeunload();
});

test('visible timeline advances independently, includes instant queries and stops its clock offscreen',()=>{
  const h=harness(),ws=h.connect(),t=measuredSnapshot();
  t.workers=t.workers.map(w=>({...w,current:null}));t.lanes=[];
  t.recent=[{id:'info-1',workerId:'w1',laneId:'$control',op:'info',category:'query',outcome:'succeeded',queueMs:0,executionMs:0,completedAt:9000}];
  ws.receive(t);h.tab('timeline');
  const mark=h.document.querySelector('#visual-timeline .time-track i');assert.ok(mark,'a zero-ms query is still an observed action');
  assert.match(h.elements.get('visual-timeline').textContent,/info/);
  const before=mark.style.left,workerChanges=mutations(h,h.elements.get('overview-workers'));
  h.tick(1000);assert.notEqual(mark.style.left,before);assert.equal(workerChanges.takeRecords().length,0);
  h.tab('activity');assert.match(h.elements.get('activity-list').textContent,/Query/);
  assert.equal(h.document.querySelector('#activity-list .event-title b').textContent,'info');
  assert.doesNotMatch(h.elements.get('activity-list').textContent,/\$control/);
  assert.equal([...h.timers.values()].filter(t=>t.ms===1000).length,0);
  h.tab('timeline');assert.equal([...h.timers.values()].filter(t=>t.ms===1000).length,1);
  h.document.hidden=true;h.document.visibilitychange();assert.equal(h.timers.size,0);
  workerChanges.disconnect();h.window.beforeunload();
});

test('an incompatible daemon cannot leave the UI waiting indefinitely for worker authentication',()=>{
  const h=harness();h.main({type:'identity',protocol:4,build:'test',busy:false});const ws=h.sockets[0];ws.open();
  const deadline=[...h.timers.entries()].find(([,t])=>t.ms===5000);assert.ok(deadline);
  h.timers.delete(deadline[0]);deadline[1].fn();
  assert.equal(ws.readyState,3);assert.match(h.elements.get('status').textContent,/Another Figma client may own port 3456/);
  assert.equal(h.timers.size,0);h.window.beforeunload();
});

test('the stealth banner shows only product, status and port, and opens the details on demand',()=>{
  const h=harness(),ws=h.connect();
  h.main({type:'ui-mode',mode:'stealth'});
  assert.equal(h.document.body.dataset.mode,'stealth');
  assert.equal(h.elements.get('stealth-text').textContent,'figma CLI - Connected - 3456');
  assert.deepEqual([...h.elements.get('stealth').querySelectorAll('button')].map(b=>b.textContent),['Show details']);
  h.main(snapshot());assert.equal(h.elements.get('stealth-text').textContent,'figma CLI - Working - 3456');
  h.main({type:'batch-result',session:1,id:'job-1',outcome:'partial',results:[{success:false,outcome:'uncertain'}]});
  assert.equal(h.elements.get('stealth-text').textContent,'figma CLI - Needs review - 3456');
  h.elements.get('stealth-details').click();
  assert.equal(h.document.body.dataset.mode,'compact');assert.equal(h.messages.at(-1).type,'ui-mode');assert.equal(h.messages.at(-1).mode,'compact');
  h.document.click({target:h.document.querySelector('#compact [data-window="stealth"]')});
  assert.equal(h.document.body.dataset.mode,'stealth');assert.equal(h.messages.at(-1).mode,'stealth');
  assert.equal(ws.sent.filter(m=>m.type==='subscribe').at(-1).mode,'stealth');
  h.window.beforeunload();
});

test('closing asks first, explains the running and waiting work, and offers the banner instead',()=>{
  const h=harness();h.connect();h.main(snapshot());
  const click=selector=>h.document.click({target:h.document.querySelector(selector)});
  click('.top [data-window="close"]');
  const dialog=h.elements.get('close-dialog'),card=h.elements.get('close-card');
  assert.equal(dialog.hidden,false);assert.match(card.className,/live/);
  assert.match(card.textContent,/Keep the bridge open\?/);assert.match(card.textContent,/create is running \(100 \/ 300 nodes\)/);
  assert.match(card.textContent,/1 waiting job returns to its agent as not started/);assert.match(card.textContent,/reach Example/);
  assert.equal(h.document.activeElement,card.querySelector('.keep'));
  click('[data-dialog="keep"]');assert.equal(dialog.hidden,true);assert.ok(!h.messages.some(m=>m.type==='close-plugin'));
  click('.top [data-window="close"]');h.document.keydown({key:'Escape'});assert.equal(dialog.hidden,true);
  click('.top [data-window="close"]');click('[data-dialog="minimize"]');
  assert.equal(dialog.hidden,true);assert.equal(h.document.body.dataset.mode,'stealth');assert.ok(!h.messages.some(m=>m.type==='close-plugin'));
  h.main({type:'ui-mode',mode:'compact'});h.main({type:'result',session:1,id:'job-1',outcome:'succeeded'});h.main({...snapshot(),current:null,queued:0});
  click('#compact [data-window="close"]');
  assert.doesNotMatch(card.className,/live/);assert.match(card.textContent,/Close figma-cli-ultimate\?/);
  click('[data-dialog="close"]');assert.equal(h.messages.at(-1).type,'close-plugin');
  h.window.beforeunload();
});

test('edges and corners resize the window, move it for left and top drags, and switch layouts by size',()=>{
  const h=harness();h.connect();h.main({type:'ui-mode',mode:'compact'});
  const drag=(edge,from,to)=>{
    const grip=h.document.querySelector('.resize-grip[data-edge="'+edge+'"]');
    const fire=(type,point)=>grip.dispatchEvent(new h.dom.window.MouseEvent(type,{button:0,screenX:point[0],screenY:point[1]}));
    fire('pointerdown',from);fire('pointermove',to);fire('pointerup',to);
  };
  const plain=value=>JSON.parse(JSON.stringify(value));
  Object.assign(h.window,{innerWidth:360,innerHeight:300});
  drag('sw',[500,500],[400,750]);
  assert.deepEqual(plain(h.messages.at(-1)),{type:'ui-resize',width:460,height:550,dx:-100,dy:0,mode:'standard'});
  assert.equal(h.document.body.dataset.mode,'standard');assert.equal(h.elements.get('mode').value,'standard');
  Object.assign(h.window,{innerWidth:460,innerHeight:550});
  drag('ne',[0,0],[400,-100]);
  assert.deepEqual(plain(h.messages.at(-1)),{type:'ui-resize',width:860,height:650,dx:0,dy:-100,mode:'console'});
  Object.assign(h.window,{innerWidth:860,innerHeight:650});
  drag('w',[0,0],[5000,0]);
  assert.equal(h.messages.at(-1).width,300,'never below the minimum');assert.equal(h.messages.at(-1).dx,560,'the left edge stops at the minimum width');
  h.main({type:'ui-mode',mode:'stealth'});const count=h.messages.length;
  drag('se',[0,0],[300,300]);assert.equal(h.messages.length,count,'the banner does not resize');
  assert.equal([...h.timers.values()].filter(t=>t.ms===16).length,0);
  h.window.beforeunload();
});

test('the canvas map shows every connected file, live zones with progress, writes without a zone and coarse artwork',()=>{
  const h=harness(),ws=h.connect();
  const t={type:'telemetry',schema:1,sequence:1,coordinatorEpoch:'c1',sampledAt:200000,held:0,budgets:{jobs:2,maxJobs:32,bytes:0,maxBytes:33554432},lanes:[],recent:[],
    workers:[{workerId:'w1',fileKey:'fileA',file:'Example',connected:true,pageId:'p1',page:'Home',current:{requestId:'r1',laneId:'auto-r1',label:'Checkout',agentId:'builder',op:'create',category:'change',progress:{done:5,total:10}}},
      {workerId:'w2',fileKey:'fileB',file:'Other file',connected:true,pageId:'q1',page:'Board',current:{requestId:'r9',laneId:'batch-r9',label:'Batch 9',op:'batch',category:'batch',target:{pageId:'q2',page:'Onboarding',nodeId:'5:5',kind:'write',bounds:{x:10,y:10,width:50,height:50}}}}],
    reservations:[{requestId:'r1',fileKey:'fileA',pageId:'p2',laneId:'auto-r1',agentId:'builder',label:'Checkout',state:'running',rect:{x:0,y:0,width:200,height:100}},
      {requestId:'old',fileKey:'fileA',pageId:'p2',laneId:'live-alpha',agentId:'acceptance-alpha',state:'committed',completedAt:100000,rect:{x:300,y:0,width:100,height:100}}],
    earlierCommitted:[{fileKey:'fileA',count:4}],
    sketches:[{workerId:'w1',fileKey:'fileA',pageId:'p2',page:'Checkout page',roots:3,cols:4,rows:2,extent:{x:0,y:0,width:400,height:200},cells:'f0',measuredAt:9000}]};
  ws.receive(t);
  const map=()=>h.elements.get('overview-zones');
  assert.match(map().textContent,/Example/);assert.match(map().textContent,/Other file/);
  const page=map().querySelector('[data-key="p2"]');assert.match(page.textContent,/Checkout page/);
  assert.match(page.textContent,/builder · Zone · running · 5 \/ 10 nodes/);assert.ok(page.querySelector('path.artwork'));
  assert.match(page.querySelector('g[data-key="old"]').getAttribute('style'),/opacity:0.3/,'finished zones fade, then leave the map');
  assert.match(map().textContent,/4 earlier committed zones still protect this file/);
  const onboarding=map().querySelector('[data-key="q2"]');assert.match(onboarding.textContent,/Writing · no zone · node 5:5/);
  assert.ok(onboarding.querySelector('g.target.write rect[x="10"]'));
  assert.match(map().querySelector('[data-key="q1"]').textContent,/Board.*visible · idle/);
  assert.match(map().querySelector('[data-key="p1"]').textContent,/No artwork sketch yet/);
  h.main({type:'page-sketch',pageId:'p1',page:'Home',roots:2,cols:4,rows:2,extent:{x:0,y:0,width:100,height:100},cells:'ff',measuredAt:9500});
  assert.equal(ws.sent.at(-1).type,'page-sketch','the local sketch is shared with the daemon');
  assert.match(map().querySelector('[data-key="p1"]').textContent,/2 top-level frames/);
  const picker=h.elements.get('zone-page');assert.deepEqual([...picker.options].map(o=>o.value),['','fileA','fileB']);
  picker.change({target:{value:'fileB'}});assert.doesNotMatch(map().textContent,/Example/);assert.match(map().textContent,/Other file/);
  h.window.beforeunload();
});

test('the plugin window dials each announced highway, routes its jobs, and keeps results across drops',()=>{
  const h=harness(),control=h.connect();
  h.main({type:'identity',protocol:4,build:'test',busy:false,page:'P',fileKey:'fileA',instanceId:'inst-1'});
  control.receive({type:'open-highway',highwayId:'hw-1',sessionEpoch:'hw-1',port:51234,ticket:'t'.repeat(64),agentId:'builder'});
  assert.deepEqual(h.messages.filter(m=>m.type==='highway-session').map(m=>[m.highwayId,m.sessionEpoch]),[['hw-1','hw-1']]);
  const road=h.sockets.at(-1);assert.equal(road.url,'ws://127.0.0.1:51234/plugin');
  road.open();
  assert.deepEqual([road.sent[0].type,road.sent[0].ticket,road.sent[0].fileKey,road.sent[0].instanceId,road.sent[0].busy],['hello','t'.repeat(64),'fileA','inst-1',false]);
  road.receive({action:'cmd',id:'job-1',cmd:{op:'find',name:'x'}});
  assert.equal(h.messages.at(-1).type,'cmd');assert.equal(h.messages.at(-1).highway,'hw-1');
  const controlSent=control.sent.length;
  h.main({type:'busy',busy:true,id:'job-1',op:'find',highway:'hw-1'});
  road.close(1006,'');
  // The job keeps running; its outcome waits in this window for the reconnect.
  assert.ok(!h.messages.some(m=>m.type==='cancel'&&m.channel!=='main'),'a highway drop cancels nothing');
  h.main({type:'result',id:'job-1',result:[],highway:'hw-1',session:99});
  assert.equal(control.sent.length,controlSent,'highway traffic never goes to the control socket');
  const retry=[...h.timers.entries()].find(([,t])=>t.ms===250);assert.ok(retry,'reconnect is scheduled');
  h.timers.delete(retry[0]);retry[1].fn();
  const again=h.sockets.at(-1);assert.notEqual(again,road);again.open();
  assert.equal(again.sent[0].type,'hello');assert.equal(again.sent[0].busy,true,'it says it may still be busy so the daemon resumes');
  assert.deepEqual(again.sent.slice(1).map(m=>[m.type,m.id]),[['result','job-1']]);
  control.close(1006,'');
  assert.deepEqual(h.messages.filter(m=>m.type==='cancel').map(m=>m.channel),['main'],'a control-socket drop cancels only its own channel');
  const next=h.connect();next.receive({type:'close-highway',highwayId:'hw-1'});
  assert.equal(again.readyState,3);assert.equal(h.messages.at(-1).type,'highway-closed');
  h.window.beforeunload();
});

test('highways appear in the overview, their own tab with the lobby log, and the timeline',()=>{
  const h=harness(),ws=h.connect();
  const t={...measuredSnapshot(),sampledAt:20000,
    highways:[{id:'hw-1',fileKey:'fileA',workerId:'w1',agentId:'builder',label:'builder',port:51234,state:'open',agent:'connected',plugin:'connected',queued:1,outbox:0,quarantine:false,
      current:{requestId:'r5',laneId:'auto-r5',label:'Checkout',op:'create',category:'change',executionMs:2000,progress:{done:40,total:80},target:{pageId:'p9',page:'Checkout page',nodeId:'p9',kind:'write',bounds:null}}},
      {id:'hw-2',fileKey:'fileA',workerId:'w1',agentId:'auditor',port:51240,state:'open',agent:'away',plugin:'connected',queued:0,outbox:2,quarantine:true,current:null}],
    lobby:[{at:19000,event:'agent-away',highwayId:'hw-2',fileKey:'fileA',agentId:'auditor'},{at:18000,event:'opened',highwayId:'hw-1',fileKey:'fileA',agentId:'builder',port:51234}],
    timeline:[{id:'x',workerId:'w1',highwayId:'hw-1',laneId:'$control',op:'find',category:'query',outcome:'succeeded',start:15000,end:15100}]};
  ws.receive(t);
  const rows=h.elements.get('overview-highways');
  assert.match(rows.textContent,/builder/);assert.match(rows.textContent,/Checkout · 40 \/ 80 nodes/);assert.match(rows.textContent,/port 51234/);
  assert.match(rows.querySelector('[data-key="hw-2"]').textContent,/Held · review/);assert.match(rows.querySelector('[data-key="hw-2"]').textContent,/2 waiting/);
  assert.match(h.elements.get('overview-zones').textContent,/Checkout page/,'a highway write appears on the canvas map');
  h.tab('highways');
  assert.match(h.elements.get('highway-summary').textContent,/2 highways open/);
  assert.match(h.elements.get('lobby-log').textContent,/Agent dropped · results kept/);assert.match(h.elements.get('lobby-log').textContent,/port 51234/);
  h.tab('timeline');
  assert.ok([...h.document.querySelectorAll('#visual-timeline .time-row span')].some(s=>s.textContent==='Highway · builder'));
  h.window.beforeunload();
});

test('held items can be released after review with two clicks, never one',()=>{
  const h=harness(),ws=h.connect();
  ws.receive({...measuredSnapshot(),held:1,reservations:[{requestId:'r7',fileKey:'fileA',pageId:'p1',laneId:'auto-r7',agentId:'builder',label:'Header',state:'held',rect:{x:0,y:0,width:10,height:10}}]});
  const button=()=>h.elements.get('alert').querySelector('[data-release="r7"]');
  assert.match(button().textContent,/Release after review/);
  h.document.click({target:button()});
  assert.ok(!ws.sent.some(m=>m.type==='release-hold'),'the first click only arms it');assert.match(button().textContent,/Confirm/);
  h.document.click({target:button()});
  assert.deepEqual(ws.sent.filter(m=>m.type==='release-hold').map(m=>m.requestId),['r7']);
  ws.receive({type:'release-result',requestId:'r7',result:{released:true}});
  h.window.beforeunload();
});

test('reads, snapshots and control calls appear in the timeline and Activity with where and how much',()=>{
  const h=harness(),ws=h.connect();
  const t={...measuredSnapshot(),workers:measuredSnapshot().workers.map(w=>({...w,current:null})),lanes:[],
    timeline:[{id:'c',workerId:'w1',laneId:'batch-1',label:'Batch 1',op:'batch',category:'batch',outcome:'partial',start:5000,end:9000},
      {id:'a',workerId:'w1',laneId:'$control',op:'info',category:'query',outcome:'succeeded',start:9000,end:9001},
      {id:'b',workerId:'w1',laneId:'$exclusive',op:'exportImage',category:'screenshot',outcome:'succeeded',start:8000,end:9500}],
    recent:[{id:'b',workerId:'w1',laneId:'$exclusive',op:'exportImage',category:'screenshot',outcome:'succeeded',target:{pageId:'p1',page:'Home',nodeId:'4:2',kind:'snapshot'},responseBytes:2202009,completedAt:9500,queueMs:0,executionMs:1500},
      {id:'q',workerId:'w1',laneId:'$exclusive',op:'find',category:'query',outcome:'succeeded',items:24,responseBytes:3000,target:{pageId:'p1',page:'Home',nodeId:'p1',kind:'read'},completedAt:9400,queueMs:0,executionMs:20},
      {id:'c',workerId:'w1',laneId:'batch-1',label:'Batch 1',op:'batch',category:'batch',outcome:'partial',items:8,completedAt:9000,queueMs:100,executionMs:4000}]};
  ws.receive(t);h.tab('timeline');
  const rows=[...h.document.querySelectorAll('#visual-timeline .time-row')];
  assert.deepEqual(rows.map(r=>r.querySelector('span').textContent),['Batch 1','Reads · info, exportImage']);
  assert.ok(rows[1].querySelector('i.cat-query'));assert.ok(rows[1].querySelector('i.cat-screenshot'));assert.ok(rows[0].querySelector('i.failed'));
  assert.match(h.elements.get('visual-timeline').textContent,/Snapshots \/ exports/);
  h.tab('activity');const text=()=>h.elements.get('activity-list').textContent;
  assert.match(text(),/Home/);assert.match(text(),/Node 4:2/);assert.match(text(),/2\.1 MB returned/);assert.match(text(),/24 results/);assert.match(text(),/8 commands/);
  const filter=h.elements.get('filter');
  filter.value='reads';filter.change({target:filter});assert.match(text(),/exportImage/);assert.match(text(),/find/);assert.doesNotMatch(text(),/Batch 1/);
  filter.value='changes';filter.change({target:filter});assert.match(text(),/Batch 1/);assert.doesNotMatch(text(),/exportImage/);
  filter.value='all';filter.change({target:filter});
  ws.receive({...t,sequence:2,recent:[{id:'scan',workerId:'w1',laneId:'auto-1',label:'Placement scan',op:'layoutInfo',category:'query',outcome:'succeeded',items:21,completedAt:9600}]});
  assert.match(text(),/21 frames scanned/);assert.doesNotMatch(text(),/scanneds/);
  h.window.beforeunload();
});
