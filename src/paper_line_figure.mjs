// All drawing coordinates use the same 930-unit width at the final manuscript size.
export const palette = {
  blue: '#225e85', orange: '#b44e26', green: '#237466', ink: '#25313a',
  purple: '#594b85', ochre: '#857029', rose: '#a54165'
};

const style = `
text { font-family: Arial, Helvetica, sans-serif; fill: #20262b }
.panel-letter { font-size: 20px; font-weight: bold }
.panel-title { font-size: 16px }
.axis-label { font-size: 15px }
.tick, .key, .curve-label { font-size: 14px }
.subscript { font-size: 10.5px }
.axis { stroke: #424950; stroke-width: 1.15 }
.guide { stroke: #d9dee1; stroke-width: 0.7 }
.series { fill: none; stroke-width: 2.1; stroke-linecap: round; stroke-linejoin: round }`;

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const line = (x1,y1,x2,y2,attrs) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${attrs}/>`;
export function textAt(x, y, value, cls, anchor = 'middle', color) {
  const fill = color ? ` style="fill:${color}"` : '';
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" class="${cls}"${fill}>${escape(value)}</text>`;
}
export const verticalLabel = (x,y,value) =>
  `<g transform="translate(${x} ${y}) rotate(-90)">${textAt(0,0,value,'axis-label')}</g>`;
export function heading(x, y, letter, title) {
  return textAt(x, y, letter, 'panel-letter', 'start') + textAt(x + 23, y, title, 'panel-title', 'start');
}

export function panel({left, right, top, bottom, xRange, yRange, xTicks, yTicks,
  logX = false, showX = true, showY = true, yGuides = [], formatX = String, formatY = String}) {
  const scale = logX ? Math.log10 : v => v;
  const x = v => left + (right-left)*(scale(v)-scale(xRange[0]))/(scale(xRange[1])-scale(xRange[0]));
  const y = v => bottom - (bottom-top)*(v-yRange[0])/(yRange[1]-yRange[0]);
  const parts = yGuides.map(v => line(left, y(v), right, y(v), 'class="guide"'));
  parts.push(line(left,top,left,bottom,'class="axis"'),line(left,bottom,right,bottom,'class="axis"'));
  for (const v of yTicks) {
    parts.push(line(left-4,y(v),left,y(v),'class="axis"'));
    if (showY) parts.push(textAt(left-8,y(v)+4.5,formatY(v),'tick','end'));
  }
  for (const v of xTicks) {
    const tick = formatX(v);
    parts.push(line(x(v),bottom,x(v),bottom+(tick ? 4 : 2.3),'class="axis"'));
    if (showX && tick) parts.push(textAt(x(v),bottom+20,tick,'tick'));
  }
  return { x, y, body: parts.join('') };
}

function marker(x, y, shape, color, open) {
  const attrs = `fill="${open ? 'white' : color}" stroke="${color}" stroke-width="1.25"`;
  if (shape === 'circle') return `<circle cx="${x}" cy="${y}" r="2.7" ${attrs}/>`;
  const paths = {
    square: 'M-2.5,-2.5h5v5h-5z', diamond: 'M0,-3.4l3.4,3.4L0,3.4l-3.4,-3.4z',
    up: 'M0,-3.4l3,5.6h-6z', down: 'M0,3.4l3,-5.6h-6z', cross: 'M-2.5,-2.5l5,5m0,-5l-5,5'
  };
  return `<path transform="translate(${x} ${y})" d="${paths[shape]}" ${shape==='cross' ? `fill="none" stroke="${color}" stroke-width="1.75"` : attrs}/>`;
}
export function series(points, color, dashed = false, shape) {
  const coords = points.map(p=>p.join(',')).join(' ');
  const curve = `<polyline points="${coords}" class="series" stroke="${color}"${dashed ? ' stroke-dasharray="6 4"' : ''}/>`;
  return shape ? curve + points.map(([x,y])=>marker(x,y,shape,color,dashed)).join('') : curve;
}

export function diameterKey(y, holes, styles) {
  const gap = 69, itemWidth = 51, headingWidth = 144;
  const start = (930 - (headingWidth + (holes.length-1)*gap + itemWidth))/2;
  const items = [textAt(start,y+4.5,'Hole diameter (mm)','key','start')];
  holes.forEach((h,i) => {
    const x = start + headingWidth + i*gap, {color,shape} = styles[h];
    items.push(marker(x,y,shape,color,false),textAt(x+11,y+4.5,h,'key','start'));
  });
  return items.join('');
}

export function lineFigure(content, width, height) {
  const viewHeight = 930 * height / width;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 930 ${viewHeight}">
<rect width="930" height="${viewHeight}" fill="white"/><style>${style}</style>${content}</svg>`;
}
