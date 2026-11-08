const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const jobs = [['app-icon.svg','icon-192.png',192],['app-icon.svg','icon-512.png',512],['app-icon-maskable.svg','icon-maskable-512.png',512],['app-icon.svg','apple-touch-icon.png',180],['favicon.svg','favicon-32.png',32]];
  for (const [src,out,s] of jobs) {
    const svg = fs.readFileSync('svg/'+src,'utf8');
    await p.setViewportSize({width:s,height:s});
    await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ',`<svg width="${s}" height="${s}" `)}</body></html>`);
    await p.screenshot({path:'png/'+out, omitBackground:true, clip:{x:0,y:0,width:s,height:s}});
  }
  // preview frames of the loader for checking
  await p.setViewportSize({width:880,height:220});
  const L = fs.readFileSync('svg/whittle-loader-dark.svg','utf8');
  let html='<html><body style="margin:0;background:#101217;display:flex">';
  const ts=[0.3,1.0,1.7,2.6,3.7];
  ts.forEach((t,i)=>{html+=`<div style="width:176px;height:220px">${L.replace('<svg ','<svg width="176" height="176" ').replaceAll('infinite',`infinite;animation-delay:-${t}s;animation-play-state:paused`)}</div>`});
  await p.setContent(html+'</body></html>');
  await p.waitForTimeout(200);
  await p.screenshot({path:'/tmp/claude-0/-home-claude/db57dc74-299d-5d85-bca5-d185fbbb3a72/scratchpad/frames.png'});
  await b.close();
})();
