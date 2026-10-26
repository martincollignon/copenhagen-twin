# Realism backlog (after the 26 Oct 2026 Codex Astra pass)

Done on `mc/realism-integrate` (research in this folder; screenshots in `docs/realism-*`, `docs/kerbs`):
kerb clipping, Danish cyclists and parked bikes, road paint widths, slate glass igloo, NOAA sun position and date/time,
overcast/AgX/haze, olive Søerne water, road wetness, facade details on main's photo walls (no AC units, T-windows,
reveals, trim, chimneys, night interiors, roofs), modern European cars with Danish plates, yellow Movia buses,
LiDAR/CIR tree crowns + 644 trees, date-driven autumn.

Next, ranked by look per effort (sources: buildings.md, street-life.md, nature-light.md, ortho-cir.md):

1. Sun halo/Mie lobe still too large at low October sun (`js/lighting.js`, sky); midday view from Dronning Louises Bro.
2. Side-street edge-line paint runs into the through road (same trim as the kerb fix, for paint, `js/road-surfaces-cph.js`).
3. Dronning Louises Bro / Nørre Farimagsgade halves overlap (streets.py narrows both to 1.4 m half-width); needs `kk_vejkant.json` re-fetch.
4. Traffic signs (none yet): D 21, E 19, C 19, C 55 "40", E 33 — street-life.md item 8.
5. Lake life: swans, coots, Apr–Sep swan pedalos, fountain — nature-light.md item 10.
6. Pedestrians: darker seasonal palette, prams, dogs, bags; seated crowds on the bridge — street-life.md items 9–10.
7. Street-name plates, house numbers, shop signs, graffiti below 2.5 m; the protected Irma/Sortedam neon signs — buildings.md items 8–9.
8. Green roofs from CIR (10 sedum roofs flagged not-green); lake colour from ortho into `cph-lakes.json` — ortho-cir.md.
9. GTAO (behind `?ao=1`) measured and enabled if < 2 ms; TRAA; colour LUTs fitted to refs/nature.
10. Café spill-out on Blågårdsgade/Ravnsborggade from OSM frontages; bridge bike counter (confirm it still exists).
11. Dormers on pitched roofs (deferred by the facade port).
