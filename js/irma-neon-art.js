// The 31 January 2015 Irma roofline, drawn as tube centre-lines in metres. Artwork proportions are photo estimates,
// not surveyed sign drawings. Reference: Commons File:Peblinge_Lake,_Nørrebro.jpg (see the realism photo attribution).
// The Ørma / organic wording is deliberately the 2015 variant, before the 2017–18 roof work.

const COLORS = {
  amber: 0xffac36, red: 0xff2818, green: 0x55ff95, blue: 0x467cff, white: 0xe5f4ff, cream: 0xffedb5
};

const path = (s) => s.trim().split(/\s+/).map((p) => p.split(',').map(Number));
const arc = (x, y, rx, ry, start = 0, end = Math.PI * 2, steps = 24) => Array.from({ length: steps + 1 }, (_, i) => {
  const a = start + (end - start) * i / steps;
  return [x + Math.cos(a) * rx, y + Math.sin(a) * ry];
});
const glyph = (width, ...lines) => ({ width, paths: lines.map((p) => typeof p === 'string' ? path(p) : p) });

// A single-stroke sign alphabet: open counters survive the view from across the lake, and every letter remains a
// bent tube in close views. The small phrases use the lower-case forms; the large coffee/egg words have slab serifs.
const FONT = {
  A: glyph(.78, '0,0 .39,1 .78,0', '.15,.38 .63,.38', '-.06,0 .18,0', '.6,0 .84,0'),
  E: glyph(.65, '.65,1 .06,1 .06,0 .65,0', '.06,.5 .51,.5'),
  F: glyph(.65, '.65,1 .06,1 .06,0', '.06,.52 .51,.52', '-.04,0 .23,0'),
  G: glyph(.76, arc(.38,.5,.36,.5,.24,Math.PI*1.83), '.74,.43 .45,.43'),
  I: glyph(.34, '0,1 .34,1', '.17,1 .17,0', '0,0 .34,0'),
  J: glyph(.63, '.14,1 .63,1', '.49,1 .49,.18 .41,.04 .26,0 .1,.04 0,.18'),
  K: glyph(.74, '.08,0 .08,1', '.72,1 .08,.42', '.32,.64 .76,0', '0,0 .23,0'),
  M: glyph(.94, '.04,0 .04,1 .47,.33 .9,1 .9,0', '-.04,0 .2,0', '.74,0 .98,0'),
  N: glyph(.8, '.05,0 .05,1 .75,0 .75,1'),
  O: glyph(.78, arc(.39,.5,.37,.5)),
  R: glyph(.76, '.06,0 .06,1 .46,1 .66,.93 .71,.78 .65,.62 .46,.54 .06,.54', '.43,.54 .77,0', '-.03,0 .22,0'),
  'Æ': glyph(1.08, '0,0 .45,1 .6,0', '.16,.38 .6,.38', '1.08,1 .6,1 .6,0 1.08,0', '.6,.5 1,.5'),
  'Ø': glyph(.78, arc(.39,.5,.37,.5), '-.04,-.06 .82,1.06'),
  '1': glyph(.45, '.06,.8 .28,1 .28,0', '.04,0 .45,0'),
  '2': glyph(.68, '0,.8 .07,.95 .24,1 .44,1 .61,.9 .65,.75 .57,.61 .03,0 .68,0'),
  '3': glyph(.68, '0,.88 .15,1 .44,1 .62,.88 .61,.67 .43,.52 .24,.52', '.43,.52 .65,.4 .65,.17 .48,0 .15,0 0,.12'),
  '5': glyph(.68, '.64,1 .06,1 .03,.56 .4,.58 .59,.49 .66,.3 .6,.1 .43,0 .15,0 0,.1'),
  a: glyph(.62, arc(.29,.36,.27,.35), '.57,.71 .57,0 .66,0'),
  c: glyph(.6, arc(.31,.36,.29,.35,.65,Math.PI*2-.65)),
  d: glyph(.63, arc(.29,.36,.27,.35), '.58,1.05 .58,0'),
  e: glyph(.61, '.04,.37 .59,.37 .56,.58 .43,.7 .23,.71 .06,.6 0,.4 .03,.17 .19,.03 .4,0 .58,.1'),
  f: glyph(.46, '.12,0 .12,.83 .19,1.02 .36,1.06 .48,.98', '0,.69 .42,.69'),
  g: glyph(.64, arc(.29,.36,.27,.35), '.58,.71 .58,-.17 .47,-.32 .25,-.35 .08,-.28'),
  h: glyph(.65, '.04,0 .04,1.05', '.04,.5 .17,.68 .37,.72 .55,.64 .61,.47 .61,0'),
  i: glyph(.18, '.09,0 .09,.7', '.09,.99 .09,1.04'),
  k: glyph(.62, '.04,0 .04,1.05', '.57,.72 .04,.26', '.27,.47 .63,0'),
  l: glyph(.24, '.08,1.05 .08,.1 .15,0 .26,.02'),
  m: glyph(1.02, '.03,0 .03,.7', '.03,.52 .16,.7 .32,.7 .45,.59 .49,.45 .49,0', '.49,.5 .63,.7 .8,.7 .94,.58 .99,.42 .99,0'),
  n: glyph(.65, '.03,0 .03,.7', '.03,.5 .18,.69 .39,.71 .57,.59 .61,.43 .61,0'),
  o: glyph(.64, arc(.32,.36,.3,.35)),
  r: glyph(.49, '.04,0 .04,.7', '.04,.46 .17,.66 .34,.72 .49,.66'),
  s: glyph(.55, '.53,.62 .38,.71 .18,.69 .04,.58 .06,.44 .23,.35 .43,.29 .52,.17 .45,.04 .25,0 .05,.08'),
  t: glyph(.44, '.14,1 .14,.16 .23,.02 .4,.02 .48,.08', '0,.69 .41,.69'),
  'ø': glyph(.64, arc(.32,.36,.3,.35), '-.03,-.06 .68,.79'),
  'å': glyph(.62, arc(.29,.36,.27,.35), '.57,.71 .57,0 .66,0', arc(.3,.98,.12,.12,0,Math.PI*2,12)),
  'æ': glyph(1.1, arc(.28,.36,.26,.35), '.54,.7 .54,0', '.54,.37 1.08,.37 1.04,.58 .9,.7 .72,.7 .57,.57', '.54,.27 .63,.08 .81,0 1.02,.07'),
  '.': glyph(.16, '.08,0 .08,.04'),
  ' ': glyph(.3)
};

function artist() {
  const strokes = [];
  const line = (points, color, { stage = 0, radius = .032 } = {}) => strokes.push({ points, color: COLORS[color], stage, radius });
  const text = (value, x, y, width, height, color, { slant = 0, radius = .032 } = {}) => {
    const letters = [...value].map((c) => FONT[c]);
    if (letters.some((g) => !g)) throw new Error(`Unsupported Irma sign lettering: ${value}`);
    const naturalWidth = letters.reduce((sum, g) => sum + g.width + .13, -.13);
    let cursor = 0;
    for (const g of letters) {
      for (const p of g.paths) line(p.map(([px, py]) => [x + (cursor + px) * width / naturalWidth + py * slant * height, y + py * height]), color, { radius });
      cursor += g.width + .13;
    }
  };
  return { strokes, line, text };
}

function deliverySign() {
  const a = artist();
  a.text('nemlig.com', .1, .3, 12.3, 2.1, 'amber', { slant: .12, radius: .046 });
  a.line(path('13,.25 13,1.9 13.35,2.3 16.2,2.3 17.35,1.38 17.8,.7 17.8,.3 16.9,.3'), 'white', { radius: .05 });
  a.line(path('16,.3 14.2,.3'), 'white', { radius: .05 });
  a.line(arc(13.7,.3,.37,.3), 'white');
  a.line(arc(16.5,.3,.37,.3), 'white');
  a.line(path('16.3,2.12 16.3,1.35 17.25,1.35'), 'white');
  return a.strokes;
}

function coffeeSigns() {
  const a = artist();
  // Calendar and freshness strip. The fixed date matches the supplied photograph.
  a.line(path('.2,0 .2,4.6 2.9,4.6 2.9,0 .2,0'), 'green');
  a.line(path('.45,.16 .45,4.4 2.67,4.4 2.67,.16 .45,.16'), 'red');
  a.text('31', .75, 1.85, 1.6, 2.05, 'cream');
  a.text('JAN', .66, .52, 1.75, .75, 'cream');
  a.text('datomærker for friskhed', 3.8, .5, 16.5, 1.3, 'green', { radius: .025 });
  a.line([[3.7,.14],[20.4,.14]], 'green', { radius: .023 });
  a.text('IRMA', 21.0, .35, 5.6, 1.65, 'red', { radius: .04 });

  // The blue checked coffee bag leans slightly, with separate white glass cross-lines.
  const bag = (p) => p.map(([x,y]) => [27.8 + x * 2.4 + y * .22, .55 + y * 4.05]);
  a.line(bag(path('0,0 -.1,.13 -.1,.87 .05,1 .78,1 1,.86 1,.1 .83,0 0,0')), 'blue', { radius: .05 });
  for (let r = 0; r <= 7; r++) a.line(bag([[.02,r/8+.05],[.88,r/8+.05]]), r % 2 ? 'white' : 'blue', { radius: .026 });
  for (let c = 0; c <= 4; c++) a.line(bag([[c/5+.02,.08],[c/5+.02,.94]]), 'white', { radius: .025 });
  a.text('KAFFE', 31.4, .35, 7.65, 1.75, 'amber', { radius: .04 });

  // The octagonal clock is larger than the nearby lettering and has no opaque luminous face.
  const cx = 42.25, cy = 2.65, r = 2.55;
  a.line(arc(cx,cy,r,r,Math.PI/8,Math.PI*2+Math.PI/8,8), 'green', { radius: .043 });
  a.line(arc(cx,cy,r*.88,r*.88,Math.PI/8,Math.PI*2+Math.PI/8,8), 'cream', { radius: .025 });
  for (let i=0;i<12;i++) {
    const t=i*Math.PI/6;
    a.line([[cx+Math.sin(t)*1.82,cy+Math.cos(t)*1.82],[cx+Math.sin(t)*2.12,cy+Math.cos(t)*2.12]], 'cream', { radius: .03 });
  }
  a.line([[cx,cy],[cx,cy+1.9]], 'cream', { radius: .045 });
  a.line([[cx,cy],[cx-1.24,cy+.72]], 'cream', { radius: .045 });

  // January 2015: the red Ø replaces the I, and the white line below is static.
  a.line(arc(49.1,3.05,.93,1.22), 'red', { radius: .046 });
  a.line([[48.05,1.7],[50.15,4.4]], 'red', { radius: .043 });
  a.text('rma', 50.25, 1.9, 5.2, 2.4, 'cream', { slant: .1, radius: .043 });
  a.text('Økologi i mere end 25 år', 46, .35, 13.2, 1.02, 'white', { radius: .024 });
  return a.strokes;
}

function henSigns() {
  const a = artist();
  const hen = path('.25,5.1 .55,4.75 1.15,4.1 2.05,3.65 3,3.55 3.8,3.8 4.15,4.4 4.22,5.2 4.48,5.6 4.9,5.65 5.2,5.4 5.13,5.08 4.86,4.83 4.6,4.7 4.48,3.7 4.12,2.8 3.48,2.35 2.6,2.12 1.7,2.2 1.05,2.65 .65,3.5 .25,5.1');
  a.line(hen, 'amber', { radius: .042 });
  a.line(path('.95,4.05 1.5,3.38 2.28,3.05 3.3,3.18 3.92,3.67'), 'amber', { radius: .038 });
  a.line(path('4.3,5.45 4.25,5.86 4.5,5.75 4.68,6.02 4.86,5.79 5.08,5.88 5.13,5.55'), 'red');
  a.line(path('5.1,5.28 5.58,5.14 5.09,5.02'), 'red');
  a.line(arc(4.85,5.38,.07,.07,0,Math.PI*2,8), 'white');
  a.line(path('3.1,2.3 2.9,1.72 3.5,1.72'), 'red');
  a.line(path('3.5,2.38 3.42,1.93 4.02,1.93'), 'red');
  for (const [x,y,color,stage] of [[1.75,1.78,'red',1],[1.05,.96,'green',2],[2.18,.3,'cream',3]]) {
    a.line(arc(x,y,.39,.52,-Math.PI/2,Math.PI*1.5,20), color, { stage, radius: .04 });
  }
  a.text('friske', 6.2, 4.65, 6.3, 1.3, 'green', { slant: .18, radius: .027 });
  a.text('ØKO', 6.0, 1.85, 9.25, 2.55, 'red', { radius: .047 });
  a.text('ÆG', 17.0, 1.85, 6.2, 2.25, 'green', { radius: .041 });
  return a.strokes;
}

export function irmaNeonArtwork() {
  return [
    { id: 'namely', buildingId: 'gdk:1064714136', edge: [[20.15,-542.06],[40.09,-571.87]], offset: 8.6, width: 18, height: 3, strokes: deliverySign(), tint: COLORS.amber },
    { id: 'irma-coffee', buildingId: 'gdk:1064713819', edge: [[40.09,-571.87],[73.3,-621.43]], offset: .15, width: 59.25, height: 5.3, strokes: coffeeSigns(), tint: COLORS.green },
    { id: 'irma-hen', buildingId: 'gdk:1064714438', edge: [[73.3,-621.43],[86.43,-641.41]], offset: .2, width: 23.2, height: 6.1, strokes: henSigns(), tint: COLORS.red }
  ];
}
