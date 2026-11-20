import fs from 'node:fs/promises';
import { lineFigure as paperFigure, textAt } from './paper_line_figure.mjs';

const out = new URL('../outputs/research/', import.meta.url);
const data = JSON.parse(await fs.readFile(new URL('assumption_sensitivity.json', out), 'utf8'));
const scenarios = data.rows.filter(row => row.id !== 'baseline');
const groupNames = {
  '储罐表压': 'Tank gauge pressure',
  '有效混合体积': 'Effective mixing volume',
  '液面风速系数': 'Surface-wind multiplier',
  '主塔吸收比例': 'Main-stage capture',
  '流出系数': 'Discharge coefficient',
  '液池厚度': 'Pool depth',
  '地面初始温度': 'Initial ground temperature'
};
const metrics = [
  ['leakedKgChangePct', ['Released', 'mass']],
  ['fanNm3HChangePct', ['Fan', 'flow']],
  ['maxGasMolFractionChangePct', ['Peak chlorine', 'mole fraction']],
  ['maxTotalChlorineKgHChangePct', ['Peak chlorine', 'inlet load']],
  ['mainCoolingKWChangePct', ['Main cooling', 'duty']],
  ['tailCoolingKWChangePct', ['Tail cooling', 'duty']]
];

const groups = new Map();
for (const row of scenarios) {
  if (!groups.has(row.group)) groups.set(row.group, []);
  groups.get(row.group).push(row);
}

const negative = [37, 99, 135], positive = [166, 75, 42];
const limit = 50;
function cellColors(value) {
  const end = value < 0 ? negative : positive;
  const fraction = Math.min(1, Math.abs(value) / limit);
  const rgb = end.map(c => Math.round(255 + (c - 255) * fraction));
  const [r, g, b] = rgb.map(c => ((c / 255 + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return { fill: `rgb(${rgb.join(',')})`, ink: luminance < 0.2 ? 'white' : '#20262b' };
}

const left = 266, right = 925, valueX = 249;
const cellWidth = (right - left) / metrics.length;
const rowHeight = 35, groupGap = 8;
let y = 57;
const parts = ['<style>.column-head {font-size:14px;font-weight:bold} .cell-value {font-size:15px}</style>'];
parts.push(textAt(8, 40, 'Parameter', 'column-head', 'start'), textAt(valueX, 40, 'Value', 'column-head', 'end'));
metrics.forEach(([, lines], j) => {
  const x = left + (j + 0.5) * cellWidth;
  lines.forEach((title, i) => parts.push(textAt(x, 24 + 16 * i, title, 'column-head')));
});
parts.push(`<path d="M8,49 H${right}" stroke="#647078" stroke-width="1.2"/>`);

for (const [group, rows] of groups) {
  const groupMid = y + rows.length * rowHeight / 2;
  parts.push(textAt(8, groupMid + 5, groupNames[group] ?? group, 'key', 'start'));
  for (const row of rows) {
    const label = row.label.replace(/^厂房容积(.+%)$/, '$1 of room');
    parts.push(textAt(valueX, y + rowHeight / 2 + 5, label, 'key', 'end'));
    metrics.forEach(([key], j) => {
      const value = row[key], x = left + j * cellWidth;
      const { fill, ink } = cellColors(value);
      const digits = Math.abs(value).toFixed(1);
      const number = digits === '0.0' ? '0' : (value > 0 ? '+' : '−') + digits;
      parts.push(`<rect x="${x}" y="${y}" width="${cellWidth - 1}" height="${rowHeight - 1}" fill="${fill}"/>`);
      parts.push(textAt(x + cellWidth / 2, y + rowHeight / 2 + 5, number, 'cell-value', 'middle', ink));
    });
    y += rowHeight;
  }
  parts.push(`<path d="M8,${y + 3} H${right}" stroke="#cbd0d3" stroke-width="0.75"/>`);
  y += groupGap;
}

const scaleX = 433, scaleY = y + 30, scaleW = 345;
parts.push(`<defs><linearGradient id="change"><stop offset="0" stop-color="rgb(${negative.join(',')})"/>
  <stop offset="0.5" stop-color="white"/><stop offset="1" stop-color="rgb(${positive.join(',')})"/></linearGradient></defs>`);
parts.push(textAt(scaleX - 21, scaleY + 12, 'Change from baseline (%)', 'axis-label', 'end'));
parts.push(`<rect x="${scaleX}" y="${scaleY}" width="${scaleW}" height="14" fill="url(#change)" stroke="#aab0b4" stroke-width="0.8"/>`);
for (const [i, tick] of ['≤−50', '−25', '0', '+25', '≥+50'].entries()) {
  const x = scaleX + i * scaleW / 4;
  parts.push(`<path d="M${x},${scaleY + 14}v4" stroke="#525c64"/>`, textAt(x, scaleY + 34, tick, 'tick'));
}

const height = Math.ceil((scaleY + 60) * 1040 / 930);
const output = new URL('assumption_sensitivity_heatmap.svg', out);
await fs.writeFile(output, paperFigure(parts.join(''), 1040, height));
console.log(output.pathname);
