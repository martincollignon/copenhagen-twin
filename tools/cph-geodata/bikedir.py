"""Traffic direction for cars and bicycles from OSM tags (pure functions, no geometry).

Everything is returned in the frame of the road's compiled `pts`: roads.py re-orients `oneway=-1` ways so that `pts` run
with the traffic, which makes car direction `fwd` or `both` and swaps left/right (and fwd/back) for such ways. Copenhagen is
right-hand traffic: on a two-way street the right-hand cycle track runs with the pts (`fwd`), the left-hand one against
them (`back`); on a one-way street both sides run with the cars unless tagged otherwise (a contraflow lane or track).
"""
from __future__ import annotations

FWD, BACK, BOTH, NONE = "fwd", "back", "both", "none"
_FLIP = {FWD: BACK, BACK: FWD}
SIDE_KIND = {
    "track": "track", "lane": "lane", "shared_lane": "shared", "share_busway": "shared", "separate": "sidepath",
    "opposite_track": "track", "opposite_lane": "lane", "opposite": "shared", "sidepath": "sidepath",
}
OPPOSITE = {"opposite", "opposite_lane", "opposite_track"}
BAN = {"no", "use_sidepath", "dismount"}
_ONEWAY_VAL = {"yes": FWD, "true": FWD, "1": FWD, "-1": BACK, "no": BOTH, "false": BOTH, "0": BOTH}
_KIND_RANK = {"track": 3, "lane": 2, "shared": 1, "sidepath": 3}


def flip(d: str) -> str:
    return _FLIP.get(d, d)


def car_direction(ow: int) -> str:
    """Original-frame car direction of a way from parse_oneway() (0 two-way, 1 with the way, -1 against it)."""
    return BOTH if ow == 0 else (FWD if ow > 0 else BACK)


def _side_value(tags: dict, side: str):
    for k in (f"cycleway:{side}", "cycleway:both", "cycleway"):
        v = tags.get(k)
        if v is not None:
            return v
    return None


def _side_oneway(tags: dict, side: str):
    for k in (f"cycleway:{side}:oneway", "cycleway:both:oneway", "cycleway:oneway"):
        v = tags.get(k)
        if v in _ONEWAY_VAL:
            return _ONEWAY_VAL[v]
    return None


def osm_sides(tags: dict) -> dict:
    """Original frame: {left|right: {kind, dir, explicit}} for the sides with a cycle lane or track. `cycleway=opposite`
    on its own is a contraflow permission without any infrastructure, so it yields no side."""
    out = {}
    for side in ("left", "right"):
        v = _side_value(tags, side)
        kind = SIDE_KIND.get(v)
        if kind is None or v == "opposite":
            continue
        out[side] = {"kind": kind, "dir": _side_oneway(tags, side), "opposite": v in OPPOSITE}
    return out


def default_side_dir(side: str, car: str) -> str:
    """The direction a cycle track on `side` is ridden in unless tagged otherwise (right-hand traffic)."""
    if car in (FWD, BACK):
        return car
    return FWD if side == "right" else BACK


def contra_of(car: str) -> str:
    return flip(car) if car in (FWD, BACK) else BOTH


def parse_bike(tags: dict, cls: str, ow: int, carriageway: bool = True, extra_sides: dict | None = None) -> dict:
    """Bicycle/car direction of one OSM way, in the compiled-pts frame.

    ow            parse_oneway(tags): 0 two-way, 1 with the way, -1 against it (pts are flipped then).
    carriageway   False for cycleway/footway classes, which have no cars.
    extra_sides   {left|right: kind} cycle infrastructure known from elsewhere (KK cykelsti), given in the pts frame;
                  sides OSM does not tag get the default direction, flagged inferred.

    Returns {carDir, left, right, leftKind, rightKind, carriageway, contraflow, contraKind, sidepath, ban, explicit}
    with left/right/carriageway in {fwd, back, both, none}.
    """
    car = car_direction(ow)
    sides = osm_sides(tags) if carriageway else {}
    explicit = False
    resolved = {}  # original frame
    for side, rec in sides.items():
        d = rec["dir"]
        if d is not None:
            explicit = True
        elif rec["opposite"] and car in (FWD, BACK):
            d, explicit = contra_of(car), True
        else:
            d = default_side_dir(side, car)
        resolved[side] = {"kind": rec["kind"], "dir": d}
    # to the pts frame
    swap = ow == -1
    out_sides = {}
    for side, rec in resolved.items():
        s = ("right" if side == "left" else "left") if swap else side
        out_sides[s] = {"kind": rec["kind"], "dir": flip(rec["dir"]) if swap else rec["dir"]}
    car_pts = BOTH if car == BOTH else FWD
    inferred = False
    for side, kind in (extra_sides or {}).items():
        if side not in out_sides:
            out_sides[side] = {"kind": kind, "dir": default_side_dir(side, car_pts)}
            inferred = True

    # who may ride on the carriageway
    cw = car_pts
    if not carriageway:
        cw = _ONEWAY_VAL.get(tags.get("oneway", "no"), BOTH)
        cw = BOTH if cw in (BOTH, None) else FWD
        if tags.get("oneway") == "-1":
            cw = FWD  # pts were flipped
        if tags.get("bicycle") in ("no",) and tags.get("highway") in ("footway", "pedestrian", "path"):
            cw = NONE
    ob = tags.get("oneway:bicycle")
    if carriageway and ob is not None:
        explicit = True
        if ob in ("no", "false", "0"):
            cw = BOTH
        elif ob in ("yes", "true", "1"):
            cw = FWD if cw != BACK else BACK
        elif ob == "-1":
            cw = BACK if not swap else FWD
    if carriageway and cw == BOTH:
        if tags.get("bicycle:forward") == "no":
            cw = BACK if not swap else FWD
        elif tags.get("bicycle:backward") == "no":
            cw = FWD if not swap else BACK
    if carriageway and car_pts == FWD and any(tags.get(k) == "opposite" for k in ("cycleway", "cycleway:both", "cycleway:left", "cycleway:right")):
        cw, explicit = BOTH, True
    ban = carriageway and tags.get("bicycle") in BAN
    side_contra = [r for r in out_sides.values() if car_pts == FWD and r["dir"] in (BACK, BOTH)]
    contraflow = bool(car_pts == FWD and (cw in (BOTH, BACK) or side_contra))
    if contraflow and cw != NONE:
        cw = BOTH  # bicycles may travel both ways along the street (on its contraflow lane/track or the carriageway)
    contra_kind = None
    if contraflow:
        kinds = [r["kind"] for r in side_contra if r["kind"] != "sidepath"] or ["shared"]
        contra_kind = max(kinds, key=lambda k: _KIND_RANK.get(k, 0))
    sidepath = [s for s, r in out_sides.items() if r["kind"] == "sidepath"]
    return {
        "carDir": car_pts if carriageway else NONE,
        "left": out_sides.get("left", {}).get("dir", NONE),
        "right": out_sides.get("right", {}).get("dir", NONE),
        "leftKind": out_sides.get("left", {}).get("kind"),
        "rightKind": out_sides.get("right", {}).get("kind"),
        "carriageway": NONE if ban else cw,
        "contraflow": contraflow and not ban,
        "contraKind": None if ban else contra_kind,
        "sidepath": None if not sidepath else (BOTH if len(sidepath) == 2 else sidepath[0]),
        "ban": bool(ban),
        "explicit": explicit,
        "inferred": inferred,
        "_noContra": ob in ("yes", "true", "1"),
    }


def cycle_track_side_set(b: dict) -> set[str]:
    """The sides (pts frame) that carry a cycle lane/track (what the `cycleTrack` field means)."""
    return {s for s in ("left", "right") if b[s] != NONE}


def add_kk_contraflow(b: dict, kk_flag) -> str | None:
    """Merge the KK `cykling_mod_ensretning` flag (True / False / None = no KK street here) into a parse_bike() result.
    KK is the municipal legal record: it grants contraflow on a one-way street unless OSM says `oneway:bicycle=yes` or bans
    bicycles. Returns "granted" (KK added the contraflow), "agree", "conflict" (the sources disagree; OSM kept for an
    explicit OSM tag, KK for an untagged one) or None."""
    if b["carDir"] != FWD or kk_flag is None:
        return None
    if kk_flag is True:
        if b["contraflow"]:
            return "agree"
        if b["ban"] or b["_noContra"]:
            return "conflict"
        b["contraflow"], b["contraKind"] = True, "shared"
        b["carriageway"] = BOTH
        return "granted"
    return "conflict" if b["contraflow"] else "agree"
