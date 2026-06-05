import { tokenize } from '../src/parser/lexer.js';
import { parse } from '../src/parser/parser.js';
import { bind } from '../src/bind/bind.js';
import { place } from '../src/layout/place.js';
import { applyTextFit } from '../src/layout/text-fit.js';
import { reserveCorridors } from '../src/layout/corridors.js';
import { packTracks } from '../src/layout/tracks.js';
import { buildPolylines } from '../src/layout/polyline.js';
import { loadTheme } from '../src/theme/theme.js';
import { readFileSync } from 'node:fs';
import { findBendCenters } from '../src/render/svg.js';

// quick polyline access
function findBends(points: {x:number,y:number}[]) {
  const out: {centre:{x:number,y:number}, ih: boolean, oh: boolean}[] = [];
  let i = 1;
  while (i < points.length) {
    const p = points[i-1]!, c = points[i]!;
    const dx = c.x - p.x, dy = c.y - p.y;
    if (dx !== 0 && dy !== 0) {
      let j = i;
      const sx = Math.sign(dx), sy = Math.sign(dy);
      while (j+1 < points.length) {
        const a = points[j]!, b = points[j+1]!;
        const ddx = b.x-a.x, ddy = b.y-a.y;
        if (ddx !== 0 && ddy !== 0 && Math.sign(ddx) === sx && Math.sign(ddy) === sy) j++;
        else break;
      }
      if (j+1 < points.length) {
        const start = p, end = points[j]!;
        const prev = i >= 2 ? points[i-2]! : start;
        const next = j+1 < points.length ? points[j+1]! : end;
        const ih = start.y === prev.y && start.x !== prev.x;
        const oh = end.y === next.y && end.x !== next.x;
        out.push({centre: {x:(start.x+end.x)/2, y:(start.y+end.y)/2}, ih, oh});
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

const file = process.argv[2] || 'examples/18-highway-tb.melk';
const src = readFileSync(file, 'utf8');
const m = bind(parse(tokenize(src)));
const p = applyTextFit(place(m), m, loadTheme('document-light'));
const r = reserveCorridors(m, p);
const t = packTracks(m, p, r);
const polys = buildPolylines(m, p, r, t);
const bendsOf = polys.polylines.map(poly => ({ edge: m.edges[poly.edgeIndex], bends: findBends(poly.points) }));
for (let i = 0; i < bendsOf.length; i++) {
  for (const b of bendsOf[i]!.bends) {
    console.log(`  ${bendsOf[i]!.edge?.from}->${bendsOf[i]!.edge?.to} bend at (${b.centre.x},${b.centre.y}) ih=${b.ih} oh=${b.oh}`);
  }
}
console.log('---matches:');
for (let i = 0; i < bendsOf.length; i++) {
  for (let j = i+1; j < bendsOf.length; j++) {
    for (const bi of bendsOf[i]!.bends) {
      for (const bj of bendsOf[j]!.bends) {
        if (bi.ih !== bj.ih || bi.oh !== bj.oh) continue;
        const dy = Math.abs(bj.centre.y - bi.centre.y);
        const dx = Math.abs(bj.centre.x - bi.centre.x);
        const parallelOffset = bi.ih ? dy : dx;
        const alongAxisDist = bi.ih ? dx : dy;
        if (parallelOffset > 8) continue;
        if (alongAxisDist > 12) continue;
        if (parallelOffset < 0.5 && alongAxisDist < 0.5) continue;
        console.log(`  MATCH ${bendsOf[i]!.edge?.from}->${bendsOf[i]!.edge?.to} @(${bi.centre.x},${bi.centre.y}) <-> ${bendsOf[j]!.edge?.from}->${bendsOf[j]!.edge?.to} @(${bj.centre.x},${bj.centre.y}) parallelOff=${parallelOffset} along=${alongAxisDist}`);
      }
    }
  }
}
