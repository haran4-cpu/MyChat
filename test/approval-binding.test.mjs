import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {preview} from '../core/agent.mjs';

test('approval and undo operate on the exact selected proposal', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(),'mychat-approval-'));
  const root = path.join(home,'..',path.basename(home)+'-workspace');
  await fs.mkdir(root);
  await fs.writeFile(path.join(home,'settings.json'), JSON.stringify({allowLocal:false,allowKeyless:false}));
  process.env.MYCHAT_HOME = home;
  const {server,token} = await import('../pc/server.mjs');
  const {nodeFs} = await import('../pc/agentfs.mjs');
  try {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const send = (action,id) => fetch(`${origin}/agent/${action}`,{
      method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({id}),signal:AbortSignal.timeout(5000),
    });
    const review = id => fetch(`${origin}/agent/plan?id=${id}`, {
      headers: {Authorization:`Bearer ${token}`}, signal:AbortSignal.timeout(5000),
    });
    for (const label of ['first','second']) {
      const plan = {id:label,root,goal:label,ops:[{op:'write',path:`${label}.txt`,content:label}]};
      plan.preview = await preview(nodeFs(root),plan.ops);
      await fs.writeFile(path.join(home,'agent',`plan-${label}.json`),JSON.stringify(plan));
    }
    assert.equal((await send('apply','latest')).status,400);
    assert.equal((await send('apply','missing')).status,404);
    await fs.writeFile(path.join(root,'second.txt'),'created after preview');
    const stale = await (await review('second')).json();
    assert.equal(stale.id,'second');
    assert.equal(stale.checks[0].status,'blocked');
    assert.match(stale.checks[0].message,/changed since preview/);
    assert.equal((await review('missing')).status,404);
    assert.equal((await send('apply','second')).status,409);
    assert.equal(await fs.readFile(path.join(root,'second.txt'),'utf8'),'created after preview');
    await fs.unlink(path.join(root,'second.txt'));
    const applied = await send('apply','first');
    assert.equal(applied.status,200,await applied.text());
    assert.equal(await fs.readFile(path.join(root,'first.txt'),'utf8'),'first');
    assert.deepEqual((await (await review('first')).json()).journal.steps,[{}]);
    await assert.rejects(fs.stat(path.join(root,'second.txt')),{code:'ENOENT'});
    assert.equal((await send('undo','latest')).status,400);
    assert.equal((await send('undo','first')).status,200);
    await assert.rejects(fs.stat(path.join(root,'first.txt')),{code:'ENOENT'});
    assert.equal((await send('apply','second')).status,200);
    await fs.writeFile(path.join(root,'second.txt'),'manual edits after apply');
    const conflict = await (await send('undo','second')).json();
    assert.equal(conflict.ok,false);
    assert.equal(await fs.readFile(path.join(root,'second.txt'),'utf8'),'manual edits after apply');
    for (const [name,content] of [['broken.mjs','export const = 1;'],['broken.json','{"alpha":}']]) {
      const plan = {id:'broken',root,ops:[{op:'write',path:name,content}]};
      plan.preview = await preview(nodeFs(root),plan.ops);
      await fs.writeFile(path.join(home,'agent','plan-broken.json'),JSON.stringify(plan));
      assert.equal((await (await review('broken')).json()).checks[0].status,'blocked');
      const rejected = await send('apply','broken');
      assert.equal(rejected.status,409);
      await assert.rejects(fs.stat(path.join(root,name)),{code:'ENOENT'});
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
