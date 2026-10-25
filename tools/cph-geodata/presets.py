"""Data-driven facade presets. Everything produced here is conf="inferred"."""
from __future__ import annotations

# (name, window_w, bay_w, ground_floor_h, ground_type_default)
PRESETS = {
    "pre-1870": dict(window_w=1.0, bay_w=2.6, ground_floor_h=3.4),
    "karre-1900": dict(window_w=1.15, bay_w=2.9, ground_floor_h=3.6),
    "funk-brick-1945": dict(window_w=1.3, bay_w=3.4, ground_floor_h=3.0),
    "slab-1960s": dict(window_w=1.6, bay_w=3.6, ground_floor_h=2.9),
    "modern-2000": dict(window_w=1.8, bay_w=4.2, ground_floor_h=3.4),
    "outbuilding": dict(window_w=0.9, bay_w=6.0, ground_floor_h=2.6),
    "commercial-box": dict(window_w=2.0, bay_w=5.0, ground_floor_h=3.8),
    "other": dict(window_w=1.3, bay_w=3.6, ground_floor_h=3.0),
}

# Wall tone (linear-ish sRGB 0..1) from BBR ydervaeggensmateriale text.
TONES = {
    "mursten": [0.62, 0.36, 0.27],
    "letbetonsten": [0.74, 0.72, 0.68],
    "fibercement": [0.70, 0.69, 0.66],
    "bindingsværk": [0.55, 0.42, 0.30],
    "træ": [0.50, 0.38, 0.26],
    "betonelementer": [0.66, 0.65, 0.63],
    "metal": [0.62, 0.64, 0.66],
    "glas": [0.55, 0.65, 0.70],
    "andet materiale": [0.72, 0.68, 0.60],
}
DEFAULT_TONE = [0.72, 0.66, 0.58]


def use_class(use: int | None) -> str:
    """Coarse class from BBR byg021 code."""
    if use is None:
        return "unknown"
    if 900 <= use < 1000 or use in (190, 510, 530, 540):  # garage/carport/udhus/summer-house outbuildings
        return "outbuilding"
    if 110 <= use < 200:
        return "residential"
    if 200 <= use < 300:
        return "industry"
    if 300 <= use < 400:
        return "commercial"
    if 400 <= use < 500:
        return "institution"
    return "other"


def select_preset(use: int | None, year: int | None, wall: str | None) -> str:
    uc = use_class(use)
    if uc == "outbuilding" or (use is None and year is None):
        return "outbuilding"
    if uc in ("commercial", "industry") and (year is None or year >= 1960):
        return "commercial-box"
    if year is None:
        return "other"
    if 1870 <= year <= 1915:
        return "karre-1900"
    if year < 1870:
        return "pre-1870"
    if 1916 <= year <= 1959:  # brick-clad interwar / functionalist period
        return "funk-brick-1945"
    if 1960 <= year <= 1989:
        return "slab-1960s"
    if year >= 1990:
        return "modern-2000"
    return "other"


def tone_for(wall: str | None) -> list[float]:
    if not wall:
        return list(DEFAULT_TONE)
    return list(TONES.get(wall.strip().lower(), DEFAULT_TONE))


def ground_type(use: int | None, commercial_units: int | None, preset: str) -> str:
    uc = use_class(use)
    if uc == "outbuilding":
        return "blank"
    if uc == "commercial" or (commercial_units or 0) > 0:
        return "shop" if preset in ("pre-1870", "karre-1900", "funk-brick-1945", "commercial-box", "other") else "entrance"
    if uc == "residential":
        return "residential"
    return "entrance"


def facade_for(use, year, wall, eave_above_ground, storeys, commercial_units=None) -> dict:
    preset = select_preset(use, year, wall)
    p = PRESETS[preset]
    n = max(1, storeys or 1)
    floor_h = min(3.6, max(2.6, (eave_above_ground or 3.0 * n) / n))
    gf = max(p["ground_floor_h"], floor_h) if n > 1 else floor_h
    return {
        "preset": preset,
        "floor_h": round(floor_h, 2),
        "ground_floor_h": round(min(gf, 4.2), 2),
        "window_w": p["window_w"],
        "bay_w": p["bay_w"],
        "ground_type": ground_type(use, commercial_units, preset),
        "tone": tone_for(wall),
    }
