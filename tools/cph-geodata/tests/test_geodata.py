"""Offline unit tests: frame transform, ring orientation, road-graph node dedup, preset selection."""
import math

import frame
import presets
import roadgraph


def test_origin_maps_to_zero():
    assert frame.to_local(723900.0, 6176500.0) == (0.0, -0.0)
    assert frame.to_local_y(6.84) == 0.0


def test_axes_east_positive_x_south_positive_z():
    x, z = frame.to_local(723900.0 + 100, 6176500.0 - 50)  # 100 m east, 50 m south
    assert (x, z) == (100.0, 50.0)
    assert frame.to_utm(100.0, 50.0) == (724000.0, 6176450.0)


def test_roundtrip():
    e, n = 723412.34, 6176987.65
    assert frame.to_utm(*frame.to_local(e, n)) == (e, n)


def test_bbox_corners_match_district():
    assert frame.to_local(723150, 6177250) == (-750.0, -750.0)
    assert frame.to_local(724650, 6175750) == (750.0, 750.0)


def test_ccw_in_map_plane_from_cw_input():
    # UTM square listed clockwise (E,N): (0,0)->(0,10)->(10,10)->(10,0)
    base = (723900.0, 6176500.0)
    cw = [(base[0], base[1]), (base[0], base[1] + 10), (base[0] + 10, base[1] + 10), (base[0] + 10, base[1]), (base[0], base[1])]
    ring = frame.ring_to_local(cw)
    assert len(ring) == 4  # closing duplicate dropped
    assert frame.signed_area(ring) > 0
    assert math.isclose(abs(frame.signed_area(ring)), 100.0)


def test_ccw_input_untouched():
    base = (723900.0, 6176500.0)
    ccw = [(base[0], base[1]), (base[0] + 10, base[1]), (base[0] + 10, base[1] + 10), (base[0], base[1] + 10)]
    local = [frame.to_local(*p) for p in ccw]
    assert frame.ring_to_local(ccw) == local


def test_flat_rounding_and_no_negative_zero():
    assert frame.flat([(1.23456, -0.0000001)]) == [1.23, 0.0]


def test_node_dedup_within_half_metre():
    pts = [(0, 0), (0.3, 0.2), (10, 0), (10.6, 0)]
    ids = roadgraph.cluster_points(pts, 0.5)
    assert ids[0] == ids[1]
    assert ids[2] != ids[3]  # 0.6 m apart
    assert len(set(ids)) == 3


def test_graph_junction_shared_between_ways():
    a = [(0, 0), (50, 0), (100, 0)]
    b = [(50.2, 0.1), (50, 40)]  # starts 0.22 m from a's middle vertex
    nodes, segs = roadgraph.build_graph([a, b], 0.5)
    assert len(nodes) == 4
    deg = {}
    for _, u, v in segs:
        deg[u] = deg.get(u, 0) + 1
        deg[v] = deg.get(v, 0) + 1
    assert sorted(deg.values()) == [1, 1, 1, 3]  # one T-junction node of degree 3
    assert roadgraph.components(len(nodes), [(u, v) for _, u, v in segs]) == [4]


def test_graph_crossing_without_shared_vertex_stays_separate():
    nodes, segs = roadgraph.build_graph([[(0, 0), (100, 0)], [(50, -50), (50, 50)]], 0.5)
    comps = roadgraph.components(len(nodes), [(u, v) for _, u, v in segs])
    assert comps == [2, 2]


def test_preset_selection():
    assert presets.select_preset(140, 1895, "mursten") == "karre-1900"
    assert presets.select_preset(140, 1870, "mursten") == "karre-1900"
    assert presets.select_preset(140, 1915, "mursten") == "karre-1900"
    assert presets.select_preset(140, 1950, "mursten") == "funk-brick-1945"
    assert presets.select_preset(140, 1969, "betonelementer") == "slab-1960s"
    assert presets.select_preset(140, 2012, "glas") == "modern-2000"
    assert presets.select_preset(140, 1800, "mursten") == "pre-1870"
    assert presets.select_preset(140, None, None) == "other"
    assert presets.select_preset(920, 1990, None) == "outbuilding"  # garage
    assert presets.select_preset(None, None, None) == "outbuilding"
    assert presets.select_preset(322, 1985, "mursten") == "commercial-box"
    assert presets.select_preset(322, 1900, "mursten") == "karre-1900"  # old shop house stays a karre


def test_facade_floor_height_clamped_and_inferred_fields():
    f = presets.facade_for(140, 1895, "mursten", 19.64, 8)  # 2.45 per storey -> clamp
    assert f["floor_h"] == 2.6
    f = presets.facade_for(140, 1895, "mursten", 30.0, 5)  # 6 per storey -> clamp
    assert f["floor_h"] == 3.6
    assert len(f["tone"]) == 3 and all(0 <= c <= 1 for c in f["tone"])
    assert f["ground_type"] in ("shop", "residential", "blank", "entrance")
    assert presets.facade_for(322, 1900, "mursten", 15, 4)["ground_type"] == "shop"
    assert presets.facade_for(140, 1900, "mursten", 15, 4)["ground_type"] == "residential"
