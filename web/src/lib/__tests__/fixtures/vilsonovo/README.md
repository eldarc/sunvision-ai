# Vilsonovo šetalište, Sarajevo: depth background-rejection regression (offline fixture)

Used by `web/src/lib/__tests__/examples.test.ts` ("Vilsonovo fixture: the Parliament tower behind the
block is set aside by depth") and by the vanishing-point checks in `vanishingExamples.test.ts`.

The photo shows a war-damaged apartment block in Sarajevo. It is not a curated example; the data here
serve only as a regression test for the depth-discontinuity rejection in `lib/reconstruct.ts`
(`depthBackground`): RF-DETR's facade mask swallows the
high-rise of the Parliament complex about 230 m behind the block and puts one false "window" on it. Without
the depth map the target comes out a storey (≈ 4 m) too tall. See docs/RECONSTRUCTION.md, "Buildings behind
the facade".

## Files

| File | What |
| --- | --- |
| `scene.base.json` | The scene exactly as `scripts/build_scene.py` built it for this photo (OSM snapshot of 2026-11-25 via Overpass, camera from the Commons geotag + compass point NNW, target `way/190968917`). |
| `analysis.json` | The `FacadeAnalysis` from `scripts/analyze_example.py`: the recorded Roboflow response (`building-facade-segmentation-instance/4`, one hosted call on 2026-11-25) plus Depth Anything V2 Small. |
| `depth16.bin` | The raw 16-bit relative depth (640 × 427, `analysis.json → depth`) that the test samples. |

The photo is **not** included, because the test does not need it. The files match the scene built from a
2000 × 1333 `photo.jpg` with SHA-1
`f583660d3f641c78bc2cc19eadfe87e6b6c4c89e` (downscaled from the 6000 × 4000 original, SHA-1
`d924708607512a1ff432cdcb7047a6c25fb57715`).

## Source and licence

The detections, depth map and camera were derived from the photograph
[File:Vilsonovo Šetalište.jpg](https://commons.wikimedia.org/wiki/File:Vilsonovo_%C5%A0etali%C5%A1te.jpg)
by **Fanny Schertzer** ([User:Inisheer](https://commons.wikimedia.org/wiki/User:Inisheer)), Wikimedia Commons,
licensed [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). The derived data here are shared under
the same licence. Map data in `scene.base.json`: © OpenStreetMap contributors,
[ODbL 1.0](https://www.openstreetmap.org/copyright). The recorded Roboflow response and the full Commons record
are not kept in `data/raw/`. Re-fetch them from the links above to rebuild the fixture.
