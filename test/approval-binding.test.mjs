import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('approval and undo operate on the exact selected proposal', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(),'mychat-approval-'));
  const root = path.join(home,'..',path.basename(home)+'-workspace');
  await fs.mkdir(root);
  await fs.writeFile(path.join(home,'settings.json'), JSON.stringify({allowLocal:false,allowKeyless:false}));
  process.env.MYCHAT_HOME = home;
  const {server,token} = await import('../pc/server.mjs');
  try {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const send = (action,id) => fetch(`${origin}/agent/${action}`,{
      method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({id}),signal:AbortSignal.timeout(5000),
    });
    for (const label of ['first','second']) {
      const plan = {id:label,root,goal:label,ops:[{op:'write',path:`${label}.txt`,content:label}]};
      await fs.writeFile(path.join(home,'agent',`plan-${label}.json`),JSON.stringify(plan));
    }
    assert.equal((await send('apply','latest')).status,400);
    assert.equal((await send('apply','missing')).status,404);
    const applied = await send('apply','first');
    assert.equal(applied.status,200,await applied.text());
    assert.equal(await fs.readFile(path.join(root,'first.txt'),'utf8'),'first');
    await assert.rejects(fs.stat(path.join(root,'second.txt')),{code:'ENOENT'});
    assert.equal((await send('undo','latest')).status,400);
    assert.equal((await send('undo','first')).status,200);
    await assert.rejects(fs.stat(path.join(root,'first.txt')),{code:'ENOENT'});
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
