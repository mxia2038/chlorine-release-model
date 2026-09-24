import fs from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const data = JSON.parse(await fs.readFile(new URL('outputs/data/default_25mm_results.json', root), 'utf8'));
const release = data.release.rows.filter(r => r.timeS <= 9000);
const room = data.ventilation.rows.filter(r => r.timeS <= 9000);

const W=1200,H=430,top=58,plotH=285,left=65,panelW=330,gap=65;
const colors={blue:'#2b6cb0',orange:'#c05621',green:'#2f855a',purple:'#6b46c1',gray:'#4a5568'};
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const line=(x1,y1,x2,y2,a='')=>`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${a}/>`;
const text=(x,y,s,a='')=>`<text x="${x}" y="${y}" ${a}>${esc(s)}</text>`;
const pathLine=(pts,a='')=>`<polyline points="${pts.map(p=>p.join(',')).join(' ')}" ${a}/>`;

function panel(i,{title,ymax,yticks,ylabel}){
  const x=left+i*(panelW+gap),y=top;
  const sx=t=>x+(t/150)*panelW;
  const sy=v=>y+plotH-(v/ymax)*plotH;
  let body='';
  for(const v of yticks){const yy=sy(v);body+=line(x,yy,x+panelW,yy,'class="grid"');body+=text(x-8,yy+4,Number.isInteger(v)?v:v.toFixed(1),'class="tick" text-anchor="end"');}
  for(const v of [0,30,60,90,120,150]){const xx=sx(v);body+=line(xx,y,xx,y+plotH,'class="grid"');body+=text(xx,y+plotH+18,v,'class="tick" text-anchor="middle"');}
  body+=line(x,y+plotH,x+panelW,y+plotH,'class="axis"')+line(x,y,x,y+plotH,'class="axis"');
  body+=text(x+panelW/2,y-15,title,'class="title" text-anchor="middle"');
  body+=text(x+panelW/2,y+plotH+42,'Time after leak onset (min)','class="label" text-anchor="middle"');
  body+=`<text x="${x-48}" y="${y+plotH/2}" class="label" text-anchor="middle" transform="rotate(-90 ${x-48} ${y+plotH/2})">${esc(ylabel)}</text>`;
  return {sx,sy,body};
}

let body='';
const withdrawalMax=Math.ceil(Math.max(...release.flatMap(r=>[r.leakRateKgS,r.transferRateKgS]))/2)*2;
const gasSourceMax=Math.ceil(Math.max(...release.flatMap(r=>[r.flashRateKgS,r.heatEvapRateKgS,r.massEvapRateKgS])));
const p1=panel(0,{title:'A. Tank withdrawal rates',ymax:withdrawalMax,yticks:Array.from({length:7},(_,i)=>i*withdrawalMax/6),ylabel:'Mass flow (kg/s)'}); body+=p1.body;
const p2=panel(1,{title:'B. Airborne gas-source terms',ymax:gasSourceMax,yticks:Array.from({length:6},(_,i)=>i*gasSourceMax/5),ylabel:'Gas source (kg/s)'}); body+=p2.body;
const maxLoad=Math.ceil(Math.max(...room.map(r=>r.totalChlorineLoadKgH))/2000)*2000;
const p3=panel(2,{title:'C. Scrubber inlet chlorine load',ymax:maxLoad,yticks:[0,maxLoad*.25,maxLoad*.5,maxLoad*.75,maxLoad],ylabel:'Chlorine load (kg/h)'}); body+=p3.body;

const series=(rows,x,y,key,color,dash='')=>pathLine(rows.map(r=>[x(r.timeS/60),y(r[key])]),`fill="none" stroke="${color}" stroke-width="2.2" ${dash}`);
body+=series(release,p1.sx,p1.sy,'leakRateKgS',colors.blue);
body+=series(release,p1.sx,p1.sy,'transferRateKgS',colors.orange,'stroke-dasharray="7 4"');
body+=series(release,p2.sx,p2.sy,'flashRateKgS',colors.blue);
body+=series(release,p2.sx,p2.sy,'heatEvapRateKgS',colors.orange);
body+=series(release,p2.sx,p2.sy,'massEvapRateKgS',colors.green);
body+=series(room,p3.sx,p3.sy,'chlorineLoadKgH',colors.blue);
body+=series(room,p3.sx,p3.sy,'dropletsLoadKgH',colors.orange);
body+=series(room,p3.sx,p3.sy,'totalChlorineLoadKgH',colors.purple,'stroke-dasharray="7 4"');

function legend(x,y,items){
  let b='';
  for(const [label,color,dash] of items){b+=line(x,y,x+24,y,`stroke="${color}" stroke-width="2.2" ${dash?'stroke-dasharray="7 4"':''}`)+text(x+31,y+4,label,'class="legend"');x+=label.length*6.2+62;}
  return b;
}
body+=legend(90,25,[['Leak',colors.blue],['Transfer',colors.orange,true]]);
body+=legend(450,25,[['Flash',colors.blue],['Heat evaporation',colors.orange],['Mass evaporation',colors.green]]);
body+=legend(860,25,[['Gas',colors.blue],['Droplets',colors.orange],['Total',colors.purple,true]]);

const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="100%" height="100%" fill="white"/>
<style>text{font-family:Arial,sans-serif;fill:#1a202c}.axis{stroke:#4a5568;stroke-width:1}.grid{stroke:#e2e8f0;stroke-width:1}.tick{font-size:10px}.label{font-size:12px}.title{font-size:14px;font-weight:600}.legend{font-size:10.5px}</style>${body}</svg>`;
const output=new URL('outputs/research/baseline_dynamic_propagation.svg',root);
await fs.writeFile(output,svg);
console.log(output.pathname);
