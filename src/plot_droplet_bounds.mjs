import fs from 'node:fs/promises';
import { lineFigure as paperFigure, palette, textAt, verticalLabel } from './paper_line_figure.mjs';

const out = new URL('../outputs/research/', import.meta.url);
const data = JSON.parse(await fs.readFile(new URL('droplet_fate_bounds.json', out), 'utf8'));
const rowsById = new Map(data.rows.map(row => [row.id, row]));
const baseline = rowsById.get('suspended');
const cases = [
  { id: 'suspended', label: 'Suspended (baseline)', fill: '#c7cdd0' },
  { id: 'vaporized', label: 'Assigned to gas', fill: palette.orange },
  { id: 'deposited', label: 'Assigned to pool', fill: palette.blue }
];
const metrics = [
  ['fanNm3H', ['Fan flow']],
  ['maxGasMolFraction', ['Peak chlorine', 'mole fraction']],
  ['maxTotalChlorineKgH', ['Peak chlorine', 'inlet load']],
  ['mainCoolingKW', ['Peak main-tower', 'cooling duty']]
];

const left = 79, right = 919, top = 56, bottom = 358;
const maxRatio = Math.max(...metrics.flatMap(([key]) =>
  cases.map(c => rowsById.get(c.id)[key] / baseline[key])));
const ceiling = Math.max(2, Math.ceil((maxRatio + 0.1) * 2) / 2);
const y = value => bottom - value * (bottom - top) / ceiling;
const widthPerGroup = (right - left) / metrics.length;
const parts = [];
for (const [i, entry] of cases.entries()) {
  const x = [192, 409, 593][i];
  parts.push(`<rect x="${x}" y="16" width="17" height="13" fill="${entry.fill}"/>`);
  parts.push(textAt(x + 25, 28, entry.label, 'key', 'start'));
}
parts.push(verticalLabel(20, (top + bottom) / 2, 'Ratio to suspended-droplet baseline'));
for (let v = 0; v <= ceiling; v += 0.5) {
  const yy = y(v);
  if (v > 0 && v !== 1 && v < ceiling) {
    parts.push(`<path d="M${left},${yy} H${right}" class="guide"/>`);
  }
  parts.push(`<path d="M${left - 4},${yy}h4" class="axis"/>`, textAt(left - 9, yy + 5, v.toFixed(1), 'tick', 'end'));
}
parts.push(`<path d="M${left},${top} V${bottom} H${right}" fill="none" class="axis"/>`);
parts.push(`<path d="M${left},${y(1)} H${right}" stroke="#424950" stroke-width="1.2" stroke-dasharray="5 5"/>`);
const groupOffset = 42, barWidth = 36;
metrics.forEach(([key, lines], i) => {
  const center = left + (i + 0.5) * widthPerGroup;
  lines.forEach((title, j) => parts.push(textAt(center, bottom + 30 + 18 * j, title, 'axis-label')));
  cases.forEach((entry, j) => {
    const ratio = rowsById.get(entry.id)[key] / baseline[key];
    const x = center + (j - 1) * groupOffset;
    parts.push(`<rect x="${x - barWidth / 2}" y="${y(ratio)}" width="${barWidth}" height="${bottom - y(ratio)}" fill="${entry.fill}"/>`);
    if (entry.id !== 'suspended') parts.push(textAt(x, y(ratio) - 9, ratio.toFixed(2), 'axis-label'));
  });
});

const output = new URL('droplet_boundary_comparison.svg', out);
await fs.writeFile(output, paperFigure(parts.join(''), 900, 430));
console.log(output.pathname);
