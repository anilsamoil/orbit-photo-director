"""Run with the same Pillow interpreter used for raster regeneration."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("country_raster_levels", Path(__file__).with_name("country-raster-levels.py"))
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)


class CountryRasterTruth(unittest.TestCase):
    def test_exact_sovereign_survives_unrelated_adjective(self):
        for text, country in [("AUSTRALIA\nGreat Australian Bight", "Australia"), ("INDIA\nINDIAN OCEAN", "India")]:
            self.assertTrue(GENERATOR.raster_painted(text, country))
        for text, country in [("AUSTRALIAN", "Australia"), ("SOUTH AUSTRALIA", "Australia"), ("WESTERN AUSTRALIA", "Australia"), ("INDIA OCEAN", "India"), ("GULF OF MEXICO", "Mexico"), ("NEW MEXICO", "Mexico")]:
            self.assertFalse(GENERATOR.raster_painted(text, country), text)

    def test_fresh_australia_z5_image_keeps_sovereign_glyphs(self):
        fixture = Path(__file__).parents[1] / "test/fixtures/country-raster/Australia-z5-reference.png"
        observations = GENERATOR.ocr_observations(GENERATOR.Image.open(fixture).convert("RGBA"))
        words = GENERATOR.observation_text(observations)
        self.assertIn("AUSTRALIA", words)
        self.assertIn("Australian", words)
        self.assertTrue(GENERATOR.raster_painted(words, "Australia"))
        boxes = GENERATOR.name_boxes(observations, "Australia")
        self.assertEqual(len(boxes), 1, boxes)
        left, top, right, bottom = boxes[0]
        self.assertTrue(445 < left < 450 and 334 < top < 338 and 548 <= right < 552 and 348 <= bottom < 353, boxes)

    def test_generated_levels_match_independent_fresh_tile_audit(self):
        payload = json.loads(GENERATOR.OUT.read_text())
        self.assertEqual(payload["through"], 6)
        for country, *_ in GENERATOR.COUNTRIES:
            expected = list(range(1 if country == "Australia" else 4 if country == "Kenya" else 3, 7))
            self.assertEqual(payload["countries"][country], expected, country)
            for zoom in expected:
                boxes = payload["bounds"][country][str(zoom)]
                services = {"reference"} if country == "Australia" and zoom < 3 else {"reference", "dark"}
                self.assertEqual({box["service"] for box in boxes}, services, (country, zoom))
                self.assertEqual(len(boxes), len(services), (country, zoom, boxes))


if __name__ == "__main__":
    unittest.main()
