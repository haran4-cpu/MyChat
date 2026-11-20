"""Execution-grounded verification: run what the model wrote and report facts, not opinions.

web (.html): the page is loaded in a real headless browser (Edge/Chrome/Avast, whichever exists) with a
  probe injected on the first line (so line numbers in errors stay true). The probe records uncaught
  errors, console.error, alert/confirm/prompt, timers, animation frames, listeners and canvas draw calls,
  then drives the page like a user (Enter, Space, arrows, WASD, a button click, a canvas click) and
  snapshots the canvas/DOM before and after. Virtual time makes 6 s of page time take ~1 s.
python (.py): compiled, then run in a temp folder with a timeout (only with the person's approval).
javascript (.js): node --check, then run with a timeout (only with approval).

The verdict is deterministic: the model never grades its own work here.
"""
from __future__ import annotations

import json
import os
import py_compile
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

# Probe: must stay on ONE line so the page's own line numbers do not move.
_PROBE_HEAD = (
    "<script>(function(){var K=window.__k={errors:[],alerts:[],raf:0,timers:0,intervals:0,listeners:{},draws:0,snap:[]};"
    "K._st=window.setTimeout.bind(window);"
    "function E(m){if(K.errors.length<25)K.errors.push(String(m).slice(0,500));}K.E=E;"
    "window.addEventListener('error',function(e){if(e.target&&e.target!==window&&e.target.src){E('failed to load '+e.target.src);return;}"
    "E((e.message||'error')+(e.lineno?' (line '+e.lineno+', col '+e.colno+')':'')+(e.error&&e.error.stack?' | '+String(e.error.stack).split('\\n').slice(0,3).join(' / '):''));},true);"
    "window.addEventListener('unhandledrejection',function(e){E('unhandled promise rejection: '+(e.reason&&e.reason.message||e.reason));});"
    "console.error=function(){E('console.error: '+[].map.call(arguments,String).join(' '));};"
    "window.alert=function(m){K.alerts.push({t:K.snap.length,m:String(m).slice(0,200)});};"
    "window.confirm=function(m){K.alerts.push({t:K.snap.length,m:'confirm: '+m});return true;};"
    "window.prompt=function(m,d){K.alerts.push({t:K.snap.length,m:'prompt: '+m});return d||'test';};"
    "window.requestAnimationFrame=function(f){K.raf++;return K._st(function(){f(performance.now());},16);};window.cancelAnimationFrame=function(i){clearTimeout(i);};"
    "var si=window.setInterval.bind(window);window.setInterval=function(){K.intervals++;return si.apply(null,arguments);};"
    "window.setTimeout=function(){K.timers++;return K._st.apply(null,arguments);};"
    "var ael=EventTarget.prototype.addEventListener;EventTarget.prototype.addEventListener=function(t,f,o){K.listeners[t]=(K.listeners[t]||0)+1;return ael.call(this,t,f,o);};"
    "var C=window.CanvasRenderingContext2D&&CanvasRenderingContext2D.prototype;"
    "if(C)['fillRect','strokeRect','fillText','strokeText','drawImage','arc','fill','stroke','clearRect','rect','lineTo','putImageData'].forEach(function(n){var o=C[n];if(o)C[n]=function(){K.draws++;return o.apply(this,arguments);};});"
    "})();</script>"
)

_PROBE_TAIL = r"""
<script>(function(){var K=window.__k,st=K._st;
function h(s){var x=0;for(var i=0;i<s.length;i+=5)x=(x*31+s.charCodeAt(i))|0;return x;}
function sig(){var s='';var cs=document.querySelectorAll('canvas');for(var i=0;i<cs.length;i++){try{s+=h(cs[i].toDataURL())+','}catch(e){s+='?,'}}
 var b=document.body;return s+'|'+(b?h(b.innerText)+'|'+h(b.innerHTML):'');}
function snap(t){K.snap.push({t:t,s:sig(),draws:K.draws,raf:K.raf,errors:K.errors.length});}
function key(k,code,kc){['keydown','keypress','keyup'].forEach(function(t){var ev=new KeyboardEvent(t,{key:k,code:code,keyCode:kc,which:kc,bubbles:true,cancelable:true});
 try{Object.defineProperty(ev,'keyCode',{get:function(){return kc}});Object.defineProperty(ev,'which',{get:function(){return kc}});}catch(e){}
 (document.activeElement||document.body||document).dispatchEvent(ev);});}
function report(){var pre=document.createElement('pre');pre.id='__kestrel_report';pre.style.display='none';
 pre.textContent=JSON.stringify({inventory:K.inv||[],controls:K.controls||[],errors:K.errors,alerts:K.alerts,raf:K.raf,timers:K.timers,intervals:K.intervals,listeners:K.listeners,
  inlineKey:!!(document.onkeydown||window.onkeydown||document.onkeyup||window.onkeyup||(document.body&&document.body.onkeydown)),
  draws:K.draws,snaps:K.snap,canvases:document.querySelectorAll('canvas').length,buttons:document.querySelectorAll('button,input[type=button],[onclick]').length,
  inputs:document.querySelectorAll('input,textarea,select').length,textLen:(document.body?document.body.innerText.length:0)});
 (document.body||document.documentElement).appendChild(pre);}
function inventory(){var out=[];var els=document.querySelectorAll('[id],button,input,select,textarea,canvas,[onclick],a[href^="#"]');
 for(var i=0;i<els.length&&out.length<60;i++){var e=els[i];if(e.id==='__kestrel_report')continue;
  out.push({tag:e.tagName.toLowerCase(),id:e.id||'',type:e.type||'',text:((e.innerText||e.value||e.getAttribute('aria-label')||'')+'').trim().replace(/\s+/g,' ').slice(0,40)});}
 return out;}
function run(){K.inv=inventory();snap('start');st(function(){snap('idle');if(location.hash==='#noinput'){st(function(){snap('later');report();},1500);return;}
 var seq=[['Enter','Enter',13],[' ','Space',32],['ArrowRight','ArrowRight',39],['ArrowDown','ArrowDown',40],['ArrowLeft','ArrowLeft',37],['ArrowUp','ArrowUp',38],['d','KeyD',68],['s','KeyS',83],['a','KeyA',65],['w','KeyW',87]];
 var i=0;(function next(){if(i<seq.length){key(seq[i][0],seq[i][1],seq[i][2]);i++;st(next,120);return;}
  snap('after_keys');
  var ctl=[].slice.call(document.querySelectorAll('button,input[type=button],input[type=submit],input[type=checkbox],input[type=radio],[onclick],select,a[href^="#"]')).filter(function(e){return e.id!=='__kestrel_report'}).slice(0,24);
  K.controls=[];var j=0;
  (function press(){if(j<ctl.length){var e=ctl[j++],before=K.errors.length,lab=((e.innerText||e.value||e.getAttribute('aria-label')||e.id||e.tagName)+'').trim().slice(0,40);
    try{if(e.tagName==='SELECT'){if(e.options.length>1){e.selectedIndex=(e.selectedIndex+1)%e.options.length;}e.dispatchEvent(new Event('change',{bubbles:true}));}else{e.click();}}catch(x){K.E('clicking "'+lab+'": '+x)}
    st(function(){var n=K.errors.length-before;K.controls.push({label:lab,errors:n,first:n?K.errors[before]:''});press();},150);return;}
   if(ctl.length){try{ctl[0].click()}catch(x){}}
   var c=document.querySelector('canvas');if(c){var r=c.getBoundingClientRect();['mousedown','mouseup','click'].forEach(function(t){
    try{c.dispatchEvent(new MouseEvent(t,{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2}))}catch(x){}});}
   st(function(){snap('after_click');st(function(){snap('later');report();},1500);},1200);})();})();
 },1500);}
if(document.readyState==='complete')st(run,50);else window.addEventListener('load',function(){st(run,50);});
})();</script>
"""

_BROWSERS_WIN = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\AVAST Software\Browser\Application\AvastBrowser.exe",
    r"C:\Program Files (x86)\AVAST Software\Browser\Application\AvastBrowser.exe",
]

_TEST_TAIL = r"""
<script>(function(){var K=window.__k,st=K._st,T=window.__ktest,res={name:T.name,ok:true,step:-1,msg:'',log:[]},marks={};
function h(s){var x=0;for(var i=0;i<s.length;i+=3)x=(x*31+s.charCodeAt(i))|0;return x;}
function vis(e){if(!e)return false;var r=e.getBoundingClientRect();var cs=getComputedStyle(e);return r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none'&&cs.opacity!=='0';}
function txt(e){if(!e)return'';if(e.tagName==='INPUT'||e.tagName==='TEXTAREA'||e.tagName==='SELECT')return String(e.value);return (e.innerText||e.textContent||'').trim();}
function find(t){if(t==null||t==='')return document.body;t=String(t).trim();var low=t.toLowerCase();
 if(low==='page'||low==='body')return document.body;if(low==='canvas')return document.querySelector('canvas');
 if(/^[#.\[]/.test(t)||/^[a-z]+[#.\[]/.test(t)){try{return document.querySelector(t)}catch(e){}}
 var groups=['button,input[type=button],input[type=submit],a,[role=button],[onclick],select,label','h1,h2,h3,h4,h5,h6,p,span,div,li,td,th,output,strong,b'];
 for(var g=0;g<2;g++){var c=[].slice.call(document.querySelectorAll(groups[g])).filter(function(e){return e.id!=='__kestrel_report'});
  var ex=c.filter(function(e){return txt(e).toLowerCase()===low||(e.value||'').toLowerCase()===low||(e.getAttribute('aria-label')||'').toLowerCase()===low});
  if(ex.length)return ex.sort(function(a,b){return a.querySelectorAll('*').length-b.querySelectorAll('*').length})[0];
  var co=c.filter(function(e){return txt(e).toLowerCase().indexOf(low)>=0});
  if(co.length)return co.sort(function(a,b){return a.querySelectorAll('*').length-b.querySelectorAll('*').length})[0];}
 try{return document.querySelector(t)}catch(e){}
 return null;}
function sig(e){if(!e)return'missing';if(e.tagName==='CANVAS'){try{return 'c'+h(e.toDataURL())}catch(x){return '?'}}return 't'+h(txt(e))+'|'+h(e.className||'')+'|'+(e.getAttribute('style')||'')+'|'+vis(e);}
function num(s){s=String(s);var m=s.match(/(-?\d+):(\d{1,2})(?::(\d{1,2}))?/);if(m){return m[3]!==undefined?(+m[1])*3600+(+m[2])*60+(+m[3]):(+m[1])*60+(+m[2]);}
 m=s.replace(/,/g,'').match(/-?\d+(\.\d+)?/);return m?parseFloat(m[0]):NaN;}
var KC={Enter:13,' ':32,Space:32,Escape:27,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Backspace:8,Tab:9};
function key(k){var kc=KC[k]||(k.length===1?k.toUpperCase().charCodeAt(0):0),code=k===' '?'Space':(k.length===1?(/[a-z]/i.test(k)?'Key'+k.toUpperCase():(/\d/.test(k)?'Digit'+k:k)):k);
 ['keydown','keypress','keyup'].forEach(function(t){var ev=new KeyboardEvent(t,{key:k==='Space'?' ':k,code:code,keyCode:kc,which:kc,bubbles:true,cancelable:true});
 try{Object.defineProperty(ev,'keyCode',{get:function(){return kc}});Object.defineProperty(ev,'which',{get:function(){return kc}});}catch(e){}
 (document.activeElement&&document.activeElement!==document.body?document.activeElement:document).dispatchEvent(ev);});}
function fail(i,m){res.ok=false;res.step=i;res.msg=m;}
function done(){res.errors=K.errors.slice(0,5);var pre=document.createElement('pre');pre.id='__kestrel_test';pre.style.display='none';pre.textContent=JSON.stringify(res);(document.body||document.documentElement).appendChild(pre);
 try{if(window.parent&&window.parent!==window)window.parent.postMessage({__ktest:res},'*');}catch(e){}}
var steps=T.steps||[],i=0;
function next(){if(!res.ok||i>=steps.length){done();return;}var s=steps[i],n=i++,e0=K.errors.length,wait=0;
 try{var d=s['do'];var el=(d==='wait'||d==='key'||d==='expect_no_errors')?null:find(s.target);
  if(d!=='wait'&&d!=='key'&&d!=='expect_no_errors'&&d!=='expect_hidden'&&!el){fail(n,'could not find "'+s.target+'" on the page');done();return;}
  if(d==='click'){if(el.tagName==='CANVAS'){var r=el.getBoundingClientRect(),x=r.left+r.width*(s.x==null?.5:s.x),y=r.top+r.height*(s.y==null?.5:s.y);
     ['mousedown','mouseup','click'].forEach(function(t){el.dispatchEvent(new MouseEvent(t,{bubbles:true,clientX:x,clientY:y}))});}else{el.click();}wait=60;}
  else if(d==='key'){var times=Math.min(+s.times||1,50);for(var k=0;k<times;k++)key(String(s.key));wait=60;}
  else if(d==='type'){el.focus();el.value=String(s.text==null?'':s.text);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));wait=60;}
  else if(d==='wait'){wait=Math.min(+s.ms||0,30000);}
  else if(d==='mark'){marks[s.target||'']={sig:sig(el),num:num(txt(el))};}
  else if(d==='expect'){var t=txt(el);if(s.text_matches!=null&&!(new RegExp(s.text_matches,'i')).test(t))fail(n,'"'+s.target+'" shows "'+t.slice(0,80)+'", expected to match /'+s.text_matches+'/');
     if(res.ok&&s.not_matches!=null&&(new RegExp(s.not_matches,'i')).test(t))fail(n,'"'+s.target+'" shows "'+t.slice(0,80)+'", which should not match /'+s.not_matches+'/');}
  else if(d==='expect_number'){var v=num(txt(el)),ref=(s.value==='mark'||s.value==null)?(marks[s.target||'']||{}).num:+s.value,op=s.op||'==',ok=
     op==='<'?v<ref:op==='>'?v>ref:op==='<='?v<=ref:op==='>='?v>=ref:op==='!='?v!==ref:v===ref;
     if(!(ok))fail(n,'"'+s.target+'" = '+v+' ("'+txt(el).slice(0,40)+'"), expected '+op+' '+ref+(s.value==='mark'?' (the marked value)':''));}
  else if(d==='expect_changed'||d==='expect_same'){var m=marks[s.target||''];if(!m){fail(n,'no "mark" step for "'+s.target+'" before this check');}
     else{var same=m.sig===sig(el);if(d==='expect_changed'&&same)fail(n,'"'+s.target+'" did not change');if(d==='expect_same'&&!same)fail(n,'"'+s.target+'" changed but should not have');}}
  else if(d==='expect_visible'){if(!vis(el))fail(n,'"'+s.target+'" is not visible');}
  else if(d==='expect_hidden'){if(el&&vis(el))fail(n,'"'+s.target+'" is visible but should be hidden');}
  else if(d==='expect_no_errors'){if(K.errors.length)fail(n,'errors so far: '+K.errors[0]);}
  else{fail(n,'unknown step "'+d+'"');}
 }catch(x){fail(n,'step threw: '+x);}
 st(function(){if(res.ok&&K.errors.length>e0)fail(n,'step "'+(steps[n]['do'])+' '+(steps[n].target||steps[n].key||'')+'" caused an error: '+K.errors[e0]);next();},wait);}
function go(){st(next,300);}
if(document.readyState==='complete')go();else window.addEventListener('load',go);
})();</script>
"""


_RUNNER = """<!doctype html><html><body><pre id="__kestrel_all"></pre><script>
var files=%s,names=%s,res=[],i=0,timer=null;
function next(){if(i>=files.length){document.getElementById('__kestrel_all').textContent=JSON.stringify(res);return;}
 var f=document.createElement('iframe');f.style.cssText='width:1024px;height:768px;border:0';f.src=files[i];document.body.appendChild(f);
 timer=setTimeout(function(){res.push({name:names[i],ok:false,msg:'the test did not finish in time (page froze or never loaded)'});f.remove();i++;next();},%d);}
window.addEventListener('message',function(e){if(!e.data||!e.data.__ktest)return;clearTimeout(timer);res.push(e.data.__ktest);
 var fs=document.getElementsByTagName('iframe');if(fs.length)fs[0].remove();i++;setTimeout(next,0);});
next();</script></body></html>"""


def _test_page(html: str, t: dict, n: int) -> tuple[str, int]:
    steps = [s for s in (t.get("steps") or []) if isinstance(s, dict)][:30]
    budget = 3000 + sum(min(int(s.get("ms") or 0), 30000) for s in steps if s.get("do") == "wait") + 200 * len(steps)
    inject = "<script>window.__ktest=" + json.dumps({"name": t.get("name", f"test {n + 1}"), "steps": steps}).replace("</", "<\\/") + ";</script>"
    # each test starts from a clean slate: no data left in storage by an earlier test
    head = _PROBE_HEAD.replace("<script>(function(){", "<script>(function(){try{localStorage.clear();sessionStorage.clear();}catch(e){}", 1)
    page = re.sub(r"(<head[^>]*>)", lambda m: m.group(1) + head, html, count=1, flags=re.I)
    if page == html:
        page = head + html
    tail = inject + _TEST_TAIL
    page = (page + tail) if not re.search(r"</body>", page, re.I) else \
        re.sub(r"</body>(?![\s\S]*</body>)", lambda m: tail + "</body>", page, flags=re.I)
    return page, budget


def run_tests(path: Path, tests: list, browser: str = "", timeout: int = 45) -> list:
    """Run acceptance tests (small step language). Fast path: ONE browser launch, each test in a fresh iframe that
    reports back by postMessage (measured: a fresh Edge per test cost ~57 s each on this PC under load).
    If the batch hangs, fall back to one launch per test so a freezing test is pinned down."""
    browser = find_browser(browser)
    if not browser or not tests:
        return []
    html = path.read_text(encoding="utf-8", errors="replace")
    tests = tests[:10]
    td = tempfile.mkdtemp(prefix="kestrel_test_")
    try:
        files, total = [], 0
        for n, t in enumerate(tests):
            page, budget = _test_page(html, t, n)
            f = Path(td) / f"t{n}_{path.name}"
            f.write_text(page, encoding="utf-8")
            files.append(f.name)
            total += budget
        names = [t.get("name", f"test {n + 1}") for n, t in enumerate(tests)]
        per = max(b for b in [3000] + [_test_page(html, t, n)[1] for n, t in enumerate(tests)]) + 2000
        runner = Path(td) / "_runner.html"
        runner.write_text(_RUNNER % (json.dumps(files), json.dumps(names), per), encoding="utf-8")
        dom = _dump(browser, runner, Path(td), "", timeout + 5 * len(tests), budget=min(total + 2000 * len(tests), 240000), tag="all")
        m = re.search(r'<pre id="__kestrel_all"[^>]*>(.*?)</pre>', dom or "", re.S)
        if m and m.group(1).strip():
            import html as _h
            got = json.loads(_h.unescape(m.group(1)))
            if len(got) == len(tests):
                return [{"name": names[i], "ok": bool(r.get("ok")), "msg": r.get("msg", ""), "step": r.get("step", -1)} for i, r in enumerate(got)]
    finally:
        shutil.rmtree(td, ignore_errors=True)
    return _run_tests_one_by_one(path, tests, browser, timeout)


def _run_tests_one_by_one(path: Path, tests: list, browser: str, timeout: int) -> list:
    html = path.read_text(encoding="utf-8", errors="replace")
    out = []
    td = tempfile.mkdtemp(prefix="kestrel_test_")
    try:
        for n, t in enumerate(tests[:10]):
            steps = [s for s in (t.get("steps") or []) if isinstance(s, dict)][:30]
            budget = 3000 + sum(min(int(s.get("ms") or 0), 30000) for s in steps if s.get("do") == "wait") + 200 * len(steps)
            inject = "<script>window.__ktest=" + json.dumps({"name": t.get("name", f"test {n + 1}"), "steps": steps}).replace("</", "<\\/") + ";</script>"
            page = re.sub(r"(<head[^>]*>)", lambda m: m.group(1) + _PROBE_HEAD, html, count=1, flags=re.I)
            if page == html:
                page = _PROBE_HEAD + html
            tail = inject + _TEST_TAIL
            page = (page + tail) if not re.search(r"</body>", page, re.I) else \
                re.sub(r"</body>(?![\s\S]*</body>)", lambda m: tail + "</body>", page, flags=re.I)
            f = Path(td) / f"t{n}_{path.name}"
            f.write_text(page, encoding="utf-8")
            dom = _dump(browser, f, Path(td), "", timeout, budget=min(budget, 60000), tag=f"t{n}")
            name = t.get("name", f"test {n + 1}")
            if dom is None:
                out.append({"name": name, "ok": False, "msg": "the page froze during this test"})
                continue
            m = re.search(r'<pre id="__kestrel_test"[^>]*>(.*?)</pre>', dom, re.S)
            if not m:
                out.append({"name": name, "ok": False, "msg": "the test never finished (page crashed or navigated away)"})
                continue
            import html as _h
            r = json.loads(_h.unescape(m.group(1)))
            out.append({"name": name, "ok": bool(r.get("ok")), "msg": r.get("msg", ""), "step": r.get("step", -1)})
    finally:
        shutil.rmtree(td, ignore_errors=True)
    return out


def find_browser(preferred: str = "") -> str:
    if preferred and Path(preferred).exists():
        return preferred
    for name in ("msedge", "chrome", "google-chrome", "chromium", "chromium-browser"):
        p = shutil.which(name)
        if p:
            return p
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA", "")
        extra = [os.path.join(local, r"Google\Chrome\Application\chrome.exe")] if local else []
        for p in _BROWSERS_WIN + extra:
            if Path(p).exists():
                return p
    return ""


def find_node() -> str:
    p = shutil.which("node")
    if p:
        return p
    for c in (r"C:\Program Files\nodejs\node.exe", r"C:\Program Files (x86)\nodejs\node.exe"):
        if Path(c).exists():
            return c
    return ""


@dataclass
class Report:
    kind: str
    ok: bool = False                  # no hard failure found
    ran: bool = False                 # we actually executed it (not just parsed)
    failures: list = field(default_factory=list)   # hard problems: must be fixed
    warnings: list = field(default_factory=list)   # soft problems: likely bugs
    facts: list = field(default_factory=list)      # observed behaviour, for the model and the person
    raw: dict = field(default_factory=dict)
    tests: list = field(default_factory=list)      # acceptance test results [{name, ok, msg}]

    @property
    def tests_failed(self) -> list:
        return [t for t in self.tests if not t.get("ok")]

    @property
    def passed(self) -> bool:
        """Runs clean AND every acceptance test passes."""
        return self.ok and not self.tests_failed

    @property
    def score(self) -> int:
        """Higher is better. Used to keep the best candidate; never decreases the kept version."""
        return (1000 if self.passed else 0) + (50 if self.ran else 0) - 100 * len(self.failures) \
            - 40 * len(self.tests_failed) + 5 * (len(self.tests) - len(self.tests_failed)) - 10 * len(self.warnings)

    def text(self) -> str:
        out = [f"verifier ({self.kind}): {'PASS' if self.passed else 'FAIL'}" + ("" if self.ran else " (static checks only)")]
        out += [f"FAIL: {f}" for f in self.failures]
        out += [f"FAIL: acceptance test '{t['name']}': {t['msg']}" for t in self.tests_failed]
        if self.tests:
            out.append(f"acceptance tests: {len(self.tests) - len(self.tests_failed)}/{len(self.tests)} passed")
        out += [f"WARN: {w}" for w in self.warnings] + [f"fact: {f}" for f in self.facts]
        return "\n".join(out)


# ---------------------------------------------------------------------------
def _scripts(html: str) -> list[tuple[int, str]]:
    """Inline scripts with the 1-based line where their code starts."""
    out = []
    for m in re.finditer(r"<script\b([^>]*)>(.*?)</script>", html, re.S | re.I):
        attrs, body = m.group(1), m.group(2)
        if re.search(r"\bsrc\s*=", attrs) or re.search(r"type\s*=\s*['\"](?!text/javascript|module|application/javascript)", attrs):
            continue
        out.append((html.count("\n", 0, m.start(2)) + 1, body, "module" in attrs))
    return out


def static_web(html: str) -> list[str]:
    probs = []
    low = html.lower()
    if "<html" not in low and "<body" not in low and "<canvas" not in low and "<div" not in low:
        probs.append("this does not look like an HTML document")
    for tag in ("script", "style"):
        if low.count(f"<{tag}") != low.count(f"</{tag}>"):
            probs.append(f"unbalanced <{tag}> tags ({low.count(f'<{tag}')} open, {low.count(f'</{tag}>')} close)")
    ext = re.findall(r"<script[^>]+src=['\"](https?:)?//", html, re.I)
    if ext:
        probs.append("loads scripts from the internet; the page must work offline (inline everything)")
    # duplicated top-level function definitions are a classic small-model failure (and a sign of a loop)
    names = re.findall(r"^\s*function\s+([A-Za-z_$][\w$]*)\s*\(", html, re.M)
    dup = sorted({n for n in names if names.count(n) > 1})
    if dup:
        probs.append(f"functions defined more than once (the later one silently wins): {', '.join(dup)}")
    ids_used = set(re.findall(r"getElementById\(\s*['\"]([^'\"]+)['\"]", html))
    ids_have = set(re.findall(r"\bid\s*=\s*['\"]([^'\"]+)['\"]", html))
    missing = sorted(i for i in ids_used - ids_have if not re.search(rf"\.id\s*=\s*['\"]{re.escape(i)}['\"]", html))
    if missing:
        probs.append(f"getElementById for ids that do not exist in the HTML: {', '.join(missing)}")
    return probs


def node_check(code: str, module: bool = False, node: str = "") -> str:
    node = node or find_node()
    if not node:
        return ""
    r = subprocess.run([node, "--check", f"--input-type={'module' if module else 'commonjs'}"], input=code.encode("utf-8"),
                       capture_output=True, timeout=20)
    if r.returncode == 0:
        return ""
    msg = r.stderr.decode("utf-8", "replace")
    return "\n".join(l for l in msg.splitlines() if l.strip() and "node:internal" not in l and "Node.js v" not in l)[:600]


def _dump(browser: str, page: Path, td: Path, frag: str, timeout: int, budget: int = 9000, tag: str = ""):
    """Run the page in a fresh headless profile and return the final DOM, or None if it hung."""
    args = [browser, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
            "--disable-extensions", "--mute-audio", "--allow-file-access-from-files", "--disable-sync",
            "--disable-background-networking", "--disable-component-update", "--disable-default-apps",
            f"--user-data-dir={td / ('profile' + tag + str(abs(hash(frag)) % 1000))}", f"--virtual-time-budget={budget}",
            "--dump-dom", page.as_uri() + frag]
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        args.insert(1, "--no-sandbox")
    kw = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if sys.platform == "win32" else {"start_new_session": True}
    pr = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, **kw)
    try:
        out, _ = pr.communicate(timeout=timeout)
        return out.decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        _kill_tree(pr)
        return None


def _kill_tree(pr) -> None:
    try:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(pr.pid)], capture_output=True, timeout=20)
        else:
            import signal
            os.killpg(pr.pid, signal.SIGKILL)
    except Exception:
        pr.kill()
    try:
        pr.communicate(timeout=10)
    except Exception:
        pass


def check_web(path: Path, browser: str = "", interactive: bool = True, timeout: int = 45) -> Report:
    rep = Report("web")
    html = path.read_text(encoding="utf-8", errors="replace")
    rep.failures += static_web(html)
    node = find_node()
    for line, body, module in _scripts(html):
        err = node_check(body, module, node) if node else ""
        if err:
            m = re.search(r":(\d+)\s*\n", err + "\n")
            where = f" near line {line + int(m.group(1)) - 1}" if m else ""
            rep.failures.append(f"JavaScript syntax error{where}: {err.splitlines()[-1] if err else ''}\n{err}")
    browser = find_browser(browser)
    if not browser:
        rep.warnings.append("no browser found for a live run (Edge/Chrome); only static checks were done")
        rep.ok = not rep.failures
        return rep
    td = tempfile.mkdtemp(prefix="kestrel_web_")
    try:
        probe = re.sub(r"(<head[^>]*>)", lambda m: m.group(1) + _PROBE_HEAD, html, count=1, flags=re.I)
        if probe == html:  # no <head>: put the probe at the very start, on the first line
            probe = _PROBE_HEAD + html
        probe = (probe + _PROBE_TAIL) if not re.search(r"</body>", probe, re.I) else \
            re.sub(r"</body>(?![\s\S]*</body>)", lambda m: _PROBE_TAIL + "</body>", probe, flags=re.I)
        page = Path(td) / path.name
        page.write_text(probe, encoding="utf-8")
        dom = _dump(browser, page, Path(td), "", timeout)
        if dom is None:
            # Bisect: does it also freeze when nobody touches it?
            calm = _dump(browser, page, Path(td), "#noinput", timeout)
            if calm is None:
                rep.failures.append(f"the page freezes the browser right after loading (no result after {timeout}s): "
                                    "an endless loop in code that runs at start-up")
                return rep
            rep.failures.append("the page freezes as soon as it gets keyboard/mouse input (it runs fine untouched): "
                                "an endless loop or blocking code inside an input handler")
            dom = calm
    finally:
        shutil.rmtree(td, ignore_errors=True)
    m = re.search(r'<pre id="__kestrel_report"[^>]*>(.*?)</pre>', dom, re.S)
    if not m:
        rep.failures.append("the page never finished running in the browser (it froze, navigated away, or crashed); "
                            "look for an infinite loop or code that blocks")
        return rep
    import html as _h
    d = json.loads(_h.unescape(m.group(1)))
    rep.raw, rep.ran = d, True
    blamed = set()
    for c in d.get("controls") or []:
        if c.get("errors"):
            rep.failures.append(f"clicking the control \"{c['label']}\" throws: {c['first']}")
            blamed.add(c["first"])
    for e in d["errors"]:
        if e not in blamed:
            rep.failures.append(f"runtime error: {e}")
    snaps = {s["t"]: s for s in d["snaps"]}
    s0, s1, sk, sc, sl = (snaps.get(k, {}) for k in ("start", "idle", "after_keys", "after_click", "later"))
    animates = bool(s0 and s1 and (s1["s"] != s0["s"] or s1["draws"] > s0["draws"]))
    changed_after_input = bool(sk and s1 and sk["s"] != s1["s"]) or bool(sc and sk and sc["s"] != sk["s"])
    keys = d["listeners"].get("keydown", 0) + d["listeners"].get("keyup", 0) + d["listeners"].get("keypress", 0) + (1 if d["inlineKey"] else 0)
    rep.facts.append(f"ran in a real browser ({Path(browser).stem}) for ~6 s of page time")
    rep.facts.append(f"canvas: {d['canvases']}, buttons: {d['buttons']}, inputs: {d['inputs']}, visible text chars: {d['textLen']}")
    rep.facts.append(f"animation frames requested: {d['raf']}, setInterval: {d['intervals']}, setTimeout: {d['timers']}, canvas draw calls: {d['draws']}")
    rep.facts.append(f"keyboard listeners: {keys}, mouse/click listeners: {d['listeners'].get('click', 0) + d['listeners'].get('mousedown', 0)}")
    if d.get("controls"):
        okc = [c["label"] for c in d["controls"] if not c.get("errors")]
        rep.facts.append(f"pressed every control ({len(d['controls'])}): " + ", ".join(f'"{x}"' for x in okc[:12]) + (" worked without errors" if okc else ""))
    rep.facts.append(f"screen changes on its own: {'yes' if animates else 'no'}; screen changes after keys/clicks: {'yes' if changed_after_input else 'no'}")
    early = [a["m"] for a in d["alerts"] if a.get("t", 9) <= 1]
    if early:
        rep.warnings.append(f"alert/confirm shown before the user did anything: {early[:3]} (a game that ends instantly, or a debug alert)")
    elif d["alerts"]:
        rep.facts.append(f"dialogs shown during the run: {[a['m'] for a in d['alerts']][:4]}")
    if d["textLen"] == 0 and d["canvases"] == 0:
        rep.failures.append("the page shows nothing: no visible text and no canvas")
    if interactive:
        if keys == 0 and d["buttons"] == 0 and d["listeners"].get("click", 0) == 0 and d["inputs"] == 0:
            rep.failures.append("the page is meant to be interactive but registers no keyboard, click or input handlers")
        if d["canvases"] and d["draws"] == 0:
            rep.failures.append("there is a <canvas> but nothing is ever drawn on it")
        if not animates and not changed_after_input:
            rep.warnings.append("nothing on screen changed during the run, even after keys and clicks")
    seen, uniq = set(), []
    for f in rep.failures:  # the same error from every tick is one problem
        key = re.sub(r"kestrel_web_\w+", "", f)
        if key not in seen:
            seen.add(key)
            uniq.append(f)
    rep.failures = uniq
    rep.ok = not rep.failures
    return rep


def check_python(path: Path, run: bool, timeout: int = 15) -> Report:
    rep = Report("python")
    try:
        py_compile.compile(str(path), doraise=True)
    except py_compile.PyCompileError as e:
        rep.failures.append(f"syntax error: {e.msg.strip()}")
        return rep
    src = path.read_text(encoding="utf-8", errors="replace")
    interactive = bool(re.search(r"\binput\s*\(", src))
    gui = bool(re.search(r"^\s*(import|from)\s+(tkinter|pygame|turtle|PyQt\w*|PySide\w*|kivy|arcade)\b", src, re.M))
    if not run:
        rep.facts.append("compiled; not executed (no approval to run it)")
        rep.ok = True
        return rep
    with tempfile.TemporaryDirectory(prefix="kestrel_py_") as td:
        dst = Path(td) / path.name
        shutil.copy2(path, dst)
        env = dict(os.environ, PYTHONIOENCODING="utf-8", SDL_VIDEODRIVER="dummy", SDL_AUDIODRIVER="dummy", MPLBACKEND="Agg")
        try:
            r = subprocess.run([sys.executable, "-X", "utf8", dst.name], cwd=td, capture_output=True, env=env,
                               input=("\n".join(["1", "2", "3", "q", "quit", "exit"]) + "\n").encode() if interactive else b"",
                               timeout=timeout if not gui else 6)
            rep.ran = True
            out, err = r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")
            if r.returncode != 0:
                tb = err.strip().splitlines()
                rep.failures.append("crashed: " + "\n".join(tb[-8:]))
            rep.facts.append(f"exit code {r.returncode}; output: {out.strip()[:400]!r}")
        except subprocess.TimeoutExpired:
            rep.ran = True
            if gui:
                rep.facts.append(f"GUI program kept running for 6 s without crashing (normal for a window/game loop)")
            else:
                rep.warnings.append(f"still running after {timeout}s (waiting for input or an endless loop)")
    rep.ok = not rep.failures
    return rep


def check_node(path: Path, run: bool, timeout: int = 15) -> Report:
    rep = Report("javascript")
    node = find_node()
    if not node:
        rep.warnings.append("Node.js not found; not checked")
        rep.ok = True
        return rep
    src = path.read_text(encoding="utf-8", errors="replace")
    err = node_check(src, path.suffix == ".mjs" or bool(re.search(r"^\s*(import|export)\s", src, re.M)), node)
    if err:
        rep.failures.append(f"syntax error: {err}")
        return rep
    if run:
        with tempfile.TemporaryDirectory(prefix="kestrel_js_") as td:
            dst = Path(td) / path.name
            shutil.copy2(path, dst)
            try:
                r = subprocess.run([node, dst.name], cwd=td, capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL)
                rep.ran = True
                if r.returncode != 0:
                    rep.failures.append("crashed: " + "\n".join(r.stderr.decode("utf-8", "replace").strip().splitlines()[-8:]))
                rep.facts.append(f"exit code {r.returncode}; output: {r.stdout.decode('utf-8', 'replace').strip()[:400]!r}")
            except subprocess.TimeoutExpired:
                rep.ran = True
                rep.warnings.append(f"still running after {timeout}s (server or endless loop)")
    rep.ok = not rep.failures
    return rep


def check(path: Path, *, may_run: bool = False, interactive: bool = True, browser: str = "", tests: list | None = None) -> Report:
    ext = path.suffix.lower()
    if ext in (".html", ".htm"):
        rep = check_web(path, browser, interactive)  # sandboxed browser page: no approval needed
        if rep.ran and tests and not any("freezes" in f for f in rep.failures):
            rep.tests = run_tests(path, tests, browser)
        return rep
    if ext == ".py":
        return check_python(path, may_run)
    if ext in (".js", ".mjs", ".cjs"):
        return check_node(path, may_run)
    from . import verify
    rep = Report(ext.lstrip(".") or "file")
    issue = verify.check_file(path)
    if issue:
        rep.failures.append(issue)
    rep.ok = not rep.failures
    rep.facts.append("parsed with the format's own validator" if not issue else "")
    return rep
