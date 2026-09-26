import fs from 'node:fs/promises';

const out=new URL('../outputs/research/',import.meta.url);
const data=JSON.parse(await fs.readFile(new URL('assumption_sensitivity.json',out),'utf8'));
const rows=data.rows.slice(1);
const translate={
  '储罐表压':'Tank gauge pressure',
  '有效混合体积':'Effective mixing volume',
  '液面风速系数':'Surface-wind multiplier',
  '主塔吸收比例':'Main-stage capture',
  '厂房容积50%':'50% room volume',
  '厂房容积75%':'75% room volume'
};
const metrics=[
  ['leakedKgChangePct','Leaked mass'],
  ['fanNm3HChangePct','Fan flow'],
  ['maxGasMolFractionChangePct','Gas Cl2 peak'],
  ['maxTotalChlorineKgHChangePct','Total Cl2 peak'],
  ['mainCoolingKWChangePct','Main cooling'],
  ['tailCoolingKWChangePct','Tail cooling']
];
const W=1040,H=500,left=250,top=80,cw=125,rh=45;
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const color=v=>{
  const t=Math.min(1,Math.abs(v)/50);
  if(v>=0)return `rgb(255,${Math.round(245-105*t)},${Math.round(235-135*t)})`;
  return `rgb(${Math.round(235-135*t)},${Math.round(245-80*t)},255)`;
};
let body='<rect width="100%" height="100%" fill="white"/><style>text{font-family:Arial,sans-serif;fill:#1a202c}.title{font-size:16px;font-weight:600}.head{font-size:11px;font-weight:600}.cell{font-size:12px}.row{font-size:12px}</style>';
metrics.forEach(([,label],j)=>body+=`<text x="${left+j*cw+cw/2}" y="58" text-anchor="middle" class="head">${esc(label)}</text>`);
rows.forEach((r,i)=>{
  const y=top+i*rh;
  body+=`<text x="${left-12}" y="${y+rh/2+4}" text-anchor="end" class="row">${esc(translate[r.group]??r.group)} · ${esc(translate[r.label]??r.label)}</text>`;
  metrics.forEach(([key],j)=>{
    const v=r[key],x=left+j*cw;
    body+=`<rect x="${x}" y="${y}" width="${cw-3}" height="${rh-3}" rx="3" fill="${color(v)}" stroke="#edf2f7"/>`;
    body+=`<text x="${x+(cw-3)/2}" y="${y+rh/2+4}" text-anchor="middle" class="cell">${v>=0?'+':''}${v.toFixed(2)}</text>`;
  });
});
body+=`<text x="${left}" y="${H-20}" class="cell">Blue: decrease</text><text x="${left+130}" y="${H-20}" class="cell">Red: increase</text><text x="${left+260}" y="${H-20}" class="cell">Color scale capped at ±50%</text>`;
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
await fs.writeFile(new URL('assumption_sensitivity_heatmap.svg',out),svg);
console.log(new URL('assumption_sensitivity_heatmap.svg',out).pathname);
