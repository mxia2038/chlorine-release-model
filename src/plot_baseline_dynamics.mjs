import fs from 'node:fs/promises';
import { heading, lineFigure, palette, panel, series, textAt, verticalLabel } from './paper_line_figure.mjs';

const root = new URL('../', import.meta.url);
const data = JSON.parse(await fs.readFile(new URL('outputs/data/default_25mm_results.json', root), 'utf8'));
const release = data.release.rows.filter(r => r.timeS <= 9000);
const room = data.ventilation.rows.filter(r => r.timeS <= 9000);

const withdrawalMax = Math.ceil(Math.max(...release.flatMap(r => [r.leakRateKgS, r.transferRateKgS])) / 2) * 2;
const gasSourceMax = Math.ceil(Math.max(...release.flatMap(r => [r.flashRateKgS, r.heatEvapRateKgS, r.massEvapRateKgS])));
const maxLoad = Math.ceil(Math.max(...room.map(r => r.totalChlorineLoadKgH)) / 2000) * 2000;
const plots = [
  { title: 'Tank withdrawal', yLabel: 'Mass flow (kg/s)', max: withdrawalMax,
    ticks: Array.from({length:5}, (_,i)=>i*withdrawalMax/4),
    lines: [
      { label: 'Leak', key: 'leakRateKgS', color: palette.blue, minute: 18, dy: 18 },
      { label: 'Transfer', key: 'transferRateKgS', color: palette.orange, dashed: true, minute: 18, dy: -10 }
    ] },
  { title: 'Gas source', yLabel: 'Gas source (kg/s)', max: gasSourceMax,
    ticks: Array.from({length:5}, (_,i)=>i*gasSourceMax/4),
    lines: [
      { label: 'Flash', key: 'flashRateKgS', color: palette.blue, minute: 22, dy: -9 },
      { label: 'Heat evaporation', key: 'heatEvapRateKgS', color: palette.orange, minute: 84, anchor: 'end', dy: -12 },
      { label: 'Mass evaporation', key: 'massEvapRateKgS', color: palette.green, minute: 8, dy: -10 }
    ] },
  { title: 'Absorber inlet load', yLabel: 'Chlorine load (t/h)', max: maxLoad,
    ticks: [0, maxLoad/4, maxLoad/2, 3*maxLoad/4, maxLoad], formatY: v=>String(v/1000),
    lines: [
      { label: 'Gas', key: 'chlorineLoadKgH', color: palette.blue, minute: 109, dy: -10 },
      { label: 'Droplets', key: 'dropletsLoadKgH', color: palette.orange, minute: 136, anchor: 'end', dy: 21 },
      { label: 'Total', key: 'totalChlorineLoadKgH', color: palette.ink, dashed: true, minute: 96, dy: -10 }
    ] }
];

let body = '';
for (const [i, config] of plots.entries()) {
  const left = 61 + 311*i, right = left + 228, top = 48, bottom = 265;
  const plot = panel({left,right,top,bottom,xRange:[0,150],yRange:[0,config.max],
    xTicks:[0,30,60,90,120,150],yTicks:config.ticks,formatY:config.formatY,
    yGuides:[config.max/2]});
  body += heading(left-15,27,'abc'[i],config.title) + plot.body;
  body += verticalLabel(left-40,(top+bottom)/2,config.yLabel);
  const rows = i === 2 ? room : release;
  const labels = [];
  for (const entry of config.lines) {
    body += series(rows.map(r=>[plot.x(r.timeS/60),plot.y(r[entry.key])]),entry.color,entry.dashed);
    const row = rows.reduce((closest,r)=>
      Math.abs(r.timeS/60-entry.minute)<Math.abs(closest.timeS/60-entry.minute) ? r : closest);
    labels.push(textAt(plot.x(row.timeS/60), plot.y(row[entry.key])+entry.dy,
      entry.label,'curve-label',entry.anchor || 'start',entry.color));
  }
  body += labels.join('');
}
body += textAt(485,318,'Time after leak onset (min)','axis-label');
const output = new URL('outputs/research/baseline_dynamic_propagation.svg', root);
await fs.writeFile(output, lineFigure(body, 1200, 430));
console.log(output.pathname);
