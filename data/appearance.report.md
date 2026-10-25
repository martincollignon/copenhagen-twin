# Appearance (M4) QA report - v2 (sunlit-view selection, shadow white balance, brick prior)

Occlusion mode: `dsm`; views: 283 (2025 + 2023 collections); ID-buffer scale 0.5; runtime 1131.5 s.

## Before / after (v1 = 2025 only, luminance boost; v2 = this run)

| metric | v1 | v2 |
|---|---|---|
| walls with observed colour | 19350/33309 (58.1%) | 21335/33309 (64.1%) |
| observed walls sourced from a sunlit view | 6904 (35.7% of observed; 20.7% of all walls) | 9779 (45.8% of observed; 29.4% of all walls) |
| observed walls sourced from shadow only | 12446 | 11556 (white-balanced) |
| mean saturation, shadow-sourced walls | 0.095 | 0.126 |
| mean blue-minus-red (sRGB), shadow-sourced walls | -0.011 | +0.017 |
| mean saturation, sunlit-sourced walls (reference) | 0.055 | 0.064 |
| walls classed red brick/brown | 152 | 280 |
| walls of BBR `mursten` buildings with brick hue | 55/14498 | 346/15743 |

Same 12446 walls that v1 had to take from shadow: mean saturation 0.095 (v1) -> 0.111 (v2); 2446 of them are now sourced from a sunlit view, 10000 remain shadow-sourced (2 lost their observation).

## Coverage

- Walls with observed colour: **21335 / 33309 (64.1%)**
- Roofs with observed colour: **2457 / 2517 (97.6%)**
- Unseen walls filled (conf `inferred`): {'building': 10793, 'neighbours': 1181, 'preset': 0}
- Buildings with at least one observed wall: 2386 / 2517
- Observed share of wall area: 82.2%
- Observed walls by source year: {2025: 15293, 2023: 6042}
- Flags: {'year_disagree': 2289} (`year_disagree` = sunlit 2023 and 2025 colours differ strongly: kept 2025, flagged as probably repainted)
- Brick prior applied (conf `observed+prior`): 401 walls

## Lighting calibration (per view, from lit/shadow pixels of the same surface)

- Estimate source per view: {'view': 184, 'flight': 95, 'collection': 4}
- 2023: median shadow->lit gain G = 2.13; median wall skylight cast k (r,g,b; lum=1) = [1.0, 0.99, 1.06]; median pairs/view = 13
- 2025: median shadow->lit gain G = 2.32; median wall skylight cast k (r,g,b; lum=1) = [1.02, 0.99, 1.0]; median pairs/view = 34

## Distributions (observed walls)

- Viewing angle to wall normal (deg): [0.00,15.00):0 [15.00,30.00):0 [30.00,45.00):2028 [45.00,60.00):16816 [60.00,75.00):2072 [75.00,90.00):419
- Pixels per wall: [0.00,1.50):1692 [1.50,2.00):3206 [2.00,2.50):4175 [2.50,3.00):4671 [3.00,3.50):4102 [3.50,4.00):2399 [4.00,6.00):1090 (log10)
- Shadow fraction of chosen views: [0.00,0.10):5935 [0.10,0.25):1835 [0.25,0.50):1562 [0.50,0.75):837 [0.75,0.90):548 [0.90,1.01):10618
- Views agreeing within 0.09 sRGB: [1.00,2.00):8365 [2.00,3.00):6181 [3.00,4.00):3514 [4.00,6.00):2523 [6.00,10.00):564 [10.00,100.00):8
- Mean occluded share of candidate pixels (selected views): 0.081
- Best view direction: {'east': 5305, 'north': 5374, 'south': 5243, 'nadir': 236, 'west': 5177}
- Wall colour classes: {'white/light grey': 9088, 'other': 5301, 'grey': 3909, 'warm grey': 1199, 'beige/ochre/yellow': 970, 'red brick/brown': 280, 'dark grey': 588}
- Roof type hints: {'metal': 617, 'slate': 374, 'fibre-cement': 890, 'copper': 20, 'tagpap': 288, 'other': 201, 'green': 42, 'solar': 23, 'tile': 2}
- Pitched roofs (DSM ridge - eave > 1.5 m): 426 flagged, 406 observed, sampled on the DSM surface; best view nadir for 268, oblique for 138

## Textures

{'buildings': 2386, 'walls': 21333, 'mean_filled': 0.402, 'median_filled': 0.358, 'sunlit_sourced': 9779, 'mb': 56.6}
