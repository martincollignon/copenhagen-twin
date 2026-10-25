"""Converter round trip on a tiny synthetic CityJSONSeq: a 10 x 6 m gabled house plus one inner step wall."""
import json
import math

import numpy as np
import pytest

import common
import convert

# Footprint ring in the local frame (x east, z south), CCW seen from above: edge 0 is the south wall.
RING = [0, 0, 10, 0, 10, -6, 0, -6]
GROUND, EAVE, RIDGE = 5.0, 9.0, 11.0


def en(p):
    x, y, z = p
    return (x + common.ORIGIN[0], common.ORIGIN[1] - z, y + common.ORIGIN[2])


def oriented(face_pts, outward):
    """Vertex order whose Newell normal points along `outward` (CityJSON faces are CCW seen from outside)."""
    pts = [np.asarray(p, float) for p in face_pts]
    n = convert.newell(np.asarray(pts))
    return face_pts if np.dot(n, outward) > 0 else face_pts[::-1]


def house(extra_inner_wall=True):
    A, B, C, D = (0, GROUND, 0), (10, GROUND, 0), (10, GROUND, -6), (0, GROUND, -6)
    a, b, c, d = (0, EAVE, 0), (10, EAVE, 0), (10, EAVE, -6), (0, EAVE, -6)
    r0, r1 = (0, RIDGE, -3), (10, RIDGE, -3)
    faces = [
        ("GroundSurface", [D, C, B, A], {}),
        ("WallSurface", [A, B, b, a], {"on_footprint_edge": True}, (0, 0, 1)),          # south (edge 0)
        ("WallSurface", [B, C, c, r1, b], {"on_footprint_edge": True}, (1, 0, 0)),      # east gable (edge 1)
        ("WallSurface", [C, D, d, c], {"on_footprint_edge": True}, (0, 0, -1)),         # north (edge 2)
        ("WallSurface", [D, A, a, r0, d], {"on_footprint_edge": True}, (-1, 0, 0)),     # west gable (edge 3)
        ("RoofSurface", [a, b, r1, r0], {}, (0, 1, 1)),
        ("RoofSurface", [d, c, r1, r0], {}, (0, 1, -1)),
    ]
    if extra_inner_wall:
        faces.append(("WallSurface", [(4, 7.0, -2), (6, 7.0, -2), (6, 8, -2), (4, 8, -2)], {"on_footprint_edge": False}, (0, 0, 1)))
    verts, vi, shell, types, surfaces, values = [], {}, [], [], [], []
    for f in faces:
        typ, pts, sem = f[0], f[1], f[2]
        if len(f) > 3:
            pts = oriented(pts, f[3])
        elif typ == "GroundSurface":
            pts = oriented(pts, (0, -1, 0))
        ring = []
        for p in pts:
            if p not in vi:
                vi[p] = len(verts)
                verts.append(en(p))
            ring.append(vi[p])
        shell.append([ring])
        surfaces.append({"type": typ, **sem})
        values.append(len(surfaces) - 1)
    t = [723900.0, 6176500.0, 0.0]
    tr = {"scale": [1e-4] * 3, "translate": t}
    iv = [[round((v[i] - t[i]) / 1e-4) for i in range(3)] for v in verts]
    feat = {"type": "CityJSONFeature", "id": "H1", "vertices": iv, "CityObjects": {
        "H1": {"type": "Building", "children": ["H1-0"], "attributes": {"rf_success": True, "rf_h_ground": GROUND + common.ORIGIN[2],
                                                                        "rf_roof_type": "slanted", "rf_extrusion_mode": "standard"}},
        "H1-0": {"type": "BuildingPart", "parents": ["H1"], "geometry": [{"type": "Solid", "lod": "2.2", "boundaries": [shell],
                                                                         "semantics": {"surfaces": surfaces, "values": [values]}}]}}}
    return tr, feat


def mesh_of(**kw):
    tr, feat = house(**kw)
    return convert.building_mesh(feat, "H1", convert.feature_vertices(tr, feat), {"ring": RING}), feat, tr


def tri_normals(m):
    p, t = m["pos"], m["tri"]
    n = np.cross(p[t[:, 1]] - p[t[:, 0]], p[t[:, 2]] - p[t[:, 0]])
    return n / np.linalg.norm(n, axis=1)[:, None]


def test_frame_and_kinds():
    m, _, _ = mesh_of()
    assert m["pos"][:, 1].min() >= GROUND - 1e-3 and m["pos"][:, 1].max() == pytest.approx(RIDGE, abs=1e-3)
    assert m["pos"][:, 0].min() == pytest.approx(0, abs=1e-3) and m["pos"][:, 0].max() == pytest.approx(10, abs=1e-3)
    assert m["pos"][:, 2].min() == pytest.approx(-6, abs=1e-3)  # north is -z
    assert set(m["kind"].tolist()) == {convert.ROOF, convert.WALL}
    assert not (m["kind"] == 2).any()  # ground faces are dropped


def test_roof_faces_up_and_walls_outward_with_cm_precision():
    m, _, _ = mesh_of(extra_inner_wall=False)
    n = tri_normals(m)
    roof = m["kind"] == convert.ROOF
    assert (n[roof, 1] > 0.5).all()
    # roof area = 2 * 10 * sqrt(3^2 + 2^2)
    area = 0.5 * np.linalg.norm(np.cross(m["pos"][m["tri"][roof, 1]] - m["pos"][m["tri"][roof, 0]], m["pos"][m["tri"][roof, 2]] - m["pos"][m["tri"][roof, 0]]), axis=1).sum()
    assert area == pytest.approx(2 * 10 * math.hypot(3, 2), rel=1e-6)
    cen = np.array([5.0, 8.0, -3.0])
    centres = m["pos"][m["tri"]].mean(axis=1)
    wall = m["kind"] == convert.WALL
    assert (((centres[wall] - cen) * n[wall]).sum(axis=1) > 0).all()


def test_edge_matching_and_inner_step():
    m, _, _ = mesh_of()
    walls = m["kind"] == convert.WALL
    by_edge = {e: int(((m["edge"] == e) & walls).sum()) for e in (-1, 0, 1, 2, 3)}
    assert by_edge[-1] == 2          # the inner step wall (a quad = 2 triangles) is not on any footprint edge
    assert by_edge[0] == 2 and by_edge[2] == 2     # south and north rectangles
    assert by_edge[1] == 3 and by_edge[3] == 3     # gable pentagons
    # eaves: lowest point of each outer wall above its foot
    assert m["top"] == [pytest.approx(EAVE, abs=1e-3)] * 4
    roofs = m["kind"] == convert.ROOF
    assert (m["edge"][roofs] == -1).all()


def test_matching_rejects_wrong_side_and_far_walls():
    tr, feat = house(extra_inner_wall=False)
    v = convert.feature_vertices(tr, feat)
    base = convert.building_mesh(feat, "H1", v, {"ring": RING})
    # footprint moved 1 m east: the long walls still overlap their edges by 9 of 10 m, the gable ends are 1 m off, and a
    # wall that stands on the ground but not on the footprint is dropped instead of drawn as a fin
    shifted = convert.building_mesh(feat, "H1", v, {"ring": [x + (1.0 if i % 2 == 0 else 0) for i, x in enumerate(RING)]})
    assert shifted["dropped_ground_walls"] == 2 and base["dropped_ground_walls"] == 0
    assert (shifted["kind"] == convert.WALL).sum() == (base["kind"] == convert.WALL).sum() - 6
    # a footprint wound the other way (outward normal flipped) never matches: every outer wall is dropped
    flipped = convert.building_mesh(feat, "H1", v, {"ring": [c for xz in reversed(list(zip(RING[0::2], RING[1::2]))) for c in xz]})
    assert not (flipped["kind"] == convert.WALL).any()


def test_pack_unpack_round_trip():
    m, _, _ = mesh_of()
    rec = convert.pack_record(m)
    assert len(rec) % 4 == 0
    r = convert.unpack_record(rec)
    assert len(r["tri"]) == len(m["tri"])
    assert r["kind"].tolist() == m["kind"].tolist() and r["edge"].tolist() == m["edge"].tolist()
    assert r["top"] == [pytest.approx(EAVE, abs=0.01)] * 4
    # same triangles up to the 1 cm quantisation, in order
    a, b = m["pos"][m["tri"]], r["pos"][r["tri"]]
    assert np.abs(a - b).max() <= 0.0051 + 1e-9
    # welding: the 12 distinct corner points of the 6-face house plus the inner wall
    assert len(r["pos"]) <= 16


def test_closed_shell_flag():
    m, _, _ = mesh_of(extra_inner_wall=False)
    assert m["closed"] is True
    m2, _, _ = mesh_of(extra_inner_wall=True)
    assert m2["closed"] is False  # a floating wall breaks edge-manifoldness


def test_face_with_hole_is_triangulated_around_it():
    outer = np.array([[0, 0, 0], [10, 0, 0], [10, 0, -10], [0, 0, -10]], float)
    hole = np.array([[4, 0, -4], [4, 0, -6], [6, 0, -6], [6, 0, -4]], float)
    pts, tris, normal = convert.triangulate_face([outer[::-1][::-1], hole])
    area = 0.5 * np.linalg.norm(np.cross(pts[tris[:, 1]] - pts[tris[:, 0]], pts[tris[:, 2]] - pts[tris[:, 0]]), axis=1).sum()
    assert area == pytest.approx(100 - 4)


def test_gate():
    ok = {"rf_success": True, "rf_roof_type": "slanted", "rf_extrusion_mode": "standard", "rf_pt_density_punktsky": 12.0, "rf_nodata_frac_punktsky": 0.05}
    assert convert.gate(ok, False) == ("measured", None)
    assert convert.gate(ok, True)[0] == "inferred"
    assert convert.gate({**ok, "rf_nodata_frac_punktsky": 0.5}, False)[0] == "inferred"
    assert convert.gate({**ok, "rf_pt_density_punktsky": 2.0}, False)[0] == "inferred"
    assert convert.gate({**ok, "rf_success": False}, False)[0] == "inferred"
    assert convert.gate({**ok, "rf_extrusion_mode": "skip"}, False)[0] == "inferred"


def test_convert_tile_writes_bin_and_index(tmp_path):
    tr, feat = house()
    work = tmp_path / "work"
    (work / "out").mkdir(parents=True)
    meta = {"type": "CityJSON", "transform": tr, "vertices": [], "CityObjects": {}}
    (work / "out" / "t.city.jsonl").write_text(json.dumps(meta) + "\n" + json.dumps(feat) + "\n")
    (work / "manifest.json").write_text(json.dumps({"tile": "6176_723", "scan": {"scan_date": "2019-04-07"},
                                                    "buildings": {"gdk:H1": {"post_scan": False}}}))
    out = tmp_path / "out"
    r = convert.convert_tile("6176_723", {"gdk:H1": {"id": "gdk:H1", "ring": RING}}, out, work)
    rec = r["index"]["gdk:H1"]
    assert rec["conf"] == "measured" and rec["scan_date"] == "2019-04-07" and rec["offset"] == 0
    blob = (out / "6176_723.bin").read_bytes()
    assert rec["length"] == len(blob)
    assert len(convert.unpack_record(blob)["tri"]) > 8
    # a post-scan building gets no mesh but an inferred index entry
    (work / "manifest.json").write_text(json.dumps({"tile": "6176_723", "scan": {"scan_date": "2019-04-07"},
                                                    "buildings": {"gdk:H1": {"post_scan": True}}}))
    r2 = convert.convert_tile("6176_723", {"gdk:H1": {"id": "gdk:H1", "ring": RING}}, out, work)
    assert r2["index"]["gdk:H1"]["conf"] == "inferred" and "offset" not in r2["index"]["gdk:H1"]
