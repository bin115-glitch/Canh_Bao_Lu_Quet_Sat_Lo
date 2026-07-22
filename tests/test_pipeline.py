from __future__ import annotations

import json
import os
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime
from pathlib import Path

from weather_pipeline import (
    VIETNAM_TZ,
    format_query_time,
    generate_summary,
    normalize_landslide,
    normalize_vrain,
    parse_dotnet_date,
    repair_text,
    write_csv,
    write_geojson,
)


class PipelineTests(unittest.TestCase):
    def test_repairs_vietnamese_mojibake(self) -> None:
        self.assertEqual(repair_text("MÆ°a to"), "Mưa to")
        self.assertEqual(repair_text("Äá»©c Long"), "Đức Long")
        self.assertEqual(repair_text("Bình thường"), "Bình thường")

    def test_formats_query_time_to_full_hour(self) -> None:
        value = datetime(2026, 7, 21, 14, 42, 8, tzinfo=VIETNAM_TZ)
        self.assertEqual(format_query_time(value), "2026-07-21 14:00:00")

    def test_parses_dotnet_date(self) -> None:
        self.assertEqual(parse_dotnet_date("/Date(1783587600000)/"), "2026-07-09T16:00:00+07:00")

    def test_normalizes_coordinates_and_exports_powerbi_files(self) -> None:
        collected = "2026-07-21T14:00:00+07:00"
        rainfall = normalize_vrain(
            [{"sn": "Trạm A", "lt": 21.1, "lg": 105.2, "d": 12.34, "l": "Mưa nhỏ"}],
            collected,
        )
        warnings = normalize_landslide(
            [{"id": 1, "commune_id": 2, "lat": 20.1, "lon": 106.1, "nguycosatlo": "Cao"}],
            collected,
        )
        with tempfile.TemporaryDirectory() as directory:
            csv_path = Path(directory) / "powerbi.csv"
            geojson_path = Path(directory) / "map.geojson"
            write_csv(csv_path, rainfall + warnings)
            write_geojson(geojson_path, rainfall + warnings)
            self.assertTrue(csv_path.read_bytes().startswith(b"\xef\xbb\xbf"))
            geojson = json.loads(geojson_path.read_text(encoding="utf-8"))
            self.assertEqual(len(geojson["features"]), 2)
            self.assertEqual(geojson["features"][0]["geometry"]["coordinates"], [105.2, 21.1])

    def test_gemini_rest_response_is_used(self) -> None:
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self) -> bytes:
                return json.dumps({
                    "candidates": [{"content": {"parts": [{"text": "Bản tin Gemini"}]}}]
                }).encode("utf-8")

        statistics = {
            "rainfall_station_count": 1,
            "warning_count": 0,
            "risk_counts": {},
            "max_rainfall_mm": 12.3,
            "top_rainfall": [],
            "top_warnings": [],
        }
        with patch.dict(os.environ, {"GEMINI_API_KEY": "test-key", "GEMINI_MODEL": "gemini-test"}), patch(
            "weather_pipeline.urlopen", return_value=FakeResponse()
        ) as mocked_urlopen:
            summary, engine = generate_summary(statistics)
        self.assertEqual(summary, "Bản tin Gemini")
        self.assertEqual(engine, "gemini-test")
        request = mocked_urlopen.call_args.args[0]
        self.assertEqual(request.headers["X-goog-api-key"], "test-key")

if __name__ == "__main__":
    unittest.main()

