import fs from 'node:fs/promises';

const out=new URL('../outputs/research/',import.meta.url);
const data=JSON.parse(await fs.readFile(new URL('droplet_fate_bounds.json',out),'utf8'));
const rows=data.rows;
const metrics=[
  ['fanNm3H','Fan flow'],
  ['maxGasMolFraction','Gas Cl2 peak'],
  ['maxTotalChlorineKgH','Total Cl2 peak'],
  ['mainCoolingKW','Cooling peak']
];
const colors=['#2b6cb0','#c05621','#2f855a'];
const labels=['Suspended','Assigned to gas','Assigned to pool'];
const ratios=rows.map(r=>metrics.map(([k])=>r[k]/rows[0][k]));
const W=900,H=430,left=70,top=55,plotW=790,plotH=300,maxY=1.8;
const sy=v=>top+plotH-v/maxY*plotH;
let body='<rect width="100%" height="100%" fill="white"/><style>text{font-family:Arial,sans-serif;fill:#1a202c}.grid{stroke:#e2e8f0}.axis{stroke:#4a5568}.tick{font-size:11px}.label{font-size:12px}.title{font-size:15px;font-weight:600}</style>';
for(const v of [0,.3,.6,.9,1.2,1.5,1.8]){
  const y=sy(v);body+=`<line x1="${left}" y1="${y}" x2="${left+plotW}" y2="${y}" class="grid"/>`;
  body+=`<text x="${left-8}" y="${y+4}" text-anchor="end" class="tick">${v.toFixed(1)}</text>`;
}
body+=`<line x1="${left}" y1="${top+plotH}" x2="${left+plotW}" y2="${top+plotH}" class="axis"/><line x1="${left}" y1="${top}" x2="${left}" y2="${top+plotH}" class="axis"/>`;
body+=`<line x1="${left}" y1="${sy(1)}" x2="${left+plotW}" y2="${sy(1)}" stroke="#718096" stroke-dasharray="5 4"/>`;
body+=`<text x="18" y="${top+plotH/2}" text-anchor="middle" class="label" transform="rotate(-90 18 ${top+plotH/2})">Ratio to suspended-droplet baseline</text>`;
const groupW=plotW/metrics.length,barW=42;
metrics.forEach(([,label],i)=>{
  const center=left+groupW*(i+.5);
  body+=`<text x="${center}" y="${top+plotH+28}" text-anchor="middle" class="label">${label}</text>`;
  rows.forEach((r,j)=>{
    const val=ratios[j][i],x=center+(j-1)*barW-barW*.42,y=sy(val),height=top+plotH-y;
    body+=`<rect x="${x}" y="${y}" width="${barW*.84}" height="${height}" fill="${colors[j]}"/><text x="${x+barW*.42}" y="${y-5}" text-anchor="middle" class="tick">${val.toFixed(2)}</text>`;
  });
});
let lx=210;
rows.forEach((r,j)=>{body+=`<rect x="${lx}" y="392" width="13" height="13" fill="${colors[j]}"/><text x="${lx+19}" y="403" class="tick">${labels[j]}</text>`;lx+=j===0?125:170;});
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
await fs.writeFile(new URL('droplet_boundary_comparison.svg',out),svg);
console.log(new URL('droplet_boundary_comparison.svg',out).pathname);
