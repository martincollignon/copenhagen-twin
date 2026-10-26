import frame


def test_district_bbox_matches_origin():
    assert frame.DISTRICT_UTM_BBOX == (723150.0, 6175750.0, 724650.0, 6177250.0)
    assert frame.area_local() == frame.LOCAL_BBOX


def test_tile_ids_and_bounds():
    assert frame.tile_of_point(723900.0, 6176500.0) == "1447_12353"
    assert frame.tile_bounds_utm("1447_12353") == (723500.0, 6176500.0, 724000.0, 6177000.0)
    # local bounds: x east, z south (north is -z)
    assert frame.tile_bounds_local("1447_12353") == (-400.0, -500.0, 100.0, 0.0)
    assert frame.tile_of_local(0.0, 0.0) == "1447_12353"
    assert frame.tile_of_local(0.0, 0.01) == "1447_12352"  # a hair south of the origin


def test_four_tiles_fill_a_lod2_cell():
    cells = {}
    for ie in (1446, 1447):
        for in_ in (12352, 12353):
            cells.setdefault(frame.lod2_cell_of_tile(frame.tile_id(ie, in_)), []).append((ie, in_))
    assert list(cells) == ["6176_723"] and len(cells["6176_723"]) == 4


def test_tiles_for_bbox_district_is_4x4_and_edges_do_not_leak():
    ts = frame.tiles_for_bbox(frame.DISTRICT_UTM_BBOX)
    assert len(ts) == 16 and "1446_12351" in ts and "1449_12354" in ts
    assert frame.tiles_for_bbox((723500.0, 6176500.0, 724000.0, 6177000.0)) == ["1447_12353"]
    assert len(frame.tiles_for_bbox((723500.0, 6176500.0, 724000.0, 6177000.0), margin=1.0)) == 9


def test_area_override_and_cache_dir():
    import fetch

    class A:
        bbox = None
        tile = ["1447_12353", "1448_12353"]

    try:
        bbox = frame.apply_area_args(A)
        assert bbox == (723500.0, 6176500.0, 724500.0, 6177000.0)
        assert fetch.utm_bbox(0) == bbox
        assert "areas" in fetch.cache_dir().parts
    finally:
        frame.set_area(frame.DISTRICT_UTM_BBOX)
    assert fetch.utm_bbox() == (723090.0, 6175690.0, 724710.0, 6177310.0)
    assert fetch.cache_dir() == fetch.RAW
