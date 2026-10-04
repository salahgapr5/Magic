/* ============================================================================
   motion-templates.js  —  Overlay Studio (25 templates)
   Replaces the old 65-template registry. Source design: overlay_studio_25_templates_final_positions.html

   HOW IT WORKS
   - Each template is a small SPEC function: it receives the card content (m) and returns
     an anchor position, padding, colors, an entrance animation and a list of content BLOCKS
     (eyebrow, headline, body, line, steps...). ONE generic renderer draws every spec, so
     preview, library thumbnails and the exported PNG frames always match.
   - To change a template's look or position, edit its spec in SPECS below.
   - Public API is unchanged (window.MotionTemplates) so editor.html / ffmpeg-render.js keep working.
============================================================================ */
(function(){
'use strict';

const C = { avocado:'#b7e86a', cyan:'#62ead6', white:'#f8fbff', muted:'#9eabb5', soft:'#aebbc2',
            amber:'#ffbe50', mythRed:'#ff8a72', dark:'#071014' };
const MT_COLOR = { white:C.white, muted:C.muted, cyan:C.cyan, blue:'#6bb8ff', green:'#74e29a', red:'#ff6b78',
                   gold:'#ffd36b', purple:'#b9a0ff', orange:'#ff6b78', avocado:C.avocado, bg:'#05070a' };
const FONT = 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif';
const MT_EXIT_MS = 300, MT_DEFAULT_ENTER_MS = 750;

// ---------- small helpers ----------
const clamp01 = x => Math.max(0, Math.min(1, x));
const F = (min, vw, max) => Math.max(min, Math.min(max, vw * 12.8));   // css clamp(min, vw, max) at a 1280px canvas
const S = (v, d) => (v != null && String(v).trim() ? String(v).trim() : d);
function bezier(x1,y1,x2,y2){
  const A=(a,b)=>1-3*b+3*a, B=(a,b)=>3*b-6*a, Cc=a=>3*a;
  const bx=t=>((A(x1,x2)*t+B(x1,x2))*t+Cc(x1))*t, by=t=>((A(y1,y2)*t+B(y1,y2))*t+Cc(y1))*t;
  const dx=t=>3*A(x1,x2)*t*t+2*B(x1,x2)*t+Cc(x1);
  return x=>{ if(x<=0)return 0; if(x>=1)return 1; let t=x;
    for(let i=0;i<6;i++){ const d=dx(t); if(Math.abs(d)<1e-6)break; t=clamp01(t-(bx(t)-x)/d); } return by(t); };
}
const ease = bezier(.2,.8,.2,1);
const sub = (p,a,b) => clamp01((p-a)/(b-a));
function setLS(ctx,px){ if('letterSpacing' in ctx) ctx.letterSpacing = px+'px'; }
function rrPath(ctx,x,y,w,h,r){
  const R = Array.isArray(r) ? r : [r,r,r,r];
  const m = Math.min(w,h)/2, [a,b,c,d] = R.map(v=>Math.min(v,m));
  ctx.beginPath(); ctx.moveTo(x+a,y); ctx.lineTo(x+w-b,y); ctx.arcTo(x+w,y,x+w,y+b,b);
  ctx.lineTo(x+w,y+h-c); ctx.arcTo(x+w,y+h,x+w-c,y+h,c); ctx.lineTo(x+d,y+h); ctx.arcTo(x,y+h,x,y+h-d,d);
  ctx.lineTo(x,y+a); ctx.arcTo(x,y,x+a,y,a); ctx.closePath();
}

// ---------- text block (wraps, supports one highlighted phrase, ellipsis on overflow) ----------
function words(text,color){ return String(text).split(/\s+/).filter(Boolean).map(t=>({t,c:color})); }
function tokens(text,hl,color,hlColor){
  if(!hl) return words(text,color);
  const i = text.toLowerCase().indexOf(String(hl).toLowerCase());
  if(i<0) return words(text,color);
  return [...words(text.slice(0,i),color), ...words(text.slice(i,i+hl.length),hlColor), ...words(text.slice(i+hl.length),color)];
}
function T(text, o){
  text = String(text==null ? '' : text).trim(); if(!text) return null;
  o = Object.assign({size:14,weight:700,color:C.white,lh:1.15,ls:0,lsEm:0,max:99,align:'left',italic:false,hl:null,hlColor:C.avocado}, o||{});
  let cache=null;
  const font=(ctx,u,s)=>{ s=s||1; ctx.font=`${o.italic?'italic ':''}${Math.min(900,o.weight)} ${o.size*u*s}px ${FONT}`; setLS(ctx,(o.ls+o.lsEm*o.size)*u*s); };
  function layAt(ctx,u,w,fs){
    font(ctx,u,fs);
    const space=ctx.measureText(' ').width; let lines=[],cur=[],cw=0;
    tokens(text,o.hl,o.color,o.hlColor).forEach(k=>{
      k.w=ctx.measureText(k.t).width; const add=(cur.length?space:0)+k.w;
      if(cur.length && cw+add>w){ lines.push({r:cur,w:cw}); cur=[k]; cw=k.w; } else { cur.push(k); cw+=add; }
    });
    if(cur.length) lines.push({r:cur,w:cw});
    return {lines,space,fs};
  }
  // Auto-fit: shrink the font (down to ~62%) before cutting anything; "..." is the last resort.
  function lay(ctx,u,w){
    let fs=1, R=layAt(ctx,u,w,fs);
    while(R.lines.length>o.max && fs>0.62){ fs=Math.max(0.62,fs-0.06); R=layAt(ctx,u,w,fs); }
    let {lines,space}=R;
    if(lines.length>o.max){
      lines=lines.slice(0,o.max); const ln=lines[lines.length-1];
      let k=ln.r[ln.r.length-1]; k={t:k.t+'\u2026',c:k.c}; k.w=ctx.measureText(k.t).width; ln.r[ln.r.length-1]=k;
      ln.w=ln.r.reduce((s,q)=>s+q.w,0)+space*(ln.r.length-1);
    }
    return {lines,space,fs};
  }
  return {
    h(ctx,u,w){ cache=lay(ctx,u,w); return cache.lines.length*o.size*o.lh*u*cache.fs; },
    nat(ctx,u){ font(ctx,u); return ctx.measureText(text).width; },
    d(ctx,u,x,y,w){
      const L=cache||lay(ctx,u,w); font(ctx,u,L.fs); ctx.textBaseline='top'; ctx.textAlign='left';
      const sz=o.size*L.fs;
      L.lines.forEach((ln,i)=>{
        let sx = o.align==='center' ? x+(w-ln.w)/2 : o.align==='right' ? x+w-ln.w : x;
        const ty = y + i*sz*o.lh*u + (sz*o.lh*u - sz*u)/2;
        ln.r.forEach(k=>{ ctx.fillStyle=k.c; ctx.fillText(k.t,sx,ty); sx+=k.w+L.space; });
      });
    }
  };
}
// presets that mirror the original CSS classes
const ey   = (t,c,o)=>T(String(t||'').toUpperCase(), Object.assign({size:12,weight:900,color:c||C.cyan,ls:2,lh:1.25,max:1},o));
const h1   = (t,o)=>T(t, Object.assign({size:F(22,3,42),weight:900,lh:.98,lsEm:-.05,max:3},o));
const h2   = (t,o)=>T(t, Object.assign({size:F(15,2,25),weight:900,lh:1.08,lsEm:-.03,max:4},o));
const body = (t,o)=>T(t, Object.assign({size:14,weight:500,color:C.soft,lh:1.5,max:4},o));

// ---------- other blocks ----------
const gap = px => ({ h:(c,u)=>px*u, d(){} });
function line(maxW){ return { h:(c,u)=>3*u, d(ctx,u,x,y,w){
  let lw=maxW?Math.min(w,maxW*u):w, lx=x+(w-lw)/2; if(!maxW){lx=x;lw=w;}
  const g=ctx.createLinearGradient(lx,0,lx+lw,0); g.addColorStop(0,'rgba(183,232,106,0)'); g.addColorStop(.5,C.avocado); g.addColorStop(1,'rgba(183,232,106,0)');
  ctx.fillStyle=g; ctx.fillRect(lx,y,lw,3*u); } }; }
function pad(child,p){ if(!child) return null; return {
  nat:(c,u)=>(child.nat?child.nat(c,u):0)+(p[1]+p[3])*u,
  h:(c,u,w)=>child.h(c,u,w-(p[1]+p[3])*u)+(p[0]+p[2])*u,
  d:(c,u,x,y,w,pr)=>child.d(c,u,x+p[3]*u,y+p[0]*u,w-(p[1]+p[3])*u,pr) }; }
function stack(list){ list=list.filter(Boolean); return {
  nat:(c,u)=>Math.max(0,...list.map(b=>b.nat?b.nat(c,u):0)),
  h:(c,u,w)=>list.reduce((s,b)=>s+b.h(c,u,w),0),
  d:(c,u,x,y,w,p)=>{ let yy=y; list.forEach(b=>{ b.d(c,u,x,yy,w,p); yy+=b.h(c,u,w); }); } }; }
function tag(text){ return { h:(c,u)=>24*u, d(ctx,u,x,y){
  ctx.font=`900 ${11*u}px ${FONT}`; setLS(ctx,1*u); const tw=ctx.measureText(String(text)).width+16*u;
  rrPath(ctx,x,y,tw,24*u,12*u); ctx.fillStyle='rgba(98,234,214,.06)'; ctx.fill(); ctx.strokeStyle='rgba(98,234,214,.2)'; ctx.lineWidth=u; ctx.stroke();
  ctx.fillStyle=C.cyan; ctx.textBaseline='middle'; ctx.textAlign='left'; ctx.fillText(String(text),x+8*u,y+12.5*u); }, tagW:(ctx,u,t)=>0 }; }
function tagRule(text){ const tg=tag(text); return { h:tg.h, d(ctx,u,x,y,w){ tg.d(ctx,u,x,y);
  ctx.font=`900 ${11*u}px ${FONT}`; setLS(ctx,1*u); const tw=ctx.measureText(String(text)).width+16*u;
  const g=ctx.createLinearGradient(x+tw+10*u,0,x+w,0); g.addColorStop(0,C.avocado); g.addColorStop(1,'rgba(183,232,106,0)');
  ctx.fillStyle=g; ctx.fillRect(x+tw+10*u,y+12*u,w-tw-10*u,u); } }; }
function badgeCircle(size,fill,txt,txtColor,ring){ return (ctx,u,x,y)=>{
  const r=size*u/2; ctx.beginPath(); ctx.arc(x+r,y+r,r,0,Math.PI*2); ctx.fillStyle=fill; ctx.fill();
  if(ring){ ctx.strokeStyle=ring; ctx.lineWidth=u; ctx.stroke(); }
  ctx.font=`900 ${size*.42*u}px ${FONT}`; setLS(ctx,0); ctx.fillStyle=txtColor; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(txt,x+r,y+r+u*.5); ctx.textAlign='left'; }; }
function numChip(size,txt){ return { h:(c,u)=>size*u, d:(ctx,u,x,y)=>badgeCircle(size,'rgba(98,234,214,.11)',txt,C.cyan,'rgba(98,234,214,.33)')(ctx,u,x,y) }; }
function iconRow(size,gp,iconFn,child){ return {
  h:(c,u,w)=>Math.max(size*u,child.h(c,u,w-(size+gp)*u)),
  d:(c,u,x,y,w,p)=>{ const rh=Math.max(size*u,child.h(c,u,w-(size+gp)*u)); iconFn(c,u,x,y+(rh-size*u)/2);
    child.d(c,u,x+(size+gp)*u,y+(rh-child.h(c,u,w-(size+gp)*u))/2,w-(size+gp)*u,p); } }; }
function stepRow(numTxt,title,txt,o){ o=o||{}; const cs=25;
  const mk=(c,u,w)=>stack([title?T(title,{size:15,weight:800}):null, txt?T(txt,{size:o.tsize||13,weight:500,color:C.soft,lh:1.4,max:2}):null]);
  return { stag:o.stag,
    h:(c,u,w)=>Math.max(cs*u,mk(c,u,w-(cs+10)*u).h(c,u,w-(cs+10)*u))+17*u,
    d:(ctx,u,x,y,w,p)=>{ const tw=w-(cs+10)*u, st=mk(ctx,u,tw), th=st.h(ctx,u,tw), rh=Math.max(cs*u,th);
      badgeCircle(cs,'rgba(98,234,214,.11)',numTxt,C.cyan,'rgba(98,234,214,.33)')(ctx,u,x,y+8*u+(rh-cs*u)/2);
      st.d(ctx,u,x+(cs+10)*u,y+8*u+(rh-th)/2,tw,p);
      ctx.fillStyle='rgba(255,255,255,.07)'; ctx.fillRect(x,y+rh+16*u,w,u); } }; }
function layer(n,txt,stag){ return { stag,
  h:(c,u,w)=>T(txt,{size:15,weight:700,max:2}).h(c,u,w-32*u-36*u)+26*u-3*u,
  d:(ctx,u,x,y,w)=>{ const t=T(txt,{size:15,weight:700,max:2}), th=t.h(ctx,u,w-68*u), bh=th+26*u;
    rrPath(ctx,x,y,w,bh,12*u); ctx.fillStyle='rgba(9,14,17,.91)'; ctx.fill(); ctx.strokeStyle='rgba(255,255,255,.13)'; ctx.lineWidth=u; ctx.stroke();
    const tg=tag(n); tg.d(ctx,u,x+16*u,y+(bh-24*u)/2); t.d(ctx,u,x+16*u+40*u,y+13*u,w-68*u); } }; }
function cols(a,b,gp,cell){ return {
  h:(c,u,w)=>{ const cw=(w-gp*u)/2-2*cell*u; return Math.max(stack(a).h(c,u,cw),stack(b).h(c,u,cw))+2*cell*u; },
  d:(c,u,x,y,w,p)=>{ const cw=(w-gp*u)/2; stack(a).d(c,u,x+cell*u,y+cell*u,cw-2*cell*u,p); stack(b).d(c,u,x+cw+gp*u+cell*u,y+cell*u,cw-2*cell*u,p);
    c.fillStyle='rgba(255,255,255,.07)'; c.fillRect(x+cw+gp*u/2,y+cell*u,u,Math.max(stack(a).h(c,u,cw-2*cell*u),stack(b).h(c,u,cw-2*cell*u))); } }; }
function progressBlock(pct){ return { h:(c,u)=>8*u, d:(ctx,u,x,y,w,p)=>{
  rrPath(ctx,x,y,w,8*u,4*u); ctx.fillStyle='rgba(255,255,255,.07)'; ctx.fill();
  const fw=w*pct/100*ease(sub(p,.15,1)); if(fw>1){ const g=ctx.createLinearGradient(x,0,x+w*pct/100,0); g.addColorStop(0,C.cyan); g.addColorStop(1,'#a2fff5');
    rrPath(ctx,x,y,fw,8*u,4*u); ctx.fillStyle=g; ctx.fill(); } } }; }
function splitHead(left,rightTxt){ return {
  h:(c,u,w)=>left.h(c,u,w-90*u),
  d:(c,u,x,y,w,p)=>{ left.d(c,u,x,y,w-90*u,p); const t=T(rightTxt,{size:20,weight:900,color:C.avocado,align:'right',max:1}); t.h(c,u,80*u); t.d(c,u,x+w-80*u,y,80*u); } }; }

// ---------- anchors (fractions of the frame; same values as the CSS avatar-safe classes) ----------
const A = {
  bottom:     {l:.03,r:.03,b:.06},
  safeBottom: {l:.04,r:.04,b:.05},
  safeRight:  {r:.04,t:.18,w:.34},
  safeLeft:   {l:.04,t:.18,w:.34},
  topLeft:    {l:.04,t:.05,w:.36},
  topRight:   {r:.04,t:.05,w:.36},
  botRight:   {r:.04,b:.07,w:.39},
};
const CARD = { bg:'rgba(0,0,0,.73)', border:'rgba(255,255,255,.14)', r:15 };
const list = m => (m.items||[]).map(s=>String(s).trim()).filter(Boolean).slice(0,4);
const splitItem = s => { const p=String(s).split(/\s*(?::|\u2014|\u2013| - )\s*/); return p.length>1?[p[0],p.slice(1).join(' ')]:[s,null]; };
const numText = m => S(m.number, m.step!=null ? String(m.step).padStart(2,'0') : null);

// ---------- THE 25 SPECS ----------
const SPECS = {
  bottom:(m)=>({ a:A.bottom, pad:[16,19,16,19], ...CARD, glow:true, anim:'float',
    blocks:[ey(S(m.kicker,'KEY INFORMATION')), h1(m.headline,{hl:m.highlight}), m.support?gap(7):null, body(m.support), gap(12), line()] }),
  side:(m)=>({ a:A.safeRight, pad:[20,20,20,20], ...CARD, anim:'reveal',
    blocks:[ey(S(m.kicker,'KEY POINT')), h1(m.headline,{hl:m.highlight}), m.support?gap(7):null, body(m.support), gap(13), line()] }),
  fact:(m)=>({ a:A.safeLeft, pad:[18,18,18,18], ...CARD, anim:'float',
    blocks:[tag(S(m.kicker,'FACT').toUpperCase()), gap(9), h2(m.headline,{hl:m.highlight}), m.support?gap(6):null, body(m.support,{size:13}), gap(12), line()] }),
  callout:(m)=>({ a:{l:.04,t:.05,w:W=>Math.min(.42*W,430)}, pad:[18,20,18,20], ...CARD, glow:true, anim:'question',
    blocks:[tagRule(S(m.kicker,'KEY POINT').toUpperCase()), gap(11), h2(m.headline,{hl:m.highlight}), m.support?gap(8):null, body(m.support,{size:13}), gap(13), line()] }),
  number:(m)=>({ a:A.topLeft, pad:[16,16,16,16], ...CARD, anim:'float',
    blocks:[numChip(48,numText(m)||'01'), gap(8), h2(m.headline,{hl:m.highlight}), m.support?gap(5):null, body(m.support,{size:13})] }),
  light:(m)=>({ a:A.safeBottom, pad:[18,18,18,18], bg:'#f4fafb', r:15, anim:'caption',
    blocks:[ey(S(m.kicker,'EXPLAINER'),'#1f9e8e'), h1(m.headline,{color:C.dark,hl:m.highlight,hlColor:'#1f9e8e'}), m.support?gap(7):null, body(m.support,{color:'#3b4d55'})] }),
  emphasis:(m)=>({ a:A.topRight, pad:[20,20,20,20], ...CARD, anim:'reveal',
    blocks:[ey(S(m.kicker,'THE CHANGE')), gap(6),
      T(m.before&&m.after ? `${m.before} \u2192 ${m.after}`.toUpperCase() : m.headline,
        {size:F(25,4,46),weight:900,lh:1.05,lsEm:-.03,max:3,hl:m.before&&m.after?String(m.after).toUpperCase():m.highlight}),
      m.support?gap(8):null, body(m.support), gap(13), line()] }),
  checklist:(m)=>({ a:A.safeLeft, pad:[18,18,18,18], ...CARD, anim:'reveal',
    blocks:[ey(S(m.kicker,'CHECKLIST')), h1(m.headline), gap(6),
      ...(list(m).length?list(m):(m.support?[m.support]:[])).map((it,i)=>stepRow('\u2713',null,it,{tsize:14,stag:i}))] }),
  stack:(m)=>({ a:{l:.05,t:.05,w:.36}, pad:[0,0,0,0], anim:'float',
    blocks:(list(m).length?list(m):[m.headline,m.support].filter(Boolean)).map((it,i)=>layer(String(i+1).padStart(2,'0'),it,i)) }),
  doctor:(m)=>({ a:{l:.04,b:.07,shrink:true}, pad:[13,18,13,18], ...CARD, r:15, bl:[3,C.cyan], anim:'reveal',
    blocks:[ey(S(m.kicker,'SPEAKER')), h1(m.headline,{max:2}), m.support?gap(7):null, body(m.support,{size:13}), gap(10), line()] }),
  clinic:(m)=>({ a:{}, full:true, pad:[0,60,0,60], anim:'zoom', bg:'clinic',
    blocks:[ey(S(m.kicker,'WELCOME TO'),null,{align:'center'}), gap(7),
      h1(m.headline,{size:F(42,7,85),align:'center',hl:m.highlight}), m.support?gap(7):null, body(m.support,{align:'center'}), gap(17), line(220)] }),
  chapter:(m)=>({ a:{r:.04,t:.09,shrink:true}, pad:[9,15,9,15], ...CARD, br:[3,C.cyan], anim:'reveal',
    blocks:[ey(S(m.kicker,'CHAPTER'),null,{align:'right'}), h1(m.headline,{align:'right',max:2}), gap(9), line()] }),
  stat:(m)=>({ a:A.topLeft, pad:[18,18,18,18], ...CARD, anim:'float',
    blocks:[ey(S(m.kicker,'KEY STATISTIC')), T(S(m.number,m.headline),{size:F(40,6.5,84),weight:900,lh:.95,lsEm:-.06,max:2}),
      m.number&&m.headline?gap(6):null, m.number?h2(m.headline,{size:F(14,1.8,22)}):null, m.support?gap(7):null, body(m.support,{size:13}), gap(12), line()] }),
  quoteStrip:(m)=>({ a:A.safeBottom, pad:[14,18,14,18], ...CARD, r:15, bl:[4,C.avocado], anim:'quote',
    blocks:[ey(S(m.kicker,'EXPERT QUOTE')), gap(5), h2(`\u201C${m.headline}\u201D`,{size:F(14,1.8,23),max:3}), m.support?gap(4):null, body(m.support?'\u2014 '+m.support:null,{size:13})] }),
  full:(m)=>({ a:A.topRight, pad:[20,20,20,20], ...CARD, anim:'reveal',
    blocks:[ey(S(m.kicker,'ONE MORE THING')), gap(8), h2(m.headline,{size:F(25,4,44),hl:m.highlight}), m.support?gap(7):null, body(m.support)] }),
  numBurst:(m)=>({ a:A.topLeft, pad:[15,15,15,15], ...CARD, glow:true, anim:'float',
    blocks:[ey(S(m.kicker,'STEP')), T(S(numText(m),'02'),{size:F(48,6,78),weight:900,color:C.avocado,lh:.9,lsEm:-.05,max:1}), gap(7), h2(m.headline,{hl:m.highlight}), m.support?gap(5):null, body(m.support,{size:13})] }),
  steps:(m)=>({ a:A.safeLeft, pad:[18,18,18,18], ...CARD, anim:'reveal',
    blocks:[ey(S(m.kicker,'HOW IT WORKS')), h1(m.headline), gap(6),
      ...(list(m).length?list(m):[]).map((it,i)=>{ const [a,b]=splitItem(it); return stepRow(String(i+1),b?a:it,b,{stag:i}); })] }),
  progress:(m)=>{ const raw=parseFloat(String(S(m.number,S(m.valueA,'')))) ; const pct=Math.max(0,Math.min(100,isFinite(raw)?raw:72));
    return { a:A.safeBottom, pad:[16,16,16,16], ...CARD, anim:'float',
      blocks:[splitHead(stack([ey(S(m.kicker,'PROGRESS')), h1(m.headline,{max:2})]), S(m.number,S(m.valueA,pct+'%'))), m.support?gap(6):null, body(m.support,{size:13}), gap(10), progressBlock(pct)] }; },
  myth:(m)=>({ a:{cx:true,b:.16,w:W=>Math.min(.78*W,760)}, pad:[10,10,10,10], ...CARD, anim:'reveal',
    blocks:[cols([ey('MYTH',C.mythRed),gap(8),h2(S(m.myth,S(m.before,m.headline)))],
                 [ey('FACT',C.avocado),gap(8),h2(S(m.fact,S(m.after,S(m.support,''))))],12,20)] }),
  result:(m)=>({ a:A.topRight, pad:[16,16,16,16], ...CARD, glow:true, anim:'float',
    blocks:[ey(S(m.kicker,'RESULT'),null,{align:'right'}), T(S(m.number,m.headline),{size:F(38,5,64),weight:900,color:C.avocado,lh:.95,lsEm:-.05,align:'right',max:2}),
      m.support||m.number?gap(6):null, body(S(m.support,m.number?m.headline:null),{align:'right'})] }),
  caption:(m)=>({ a:{l:.03,r:.03,b:.04}, pad:[0,0,2,0], bg:'rgba(3,7,9,.92)', border:'rgba(183,232,106,.25)', r:10, anim:'caption',
    blocks:[pad(T(m.headline,{size:F(12,1.6,20),weight:800,lh:1.25,max:2,hl:m.highlight}),[11,16,9,16]), line()] }),
  warning:(m)=>({ a:{l:.05,r:.05,b:.05}, pad:[11,15,11,15], bg:'rgba(22,15,7,.94)', border:'rgba(255,190,80,.55)', r:12, anim:'float',
    blocks:[iconRow(31,12,badgeCircle(31,C.amber,'!','#171006'), stack([T(S(m.kicker,'WARNING').toUpperCase(),{size:11,weight:900,color:C.amber,ls:2,max:1}),
      T(m.headline,{size:F(12,1.6,19),weight:800,lh:1.2,max:2})]))] }),
  quoteCaption:(m)=>({ a:{l:.06,r:.06,b:.05}, pad:[12,17,12,17], bg:'rgba(4,8,10,.9)', r:[0,11,11,0], bl:[4,C.avocado], anim:'quote',
    blocks:[T(`\u201C${m.headline}\u201D`,{size:F(12,1.6,19),weight:800,italic:true,lh:1.25,max:2}), gap(5), ey(S(m.kicker,'EXPERT QUOTE'))] }),
  question:(m)=>({ a:{l:.08,r:.08,b:.05}, pad:[12,18,12,18], bg:'rgba(4,8,10,.94)', border:'rgba(183,232,106,.35)', r:13, anim:'question',
    blocks:[ey(S(m.kicker,'QUESTION')), gap(3), T(m.headline,{size:F(15,2.2,27),weight:900,lh:1.15,max:2,hl:m.highlight})] }),
  avocadoTip:(m)=>({ a:A.botRight, pad:[13,15,13,15], bg:'rgba(7,13,9,.93)', border:'rgba(183,232,106,.42)', r:13, glow:true, anim:'float',
    blocks:[iconRow(30,9,badgeCircle(30,C.avocado,'\u2713','#0a1207'), stack([ey(S(m.kicker,'TIP')), T(m.headline,{size:F(12,1.5,18),weight:800,lh:1.2,max:3})]))] }),
};

// ---------- entrance animations (values from the original @keyframes) ----------
function animate(kind,p,u,h){
  const r={a:1,tx:0,ty:0,sc:1,rot:0,clip:null}; const e=ease(p);
  switch(kind){
    case 'float': { r.a=clamp01(p/.6); if(p<.6){ const t=ease(p/.6); r.ty=(34+(-4-34)*t)*u; r.sc=.97+(1.01-.97)*t; } else { const t=ease((p-.6)/.4); r.ty=-4*u*(1-t); r.sc=1.01-.01*t; } break; }
    case 'reveal': r.a=clamp01(p/.25); r.clip=e; break;
    case 'caption': r.a=e; r.ty=h*(1-e); break;
    case 'question': { r.a=clamp01(p/.7); if(p<.7){ const t=ease(p/.7); r.ty=(18-21*t)*u; r.rot=(-2+2.5*t)*Math.PI/180; } else { const t=ease((p-.7)/.3); r.ty=-3*u*(1-t); r.rot=.5*(1-t)*Math.PI/180; } break; }
    case 'quote': r.a=e; r.tx=-55*u*(1-e); break;
    case 'zoom': r.a=e; r.sc=1.12-.12*e; break;
  }
  return r;
}

// ---------- the one generic renderer ----------
function renderSpec(ctx,spec,p,W,H,bgFrame,exportOverlay){
  const u=W/1280, blocks=(spec.blocks||[]).filter(Boolean), pd=(spec.pad||[0,0,0,0]).map(v=>v*u);
  const blw=(spec.bl?spec.bl[0]:0)*u, brw=(spec.br?spec.br[0]:0)*u, a=spec.a||{};
  let x,cw;
  if(spec.full){ x=0; cw=W; }
  else if(a.shrink){ const nat=Math.max(0,...blocks.map(b=>b.nat?b.nat(ctx,u):0)); cw=Math.min(W*.6,nat+pd[1]+pd[3]+blw+brw+2); x=a.l!=null?a.l*W:W*(1-a.r)-cw; }
  else if(a.l!=null&&a.r!=null){ x=a.l*W; cw=W*(1-a.l-a.r); }
  else { cw=typeof a.w==='function'?a.w(W):a.w*W; x=a.cx?(W-cw)/2:a.l!=null?a.l*W:W*(1-a.r)-cw; }
  const iw=cw-pd[1]-pd[3]-blw-brw;
  const contentH=blocks.reduce((s,b)=>s+b.h(ctx,u,iw),0);
  const h=spec.full?H:contentH+pd[0]+pd[2];
  const y=spec.full?0:(a.t!=null?a.t*H:H*(1-a.b)-h);
  const an=animate(spec.anim,p,u,h);

  ctx.save();
  ctx.globalAlpha*=an.a;
  const cx=x+cw/2, cy=y+h/2;
  ctx.translate(cx+an.tx,cy+an.ty); if(an.rot) ctx.rotate(an.rot); ctx.scale(an.sc,an.sc); ctx.translate(-cx,-cy);
  if(an.clip!=null){ ctx.beginPath(); ctx.rect(x-70*u,y-70*u,(cw+140*u)*an.clip,h+140*u); ctx.clip(); }

  if(spec.bg==='clinic'){
    let hasClip=false;
    if(bgFrame && !exportOverlay){
      const vw=bgFrame.videoWidth||bgFrame.width, vh=bgFrame.videoHeight||bgFrame.height;
      if(vw && vh && (bgFrame.readyState==null || bgFrame.readyState>=2)){
        const sc=Math.max(W/vw,H/vh), dw=vw*sc, dh=vh*sc;
        try{ ctx.drawImage(bgFrame,(W-dw)/2,(H-dh)/2,dw,dh); hasClip=true; }catch(_){}
      }
    }
    if(hasClip||exportOverlay){
      // With a background clip: flat, nearly solid black overlay (88%) so the text stands out and
      // the clip only faintly shows through. Same value in preview and export.
      ctx.fillStyle='rgba(0,0,0,.88)'; ctx.fillRect(0,0,W,H);
    } else {
      // No clip: original teal-tinted dark gradient.
      const a0=.67, a1=.86;
      const g=ctx.createRadialGradient(W/2,H/2,0,W/2,H/2,Math.hypot(W/2,H/2)); g.addColorStop(0,`rgba(18,65,60,${a0})`); g.addColorStop(.67,`rgba(0,0,0,${a1})`); g.addColorStop(1,`rgba(0,0,0,${a1})`);
      ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
    }
  } else if(spec.bg){
    ctx.save(); ctx.shadowColor=spec.glow?'rgba(183,232,106,.22)':'rgba(0,0,0,.6)'; ctx.shadowBlur=(spec.glow?30:45)*u; ctx.shadowOffsetY=(spec.glow?6:18)*u;
    rrPath(ctx,x,y,cw,h,Array.isArray(spec.r)?spec.r.map(v=>v*u):(spec.r||0)*u); ctx.fillStyle=spec.bg; ctx.fill(); ctx.restore();
    if(spec.border){ rrPath(ctx,x+.5*u,y+.5*u,cw-u,h-u,Array.isArray(spec.r)?spec.r.map(v=>v*u):(spec.r||0)*u); ctx.strokeStyle=spec.border; ctx.lineWidth=u; ctx.stroke(); }
    if(blw||brw){ ctx.save(); rrPath(ctx,x,y,cw,h,Array.isArray(spec.r)?spec.r.map(v=>v*u):(spec.r||0)*u); ctx.clip();
      if(blw){ ctx.fillStyle=spec.bl[1]; ctx.fillRect(x,y,blw,h); } if(brw){ ctx.fillStyle=spec.br[1]; ctx.fillRect(x+cw-brw,y,brw,h); } ctx.restore(); }
  }

  let yy = spec.full ? y+(H-contentH)/2 : y+pd[0];
  const xx = x+pd[3]+blw;
  blocks.forEach(b=>{
    const bh=b.h(ctx,u,iw);
    if(b.stag!=null){
      const sp=ease(sub(p,.25+.13*b.stag,.65+.13*b.stag)); ctx.save(); ctx.globalAlpha*=sp; ctx.translate(0,24*u*(1-sp)); b.d(ctx,u,xx,yy,iw,p); ctx.restore();
    } else b.d(ctx,u,xx,yy,iw,p);
    yy+=bh;
  });
  ctx.restore();
}

// ---------- registry ----------
const STAG = 1150;
const def = (id,name,group,desc,extra)=>Object.assign({id,name,family:id==='clinic'?'fullscreen':'card',group,ownsBackground:id==='clinic',ported:'exact',enterMs:800,promptDesc:desc,spec:SPECS[id]},extra||{});
const TEMPLATE_REGISTRY = [
  def('bottom','Bottom Information Bar','Information','Clean lower-third bar: kicker, one clear headline and a short support line. Safe general-purpose card.'),
  def('side','Large Side Information','Information','Tall side card for one key point with a headline and 1-2 lines of support.'),
  def('fact','Fact Card','Information','Small left card for one fast educational fact: kicker, short headline, optional support.'),
  def('callout','Floating Callout','Information','Top-left callout for a key point with a headline and a 15-20 word explanation.'),
  def('number','Numbered Item','Information','Small card with a number badge (use step or number, e.g. 01) and a short headline. Good for "point 1".'),
  def('light','Light Information','Information','Bright lower card with kicker, headline and support for calm explainers or definitions.'),
  def('emphasis','Big Emphasis','Information','Large side statement. Use before/after for a transformation, or a strong headline with a highlight word.'),
  def('checklist','Checklist','Structure','Left checklist with 2-4 items (items array), each with a check mark. For requirements or tips.',{enterMs:STAG}),
  def('stack','Stacked Cards','Structure','Layered numbered cards for 2-4 short ideas (items array) that reveal one after another.',{enterMs:STAG}),
  def('doctor','Doctor Name','Structure','Speaker identity card (name in headline, specialty in support). Used for the speaker self-introduction.',{enterMs:800}),
  def('clinic','Center / Clinic','Structure','Full-screen CENTER card over a moving background clip. Use for major facts, explanations, numbers, topic changes and the opening line. Headline max 8 words, kicker max 3 words, support max 12 words.',{enterMs:900}),
  def('chapter','Chapter Title','Structure','Top-right section divider: kicker like CHAPTER 03 and a short title of the new topic.'),
  def('stat','Big Statistic','Structure','Large number spotlight: put the figure in number (e.g. 86%), what it measures in headline.'),
  def('quoteStrip','Quote Strip','Structure','Lower quote strip: headline is the quote, support is who said it.'),
  def('full','Full-Screen Transition','Structure','Top-right attention card for a topic shift or "one more thing" moment: short headline, one support line.'),
  def('numBurst','Number Burst','Motion Data','Big avocado step number (number or step) with a short headline. For the turning point or a step.'),
  def('steps','Step-by-Step','Motion Data','Left card with 2-3 numbered steps (items; use "Title: detail" for a description). For sequences.',{enterMs:STAG}),
  def('progress','Progress Tracker','Motion Data','Lower bar with animated fill. Put the percentage in number (e.g. 72%), what it tracks in headline.'),
  def('myth','Myth vs Fact','Motion Data','Two-column correction: put the misconception in myth and the truth in fact. Only for real myths.'),
  def('result','Result Badge','Motion Data','Top-right result: the outcome figure in number (e.g. +86%) with a label in support.'),
  def('caption','Caption Bar','Extra Caption Pack','Slim bottom caption bar with one memorable sentence in headline.'),
  def('warning','Warning Alert','Extra Caption Pack','Amber warning lower third for a real risk or sign the speaker stresses. Headline = the warning.'),
  def('quoteCaption','Quote Caption','Extra Caption Pack','Elegant italic quote strip for a spoken line worth quoting. Kicker = source label.'),
  def('question','Question Hook','Extra Caption Pack','Bottom question opener: headline is a short question the speaker raises.'),
  def('avocadoTip','Avocado Tip','Extra Caption Pack','Branded tip card (bottom right) with a check icon: one short, concrete recommendation in headline.'),
];
const TEMPLATE_BY_ID = {}; TEMPLATE_REGISTRY.forEach(t=>TEMPLATE_BY_ID[t.id]=t);

// box presets are kept so the "add custom template" form in editor.html still works: each maps to a spec.
const tagBox = (fn,key)=>{ fn.specKey=key; return fn; };
const MT_BOX_PRESETS = {
  lowerThirdPill: tagBox(()=>null,'bottom'), sideCard: tagBox(()=>null,'side'),
  cornerCard: tagBox(()=>null,'fact'), centerCard: tagBox(()=>null,'clinic'),
};

function drawTemplateCard(ctx, m, enterP, W, H, bgFrame, exportOverlay){
  const t = TEMPLATE_BY_ID[m.templateId];
  if(!t){ console.warn('[motion-templates] unknown templateId', m.templateId); return; }
  m = Object.assign({}, m);
  if(Array.isArray(m.items)) m.items = m.items.filter(Boolean);
  m.headline = S(m.headline, S(m.number, S(t.name,'')));
  const specFn = t.spec || (t.box && t.box.specKey && SPECS[t.box.specKey]) || (t.family==='fullscreen' ? SPECS.clinic : SPECS.bottom);
  const spec = specFn(m);
  if(t.boxOpts && t.boxOpts.accentColor && !t.spec){ /* custom entries: accent only tints the highlight */ }
  renderSpec(ctx, spec, clamp01(enterP), W||ctx.canvas.width, H||ctx.canvas.height, bgFrame, exportOverlay);
}

// ---------- background clips (kept for the Clips Library UI; the 25 templates don't need a background clip) ----------
let CLIP_LIBRARY = [], GENERIC_FALLBACK_CLIP = null;
function matchBackgroundClip(scriptText){
  const text=(scriptText||'').toLowerCase();
  for(const clip of CLIP_LIBRARY){ if((clip.keywords||[]).some(k=>text.includes(String(k).toLowerCase()))) return clip; }
  return GENERIC_FALLBACK_CLIP;
}

if(typeof window!=='undefined'){
  window.MotionTemplates = {
    TEMPLATE_REGISTRY, TEMPLATE_BY_ID, drawTemplateCard, matchBackgroundClip, SPECS,
    MT_COLOR, MT_EXIT_MS, MT_DEFAULT_ENTER_MS, CLIP_LIBRARY,
    ICON_NAMES: [], BOX_PRESETS: MT_BOX_PRESETS,
    setClipLibrary(l){ CLIP_LIBRARY=l||[]; }, setGenericFallbackClip(c){ GENERIC_FALLBACK_CLIP=c; },
    addCustomTemplate(entry){ if(!entry||!entry.id||TEMPLATE_BY_ID[entry.id]) return false; TEMPLATE_REGISTRY.push(entry); TEMPLATE_BY_ID[entry.id]=entry; return true; },
    removeTemplate(id){ delete TEMPLATE_BY_ID[id]; const i=TEMPLATE_REGISTRY.findIndex(t=>t.id===id); if(i>=0) TEMPLATE_REGISTRY.splice(i,1); },
  };
}
})();
