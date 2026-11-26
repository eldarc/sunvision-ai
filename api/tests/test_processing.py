from sunvision_cv.processing import ProcessingConfig, process, to_sv_detections


def test_from_inference_keeps_ids_and_masks(thumb_raw):
    det = to_sv_detections(thumb_raw)
    assert len(det) == len(thumb_raw["predictions"])
    assert det.mask is not None
    assert det.data["detection_id"][0] == thumb_raw["predictions"][0]["detection_id"]


def test_process_filters_and_converts(thumb_raw):
    det, out = process(thumb_raw)
    classes = {d["cls"] for d in out}
    assert {"facade", "window", "balcony-fence", "vegetation"} <= classes
    # 3x6 px window (conf 0.59) is below the tiny-window area rule
    assert "09e61de9-86b6-410b-8a1e-30d714ad8df7" not in {d["id"] for d in out}
    for d in out:
        x1, y1, x2, y2 = d["bbox"]
        assert x2 > x1 and y2 > y1
        assert d["source"] == "model"
        assert 0 < d["confidence"] <= 1
        poly = d["polygon"]
        assert len(poly) >= 3
        # window polygons lie (approximately) inside their box. Large regions such as
        # the facade can legitimately extend past the model's predicted box.
        if d["cls"] == "window":
            assert all(x1 - 2 <= x <= x2 + 2 and y1 - 2 <= y <= y2 + 2 for x, y in poly)


def test_class_threshold(thumb_raw):
    cfg = ProcessingConfig()
    cfg.class_thresholds["window"] = 0.92
    _, out = process(thumb_raw, cfg)
    wins = [d for d in out if d["cls"] == "window"]
    assert wins and all(d["confidence"] >= 0.92 for d in wins)


def test_window_nms_removes_duplicates(thumb_raw):
    dup = dict(thumb_raw["predictions"][0])
    dup["detection_id"] = "dup"
    dup["confidence"] = 0.5
    thumb_raw["predictions"].append(dup)
    _, out = process(thumb_raw)
    assert "dup" not in {d["id"] for d in out}


def test_empty_response():
    det, out = process({"image": {"width": 100, "height": 80}, "predictions": []})
    assert len(det) == 0 and out == []
