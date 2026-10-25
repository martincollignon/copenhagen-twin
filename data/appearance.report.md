# Appearance (M4 item 1) QA report

Occlusion mode: `dsm`; views: 92; ID-buffer scale 0.5; runtime 775.0 s.

## Coverage

- Walls with observed colour: **19350 / 33309 (58.1%)**
- Roofs with observed colour: **2415 / 2517 (95.9%)**
- Unseen walls filled (conf `inferred`): {'building': 12390, 'neighbours': 1569, 'preset': 0}
- Buildings with at least one observed wall: 2326 / 2517
- Observed share of wall area: 80.4%

## Distributions (observed walls)

- Viewing angle to wall normal (deg): [0.00,15.00):0 [15.00,30.00):0 [30.00,45.00):1430 [45.00,60.00):15714 [60.00,75.00):2025 [75.00,90.00):181
- Pixels per wall: [0.00,1.50):1579 [1.50,2.00):3145 [2.00,2.50):4283 [2.50,3.00):4292 [3.00,3.50):3642 [3.50,4.00):1881 [4.00,6.00):528 (log10)
- Shadow fraction: [0.00,0.10):5194 [0.10,0.25):1697 [0.25,0.50):1507 [0.50,0.75):876 [0.75,0.90):430 [0.90,1.01):9646
- Views agreeing within 0.09 sRGB: [1.00,2.00):9679 [2.00,3.00):6233 [3.00,4.00):2515 [4.00,6.00):739 [6.00,10.00):23 [10.00,100.00):0
- Shadow-corrected walls: 12446
- Mean occluded share of candidate pixels (selected views): 0.078
- Best view direction: {'south': 4606, 'west': 4843, 'east': 5015, 'nadir': 52, 'north': 4834}
- Wall colour classes: {'other': 2808, 'grey': 4569, 'dark grey': 846, 'white/light grey': 8089, 'beige/ochre/yellow': 1299, 'warm grey': 1587, 'red brick/brown': 152}
- Roof type hints: {'metal': 599, 'slate': 347, 'fibre-cement': 914, 'copper': 14, 'tagpap': 273, 'solar': 55, 'other': 174, 'green': 39}

## Occlusion modes compared

| mode | walls observed | roofs observed | mean occluded share | mean px/wall | runtime s |
|---|---|---|---|---|---|
| both | 19242/33309 | 2408/2517 | 0.076 | 1503.3 | 297.6 |
| colour | 19633/33309 | 2407/2517 | 0.0 | 1579.3 | 59.8 |
| dsm | 19350/33309 | 2415/2517 | 0.078 | 1495.3 | 775.0 |

## Textures

{'buildings': 2326, 'walls': 19350, 'mean_filled': 0.395, 'mb': 50.4}
