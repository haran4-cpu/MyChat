import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {checkPage,findBrowser} from '../pc/pagecheck.mjs';
import {nodeFs} from '../pc/agentfs.mjs';
import {apply,preview} from '../core/agent.mjs';

test('browser rejects a silent wrong result and verifies the approved fix', {skip:!findBrowser()}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'mychat-acceptance-'));
  const file = path.join(root,'counter.html');
  await fs.writeFile(file, '<!doctype html><button id="add">Add</button><output id="count">0</output><script>document.querySelector("#add").onclick=()=>{ document.querySelector("#count").textContent="2"; };</script>');
  const options = {clicks:1,waitMs:0,expectedText:{selector:'#count',text:'1'},outDir:root,timeoutMs:30000};
  const before = await checkPage(file,options);
  assert.equal(before.errors.length,0);
  assert.equal(before.acceptance.actual,'2');
  assert.equal(before.ok,false);
  const adapter = nodeFs(root);
  const ops = [{op:'edit',path:'counter.html',old:'textContent="2"',new:'textContent="1"'}];
  const journal = await apply(adapter,{id:'counter-fix',ops,preview:await preview(adapter,ops),enforcePreview:true});
  assert.equal(journal.steps.length,1);
  const after = await checkPage(file,options);
  assert.equal(after.acceptance.actual,'1');
  assert.equal(after.ok,true);
  console.log('Acceptance evidence:', JSON.stringify({before:before.acceptance,after:after.acceptance,errorsBefore:before.errors.length,errorsAfter:after.errors.length}));
});
