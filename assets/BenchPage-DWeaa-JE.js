import{a as e,n as t,t as n}from"./jsx-runtime-B-hcVAMW.js";import{A as r,M as i}from"./index-CFcqlt0x.js";var a=e(t(),1),o=n(),s=`import json, time
from sltp.data import market_data_service as service

# 1. What this device is working with. Two phones with different universes are
#    not running the same backtest, whatever the code says.
t = time.perf_counter()
universe = service.get_all_tickers()
print("universe:", len(universe), "in", round(time.perf_counter() - t, 2), "s")

# 2. Pure interpreter speed, no data and no numpy: the baseline the engine
#    numbers should be read against.
t = time.perf_counter()
s = 0.0
for i in range(3_000_000):
    s += i * 0.5
print("cpu probe 3e6:", round(time.perf_counter() - t, 3), "s")

# 3. One real run, with the worker's own timings beside the wall clock.
t = time.perf_counter()
out = json.loads(run_strategy("adaptive-momentum", "2022-01-01", None))
print("adaptive-momentum wall:", round(time.perf_counter() - t, 2), "s")
print("timings:", out.get("timings"))
print("sessions:", len(out.get("equity") or []), "trades:", len(out.get("trades") or []))
out = None
`;function c(){let e=i(),[t,n]=(0,a.useState)(s),[c,l]=(0,a.useState)(``),[u,d]=(0,a.useState)(!1),f=(0,a.useRef)(0),p=(0,a.useCallback)(async()=>{if(!u){d(!0),l(e.phase===`ready`?`Running…`:`Booting Python, then running…`),f.current=performance.now();try{let e=await r(t),n=((performance.now()-f.current)/1e3).toFixed(2),i=e;try{let t=JSON.parse(e);i=[t.stdout??``,t.error??``].filter(Boolean).join(`
`),!t.ok&&!t.stdout&&(i=t.error??`failed`)}catch{}l(`${i}\n\n[worker round trip ${n}s]`)}catch(e){l(e instanceof Error?e.message:String(e))}finally{d(!1)}}},[t,u,e.phase]);return(0,o.jsxs)(`div`,{style:{padding:`1.25rem`,maxWidth:`56rem`,margin:`0 auto`},children:[(0,o.jsx)(`h1`,{style:{fontSize:`1.25rem`,margin:`0 0 0.25rem`},children:`Bench`}),(0,o.jsxs)(`p`,{style:{color:`var(--text-secondary)`,margin:`0 0 1rem`,fontSize:`0.9375rem`},children:[`Python against the cached market data. Engine: `,e.phase,e.detail?` — ${e.detail}`:``]}),(0,o.jsx)(`textarea`,{value:t,onChange:e=>n(e.target.value),onKeyDown:e=>{(e.metaKey||e.ctrlKey)&&e.key===`Enter`&&(e.preventDefault(),p())},spellCheck:!1,rows:18,style:{width:`100%`,boxSizing:`border-box`,padding:`0.75rem`,fontFamily:`var(--font-mono)`,fontSize:`0.8125rem`,lineHeight:1.5,color:`var(--text-strong)`,background:`var(--bg-surface)`,border:`1px solid var(--border-subtle)`,borderRadius:`0.5rem`,resize:`vertical`}}),(0,o.jsxs)(`div`,{style:{display:`flex`,gap:`0.5rem`,margin:`0.75rem 0 1rem`},children:[(0,o.jsx)(`button`,{type:`button`,className:`btn btn-primary btn-sm`,onClick:()=>void p(),disabled:u,children:u?`Running…`:`Run  (⌘⏎)`}),(0,o.jsx)(`button`,{type:`button`,className:`btn btn-secondary btn-sm`,onClick:()=>l(``),children:`Clear output`})]}),(0,o.jsx)(`pre`,{style:{margin:0,padding:`0.75rem`,minHeight:`4rem`,fontFamily:`var(--font-mono)`,fontSize:`0.8125rem`,lineHeight:1.5,color:`var(--text-strong)`,background:`var(--bg-canvas)`,border:`1px solid var(--border-subtle)`,borderRadius:`0.5rem`,whiteSpace:`pre-wrap`,wordBreak:`break-word`},children:c})]})}export{c as BenchPage,c as default};