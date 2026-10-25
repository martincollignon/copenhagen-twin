# Facade colour calibration (appearance-cal/1)

`tools/cph-geodata/appearance_calibrate.py` adds `tone_cal` (plus `cal` route and `cal_brick`) to every `buildings[].observed.walls[]`
entry of `data/cph-geodata.json`; `tone`/`tone_raw` are untouched. The engine (`js/appearance.js`) uses `tone_cal` when present
(`?debug=nocal` shows the raw tones) and turns the observed tone into an albedo (x0.72 with a soft shoulder, so photo exposure is
not lit a second time by the engine sun).

Mean OKLab lightness L and chroma C of observed walls (tone -> tone_cal):

| group | walls | L before | C before | L after | C after |
|---|---|---|---|---|---|
| all | 21335 | 0.726 | 0.0173 | 0.737 | 0.034 |
| sunlit | 9779 | 0.804 | 0.0123 | 0.747 | 0.0281 |
| shadow | 11556 | 0.659 | 0.0215 | 0.729 | 0.039 |
| brick | 15743 | 0.747 | 0.0172 | 0.752 | 0.0337 |

Routes: {'own': 10369, 'neighbours': 1187, 'global': 0, 'none': 9779}; pinkish brick walls turned red-brown or yellow brick: 2517.
Global transfer (fallback): L' = 0.4875 + 0.4555 L, ab shift [-0.0009, 0.0087] (fitted on 1715 buildings with both sunlit and shadow walls).

Findings: shadow-sourced walls are darker (L 0.66 vs 0.80) and carry a blue/purple cast (hue 260-320 deg is the commonest hue among
their coloured walls), not lower chroma; the sunlit walls are nearly neutral (C 0.012), so the whole city reads washed out.
The per-wall record only keeps the chosen view, so the sunlit-2023 vs shadow-2025 same-wall pairs are not recoverable: the
transfer is fitted on same-building sunlit/shadow wall sets instead. Colours are not calibrated albedo samples (docs/research/visual-refs.md, section 11).
