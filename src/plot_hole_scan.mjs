import fs from 'node:fs/promises';

const out=new URL('../outputs/research/',import.meta.url);
const data=JSON.parse(await fs.readFile(new URL('hole_size_scan.json',out),'utf8'));
const rows=data.rows;
const holes=data.holeDiametersMm;
const colors={15:'#2b6cb0',25:'#c05621',35:'#2f855a'};

const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const line=(x1,y1,x2,y2,attrs='')=>`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${attrs}/>`;
const text=(x,y,value,attrs='')=>`<text x="${x}" y="${y}" ${attrs}>${esc(value)}</text>`;
const circle=(x,y,r,attrs='')=>`<circle cx="${x}" cy="${y}" r="${r}" ${attrs}/>`;
const polyline=(points,attrs='')=>`<polyline points="${points.map(p=>p.join(',')).join(' ')}" ${attrs}/>`;
const svg=(w,h,body)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="100%" height="100%" fill="white"/>
<style>text{font-family:Arial,sans-serif;fill:#1a202c}.axis{stroke:#4a5568;stroke-width:1}.grid{stroke:#e2e8f0;stroke-width:1}.series{fill:none;stroke-width:2}.tick{font-size:11px}.label{font-size:12px}.title{font-size:14px;font-weight:600}.legend{font-size:11px}</style>
${body}
</svg>`;

function panel({x,y,w,h,xmin,xmax,ymin,ymax,xticks,yticks,xlabel,ylabel,title}){
  const sx=v=>x+(v-xmin)/(xmax-xmin)*w;
  const sy=v=>y+h-(v-ymin)/(ymax-ymin)*h;
  let body='';
  for(const v of yticks){const yy=sy(v);body+=line(x,yy,x+w,yy,'class="grid"');body+=text(x-7,yy+4,v.toFixed(1),'class="tick" text-anchor="end"');}
  for(const v of xticks){const xx=sx(v);body+=line(xx,y,xx,y+h,'class="grid"');body+=text(xx,y+h+17,v.toFixed(1),'class="tick" text-anchor="middle"');}
  body+=line(x,y+h,x+w,y+h,'class="axis"')+line(x,y,x,y+h,'class="axis"');
  body+=text(x+w/2,y+h+38,xlabel,'class="label" text-anchor="middle"');
  body+=`<text x="${x-47}" y="${y+h/2}" class="label" text-anchor="middle" transform="rotate(-90 ${x-47} ${y+h/2})">${esc(ylabel)}</text>`;
  body+=text(x+w/2,y-12,title,'class="title" text-anchor="middle"');
  return {sx,sy,body};
}

const maxPi=Math.max(...rows.map(r=>r.pumpToInitialLeakRatio));
const metrics=[
  ['leakFractionNoTransfer','Leaked mass ratio','A. Cumulative release'],
  ['fanRatioNoTransfer','Fan flow ratio','B. Fan flow'],
  ['coolingRatioNoTransfer','Cooling peak ratio','C. Main cooling peak']
];
let body='';
for(let i=0;i<metrics.length;i++){
  const [key,ylabel,title]=metrics[i];
  const p=panel({x:65+i*360,y:70,w:290,h:255,xmin:0,xmax:Math.ceil(maxPi),ymin:0,ymax:1.05,
    xticks:[0,1,2,3,4,5,6,7],yticks:[0,.2,.4,.6,.8,1],xlabel:'Relative transfer capacity, ΠQ',ylabel,title});
  body+=p.body;
  for(const h of holes) for(const delay of [0,300]){
    const pts=rows.filter(r=>r.holeDiameterMm===h&&r.delayS===delay).sort((a,b)=>a.pumpToInitialLeakRatio-b.pumpToInitialLeakRatio);
    const coords=pts.map(r=>[p.sx(r.pumpToInitialLeakRatio),p.sy(r[key])]);
    body+=polyline(coords,`class="series" stroke="${colors[h]}" ${delay===300?'stroke-dasharray="6 4"':''}`);
    for(const [cx,cy] of coords)body+=circle(cx,cy,2.6,`fill="${colors[h]}"`);
  }
}
let lx=145;
for(const h of holes){
  body+=line(lx,28,lx+25,28,`stroke="${colors[h]}" stroke-width="2"`)+text(lx+30,32,`${h} mm`,'class="legend"');
  lx+=95;
}
body+=line(lx,28,lx+25,28,'stroke="#4a5568" stroke-width="2"')+text(lx+30,32,'0 s delay','class="legend"');lx+=105;
body+=line(lx,28,lx+25,28,'stroke="#4a5568" stroke-width="2" stroke-dasharray="6 4"')+text(lx+30,32,'300 s delay','class="legend"');
await fs.writeFile(new URL('hole_size_sensitivity.svg',out),svg(1135,390,body));

const active=rows.filter(r=>r.pumpM3H>0);
const maxTheta=Math.max(...active.map(r=>r.delayToNoTransferDuration));
const q=panel({x:80,y:45,w:500,h:330,xmin:0,xmax:Math.ceil(maxPi),ymin:0,ymax:1,
  xticks:[0,1,2,3,4,5,6,7],yticks:[0,.2,.4,.6,.8,1],xlabel:'Relative transfer capacity, ΠQ',
  ylabel:'Leaked mass / no-transfer mass',title:'Dimensionless transfer-response map'});
body=q.body;
for(const r of active){
  const t=maxTheta?Math.min(1,r.delayToNoTransferDuration/maxTheta):0;
  const red=Math.round(240-170*t),green=Math.round(180-90*t),blue=Math.round(50+150*t);
  const color=`rgb(${red},${green},${blue})`;
  const cx=q.sx(r.pumpToInitialLeakRatio),cy=q.sy(r.leakFractionNoTransfer);
  if(r.holeDiameterMm===15)body+=circle(cx,cy,4,`fill="${color}" stroke="white" stroke-width="0.7"`);
  else if(r.holeDiameterMm===25)body+=`<rect x="${cx-4}" y="${cy-4}" width="8" height="8" fill="${color}" stroke="white" stroke-width="0.7"/>`;
  else body+=`<path d="M ${cx} ${cy-4.8} L ${cx+4.5} ${cy+3.8} L ${cx-4.5} ${cy+3.8} Z" fill="${color}" stroke="white" stroke-width="0.7"/>`;
}
body+=text(610,80,'Marker: hole diameter','class="title"');
body+=circle(625,108,4,'fill="#718096"')+text(640,112,'15 mm','class="legend"');
body+=`<rect x="621" y="130" width="8" height="8" fill="#718096"/>`+text(640,138,'25 mm','class="legend"');
body+=`<path d="M 625 156 L 629.5 164 L 620.5 164 Z" fill="#718096"/>`+text(640,163,'35 mm','class="legend"');
body+=text(610,205,'Color: relative delay Θd','class="title"');
for(let i=0;i<100;i++){
  const t=i/99,red=Math.round(240-170*t),green=Math.round(180-90*t),blue=Math.round(50+150*t);
  body+=`<rect x="${610+i*1.8}" y="220" width="2" height="14" fill="rgb(${red},${green},${blue})"/>`;
}
body+=text(610,251,'0','class="tick"')+text(790,251,maxTheta.toFixed(3),'class="tick" text-anchor="end"');
await fs.writeFile(new URL('dimensionless_transfer_map.svg',out),svg(820,430,body));

console.log(new URL('hole_size_sensitivity.svg',out).pathname);
console.log(new URL('dimensionless_transfer_map.svg',out).pathname);
