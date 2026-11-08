import os
A="#2F5BEA"
DARK=dict(t1="#545C6C",t2="#8C93A1",back="#C3C8D1",head="#ECEDEF",beak="#8C93A1",breast="#C3C8D1",belly="#ECEDEF",eye="#101217",legs="#8C93A1",base="#545C6C",
          bf="#8C93A1",bt="#C3C8D1",bs="#545C6C",rough="#C3C8D1",rbase="#545C6C",shead="#ECEDEF",sbelly="#C3C8D1",stail="#545C6C",chip="#C3C8D1")
LIGHT=dict(t1="#16181D",t2="#3A404C",back="#6A7383",head="#A9B0BC",beak="#3A404C",breast="#6A7383",belly="#A9B0BC",eye="#16181D",legs="#3A404C",base="#16181D",
          bf="#6A7383",bt="#A9B0BC",bs="#3A404C",rough="#6A7383",rbase="#16181D",shead="#A9B0BC",sbelly="#6A7383",stail="#16181D",chip="#6A7383")
def final(c,detail=True):
    s=f'''<polygon points="12,52 30,50 34,58" fill="{c['t1']}"/><polygon points="12,52 34,58 40,62 28,62" fill="{c['t2']}"/><polygon points="30,50 56,32 60,44 44,52" fill="{c['back']}"/><polygon points="34,58 30,50 44,52 60,44 56,58 40,62" fill="var(--whittle-accent,{A})"/><polygon points="56,32 64,24 72,26 76,32 70,42 60,44" fill="{c['head']}"/><polygon points="76,32 86,36 74,39" fill="{c['beak']}"/><polygon points="60,44 70,42 68,56 56,58" fill="{c['breast']}"/><polygon points="40,62 56,58 68,56 60,68 46,70" fill="{c['belly']}"/>'''
    if detail: s+=f'''<circle cx="69" cy="31" r="1.8" fill="{c['eye']}"/><path d="M50 70 L48 76 M56 68 L56 76" stroke="{c['legs']}" stroke-width="2" stroke-linecap="round"/>'''
    return s+f'<polygon points="34,76 70,76 66,82 38,82" fill="{c["base"]}"/>'
def block(c): return f'<polygon points="14,26 80,26 80,84 14,84" fill="{c["bf"]}"/><polygon points="14,26 22,18 88,18 80,26" fill="{c["bt"]}"/><polygon points="80,26 88,18 88,76 80,84" fill="{c["bs"]}"/>'
def rough(c): return f'<polygon points="14,54 54,30 70,24 84,36 64,46 58,70 36,70" fill="{c["rough"]}"/><polygon points="34,74 70,74 70,82 34,82" fill="{c["rbase"]}"/>'
def shaped(c): return f'<polygon points="54,30 70,24 84,36 66,44" fill="{c["shead"]}"/><polygon points="14,54 54,30 66,44 40,54" fill="var(--whittle-accent,{A})"/><polygon points="40,54 66,44 58,70 36,70" fill="{c["sbelly"]}"/><polygon points="14,54 40,54 36,70" fill="{c["stail"]}"/><polygon points="34,74 70,74 68,82 36,82" fill="{c["rbase"]}"/>'
def chips_kf(name,dx,dy,r):
    p=lambda t,o,x,y,rr:f"{t}{{opacity:{o};transform:translate({x}px,{y}px) rotate({rr}deg)}}"
    z=lambda t:p(t,0,0,0,0)
    parts=[z("0%,13.9%")]
    for s,e,n in [(14.5,23,29.9),(30.5,39,45.9),(46.5,55,100)]:
        parts+= [p(f"{s}%",1,0,0,0), p(f"{e}%",0,dx,dy,r), z(f"{e+0.1:.1f}%,{n}%")]
    return f"@keyframes {name}{{{''.join(parts)}}}"
CSS=f"""
.b0,.b1,.b2,.bin{{opacity:0}}.b3{{opacity:1}}
.b0{{animation:b0 4.4s cubic-bezier(.65,0,.35,1) infinite}}.b1{{animation:b1 4.4s cubic-bezier(.65,0,.35,1) infinite}}.b2{{animation:b2 4.4s cubic-bezier(.65,0,.35,1) infinite}}.b3{{animation:b3 4.4s cubic-bezier(.65,0,.35,1) infinite}}.bin{{animation:bin 4.4s cubic-bezier(.65,0,.35,1) infinite}}
@keyframes b0{{0%,13%{{opacity:1}}16%,99.9%{{opacity:0}}100%{{opacity:1}}}}
@keyframes b1{{0%,13%{{opacity:0}}16%,29%{{opacity:1}}32%,100%{{opacity:0}}}}
@keyframes b2{{0%,29%{{opacity:0}}32%,45%{{opacity:1}}48%,100%{{opacity:0}}}}
@keyframes b3{{0%,45%{{opacity:0;transform:translateX(0)}}48%,72%{{opacity:1;transform:translateX(0)}}92%,100%{{opacity:0;transform:translateX(-30px)}}}}
@keyframes bin{{0%,72%{{opacity:0;transform:translateX(30px)}}92%,100%{{opacity:1;transform:translateX(0)}}}}
.chip{{opacity:0;transform-box:fill-box;transform-origin:50% 50%}}.c1{{animation:c1 4.4s linear infinite}}.c2{{animation:c2 4.4s linear infinite}}.c3{{animation:c3 4.4s linear infinite}}
{chips_kf('c1',10,-14,160)}
{chips_kf('c2',-12,-10,-140)}
{chips_kf('c3',12,10,200)}
@media (prefers-reduced-motion:reduce){{.b0,.b1,.b2,.bin{{animation:none;opacity:0}}.b3{{animation:none;opacity:1;transform:none}}.chip{{animation:none;opacity:0}}}}
"""
def loader(c,label):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="{label}"><style>{CSS}</style>
<g class="b0">{block(c)}</g><g class="b1">{rough(c)}</g><g class="b2">{shaped(c)}</g><g class="b3">{final(c)}</g><g class="bin">{block(c)}</g>
<polygon class="chip c1" points="58,32 62,31 60,35" fill="var(--whittle-accent,{A})"/><polygon class="chip c2" points="38,56 41,54 41,58" fill="{c['chip']}"/><polygon class="chip c3" points="64,62 68,61 66,65" fill="{c['chip']}"/></svg>
'''
def mark(c): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="Whittle">{final(c)}</svg>\n'
FAV=f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>Whittle</title><style>.i{{fill:#3A404C}}.b{{fill:#16181D}}@media (prefers-color-scheme:dark){{.i{{fill:#C3C8D1}}.b{{fill:#8C93A1}}}}</style><polygon class="i" points="12,52 56,30 66,24 76,30 88,36 72,42 66,64 44,70 28,62"/><polygon points="30,50 60,42 56,58 40,62" fill="{A}"/><polygon class="b" points="32,74 72,74 68,84 36,84"/></svg>\n'
def icon(size_pad, bg, c, rounded):
    # full-bleed square icon for PNG export; mark scaled by pad
    s=1-2*size_pad; o=size_pad*100
    rx='22' if rounded else '0'
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>Whittle</title><rect width="100" height="100" rx="{rx}" fill="{bg}"/><g transform="translate({o} {o-2}) scale({s})">{final(c)}</g></svg>'
os.makedirs("svg",exist_ok=True)
open("svg/whittle-loader-dark.svg","w").write(loader(DARK,"Loading"))
open("svg/whittle-loader-light.svg","w").write(loader(LIGHT,"Loading"))
open("svg/whittle-mark-dark.svg","w").write(mark(DARK))
open("svg/whittle-mark-light.svg","w").write(mark(LIGHT))
open("svg/favicon.svg","w").write(FAV)
open("svg/app-icon.svg","w").write(icon(.1,"#101217",DARK,False))
open("svg/app-icon-maskable.svg","w").write(icon(.2,"#101217",DARK,False))
