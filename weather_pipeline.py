from __future__ import annotations

import argparse
import csv
import json
import mimetypes
import os
import re
import smtplib
import sys
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

try:
    from dotenv import load_dotenv
except ImportError:  # Cho phép chạy kiểm thử chỉ với thư viện chuẩn.
    def load_dotenv() -> bool:
        return False

load_dotenv()
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

BASE_DIR = Path(__file__).resolve().parent
VRAIN_URL = "https://data.vrain.vn/public/current/all.json"
NCHMF_URL = "https://luquetsatlo.nchmf.gov.vn/LayerMapBox/getDSCanhbaoSLLQ"
VIETNAM_TZ = ZoneInfo("Asia/Ho_Chi_Minh")
DOTNET_DATE_RE = re.compile(r"^/Date\((\d+)(?:[+-]\d+)?\)/$")
MOJIBAKE_MARKERS = ("Ã", "Â", "Ä", "Æ", "áº", "á»", "â€")

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
)
VRAIN_HEADERS = {
    "accept": "application/json, text/plain, */*",
    "origin": "https://www.vrain.vn",
    "referer": "https://www.vrain.vn/",
    "user-agent": USER_AGENT,
    "x-vrain-user-agent": USER_AGENT,
}
NCHMF_HEADERS = {
    "accept": "*/*",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    "origin": "https://luquetsatlo.nchmf.gov.vn",
    "referer": "https://luquetsatlo.nchmf.gov.vn/",
    "user-agent": USER_AGENT,
    "x-requested-with": "XMLHttpRequest",
}
POWERBI_COLUMNS = (
    "record_type", "record_id", "collected_at", "observed_at", "forecast_hours",
    "name", "commune", "district", "province", "latitude", "longitude",
    "rainfall_mm", "risk_level", "flash_flood_risk", "color", "source",
)
RISK_WEIGHTS = {"rất cao": 4, "cao": 3, "trung bình": 2, "thấp": 1}


class PipelineError(RuntimeError):
    pass


def env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    return default if value is None else value.strip().lower() in {"1", "true", "yes", "on"}


def vietnam_now() -> datetime:
    return datetime.now(VIETNAM_TZ)


def format_query_time(value: datetime) -> str:
    local = value.astimezone(VIETNAM_TZ).replace(minute=0, second=0, microsecond=0)
    return local.strftime("%Y-%m-%d %H:%M:%S")


def mojibake_score(value: str) -> int:
    return sum(value.count(marker) for marker in MOJIBAKE_MARKERS)


def repair_text(value: str) -> str:
    current = value
    for _ in range(2):
        candidates = []
        for encoding in ("latin-1", "cp1252"):
            try:
                candidates.append(current.encode(encoding).decode("utf-8"))
            except (UnicodeEncodeError, UnicodeDecodeError):
                pass
        if not candidates:
            break
        best = min(candidates, key=mojibake_score)
        if mojibake_score(best) >= mojibake_score(current):
            break
        current = best
    return current


def repair_unicode(value: Any) -> Any:
    if isinstance(value, str):
        return repair_text(value)
    if isinstance(value, list):
        return [repair_unicode(item) for item in value]
    if isinstance(value, dict):
        return {key: repair_unicode(item) for key, item in value.items()}
    return value


def parse_dotnet_date(value: object) -> str:
    if not isinstance(value, str):
        return ""
    match = DOTNET_DATE_RE.match(value)
    if not match:
        return value
    instant = datetime.fromtimestamp(int(match.group(1)) / 1000, tz=timezone.utc)
    return instant.astimezone(VIETNAM_TZ).isoformat(timespec="seconds")


def as_float(value: object) -> float | None:
    try:
        return round(float(value), 3) if value is not None else None
    except (TypeError, ValueError):
        return None


def decode_json(raw: bytes, source_name: str) -> object:
    for encoding in ("utf-8-sig", "utf-8", "cp1258", "cp1252"):
        try:
            return json.loads(raw.decode(encoding))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
    raise PipelineError(f"{source_name} returned invalid JSON")


def fetch_vrain(timeout: int = 45) -> tuple[bytes, object]:
    try:
        with urlopen(Request(VRAIN_URL, headers=VRAIN_HEADERS), timeout=timeout) as response:
            raw = response.read()
    except Exception as exc:
        raise PipelineError(f"Cannot download VRain data: {exc}") from exc
    return raw, decode_json(raw, "VRain")


def fetch_landslide(
    forecast_hours: int, query_time: str, cookie: str = "", timeout: int = 75
) -> tuple[bytes, object]:
    payload = urlencode({"sogiodubao": forecast_hours, "date": query_time}).encode("utf-8")
    headers = dict(NCHMF_HEADERS)
    if cookie:
        headers["cookie"] = cookie
    request = Request(NCHMF_URL, data=payload, headers=headers, method="POST")
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except Exception as exc:
        raise PipelineError(f"Cannot download NCHMF data: {exc}") from exc
    return raw, decode_json(raw, "NCHMF")


def normalize_vrain(data: object, collected_at: str) -> list[dict[str, object]]:
    if not isinstance(data, list):
        return []
    rows = []
    for item in data:
        if not isinstance(item, dict):
            continue
        rows.append({
            "record_type": "rainfall_station",
            "record_id": f"vrain-{item.get('lt', '')}-{item.get('lg', '')}-{item.get('sn', '')}",
            "collected_at": collected_at,
            "observed_at": collected_at,
            "forecast_hours": None,
            "name": item.get("sn", ""),
            "commune": "", "district": "", "province": "",
            "latitude": as_float(item.get("lt")),
            "longitude": as_float(item.get("lg")),
            "rainfall_mm": as_float(item.get("d")),
            "risk_level": item.get("l", ""),
            "flash_flood_risk": "",
            "color": item.get("c", ""),
            "source": "VRain",
        })
    return rows


def normalize_landslide(data: object, collected_at: str) -> list[dict[str, object]]:
    if not isinstance(data, list):
        return []
    rows = []
    for item in data:
        if not isinstance(item, dict):
            continue
        rows.append({
            "record_type": "landslide_warning",
            "record_id": f"nchmf-{item.get('id', '')}-{item.get('commune_id', '')}",
            "collected_at": collected_at,
            "observed_at": parse_dotnet_date(item.get("thoigian")),
            "forecast_hours": item.get("sogiodubao"),
            "name": item.get("commune_name", ""),
            "commune": item.get("commune_name_2cap", ""),
            "district": item.get("district_name", ""),
            "province": item.get("provinceName_2cap") or item.get("provinceName", ""),
            "latitude": as_float(item.get("lat")),
            "longitude": as_float(item.get("lon")),
            "rainfall_mm": as_float(item.get("luongmuatd_db")),
            "risk_level": item.get("nguycosatlo", ""),
            "flash_flood_risk": item.get("nguycoluquet", ""),
            "color": "", "source": "NCHMF",
        })
    return rows


def build_statistics(rows: list[dict[str, object]]) -> dict[str, object]:
    rainfall = [row for row in rows if row["record_type"] == "rainfall_station"]
    warnings = [row for row in rows if row["record_type"] == "landslide_warning"]
    risk_counts: dict[str, int] = {}
    for row in warnings:
        label = str(row.get("risk_level") or "Không xác định")
        risk_counts[label] = risk_counts.get(label, 0) + 1
    top_rainfall = sorted(rainfall, key=lambda row: float(row.get("rainfall_mm") or 0), reverse=True)[:20]
    top_warnings = sorted(
        warnings,
        key=lambda row: (
            RISK_WEIGHTS.get(str(row.get("risk_level", "")).lower(), 0),
            float(row.get("rainfall_mm") or 0),
        ),
        reverse=True,
    )[:20]
    return {
        "rainfall_station_count": len(rainfall),
        "warning_count": len(warnings),
        "risk_counts": risk_counts,
        "max_rainfall_mm": max((float(row.get("rainfall_mm") or 0) for row in rainfall), default=0),
        "top_rainfall": top_rainfall,
        "top_warnings": top_warnings,
    }


def local_summary(statistics: dict[str, object]) -> str:
    risk_counts = dict(statistics.get("risk_counts", {}))
    risk_text = ", ".join(f"{key}: {value}" for key, value in risk_counts.items()) or "không có"
    return (
        "BÁO CÁO TỰ ĐỘNG\n"
        f"- Số trạm mưa: {statistics.get('rainfall_station_count', 0)}\n"
        f"- Lượng mưa lớn nhất: {statistics.get('max_rainfall_mm', 0):.1f} mm\n"
        f"- Số bản ghi cảnh báo: {statistics.get('warning_count', 0)}\n"
        f"- Phân bố nguy cơ sạt lở: {risk_text}\n"
        "Lưu ý: Nội dung tự động; cần đối chiếu nguồn chính thức trước khi ra quyết định."
    )


def generate_summary(statistics: dict[str, object]) -> tuple[str, str]:
    fallback = local_summary(statistics)
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()
    if not api_key:
        return fallback, "local"
    try:
        from google import genai
        payload = {
            "rainfall_station_count": statistics["rainfall_station_count"],
            "warning_count": statistics["warning_count"],
            "risk_counts": statistics["risk_counts"],
            "max_rainfall_mm": statistics["max_rainfall_mm"],
            "top_rainfall": statistics["top_rainfall"],
            "top_warnings": statistics["top_warnings"],
        }
        prompt = (
            "Bạn là trợ lý phân tích thiên tai Việt Nam. Viết bản tin ngắn, nêu điểm đáng chú ý, "
            "địa điểm rủi ro cao và khuyến nghị kiểm tra nguồn chính thức. Không tự tạo dữ kiện và "
            "không khẳng định đây là cảnh báo pháp lý. Dữ liệu JSON:\n"
            + json.dumps(payload, ensure_ascii=False)
        )
        response = genai.Client(api_key=api_key).models.generate_content(model=model, contents=prompt)
        text = (response.text or "").strip()
        return (text or fallback), model if text else "local"
    except Exception as exc:
        return fallback + f"\n- Gemini tạm thời không khả dụng: {type(exc).__name__}", "local"


def write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=POWERBI_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def write_geojson(path: Path, rows: list[dict[str, object]]) -> None:
    features = []
    for row in rows:
        if row.get("latitude") is None or row.get("longitude") is None:
            continue
        properties = {key: value for key, value in row.items() if key not in {"latitude", "longitude"}}
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [row["longitude"], row["latitude"]]},
            "properties": properties,
        })
    write_json(path, {"type": "FeatureCollection", "features": features})


def export_outputs(
    output_dir: Path, raw_vrain: bytes, raw_landslide: bytes,
    vrain: object, landslide: object,
    rainfall_rows: list[dict[str, object]], warning_rows: list[dict[str, object]],
) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "all.raw.json").write_bytes(raw_vrain)
    (output_dir / "canhbao_sllq.raw.json").write_bytes(raw_landslide)
    write_json(output_dir / "all.json", vrain)
    write_json(output_dir / "canhbao_sllq.json", landslide)
    write_csv(output_dir / "rainfall.csv", rainfall_rows)
    write_csv(output_dir / "landslide_warnings.csv", warning_rows)
    combined = rainfall_rows + warning_rows
    write_csv(output_dir / "powerbi_data.csv", combined)
    write_geojson(output_dir / "map.geojson", combined)
    return [
        output_dir / "powerbi_data.csv", output_dir / "rainfall.csv",
        output_dir / "landslide_warnings.csv", output_dir / "map.geojson",
    ]


def email_configured() -> bool:
    return bool(
        env_bool("SEND_EMAIL", True)
        and os.getenv("SMTP_USER", "").strip()
        and os.getenv("SMTP_APP_PASSWORD", "").strip()
        and os.getenv("MAIL_TO", "").strip()
    )


def send_report(subject: str, summary: str, attachments: list[Path]) -> bool:
    if not email_configured():
        return False
    smtp_user = os.environ["SMTP_USER"].strip()
    recipients = [item.strip() for item in os.environ["MAIL_TO"].split(",") if item.strip()]
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = os.getenv("MAIL_FROM", smtp_user).strip()
    message["To"] = ", ".join(recipients)
    message.set_content(summary)
    for path in attachments:
        if not path.exists():
            continue
        mime_type, _ = mimetypes.guess_type(path.name)
        main_type, sub_type = (mime_type or "application/octet-stream").split("/", 1)
        message.add_attachment(path.read_bytes(), maintype=main_type, subtype=sub_type, filename=path.name)
    host = os.getenv("SMTP_HOST", "smtp.gmail.com")
    port = int(os.getenv("SMTP_PORT", "587"))
    password = os.environ["SMTP_APP_PASSWORD"].replace(" ", "")
    with smtplib.SMTP(host, port, timeout=45) as server:
        server.ehlo(); server.starttls(); server.ehlo()
        server.login(smtp_user, password)
        server.send_message(message)
    return True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Tải, chuẩn hóa và gửi dữ liệu mưa/cảnh báo sạt lở.")
    parser.add_argument("--sogiodubao", type=int, default=int(os.getenv("FORECAST_HOURS", "6")))
    parser.add_argument("--date", help='Thời điểm "YYYY-MM-DD HH:MM:SS"; mặc định giờ hiện tại Việt Nam.')
    parser.add_argument("--cookie", default=os.getenv("NCHMF_COOKIE", ""))
    parser.add_argument("--output-dir", default=os.getenv("OUTPUT_DIR", "outputs"))
    parser.add_argument("--no-email", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.date:
        collected_dt = datetime.strptime(args.date, "%Y-%m-%d %H:%M:%S").replace(tzinfo=VIETNAM_TZ)
    else:
        collected_dt = vietnam_now()
    query_time = format_query_time(collected_dt)
    collected_at = collected_dt.isoformat(timespec="seconds")
    output_dir = Path(args.output_dir)
    if not output_dir.is_absolute():
        output_dir = BASE_DIR / output_dir

    raw_vrain, vrain = fetch_vrain()
    raw_landslide, landslide = fetch_landslide(args.sogiodubao, query_time, args.cookie)
    vrain, landslide = repair_unicode(vrain), repair_unicode(landslide)
    rainfall_rows = normalize_vrain(vrain, collected_at)
    warning_rows = normalize_landslide(landslide, collected_at)
    statistics = build_statistics(rainfall_rows + warning_rows)
    summary, summary_engine = generate_summary(statistics)
    attachments = export_outputs(
        output_dir, raw_vrain, raw_landslide, vrain, landslide, rainfall_rows, warning_rows
    )
    summary_path = output_dir / "ai_summary.txt"
    summary_path.write_text(summary + "\n", encoding="utf-8")
    email_sent = False if args.no_email else send_report(
        f"Dữ liệu mưa và cảnh báo sạt lở - {query_time}", summary, attachments + [summary_path]
    )
    metadata = {
        "status": "ok", "query_time": query_time, "collected_at": collected_at,
        "forecast_hours": args.sogiodubao, "rainfall_rows": len(rainfall_rows),
        "warning_rows": len(warning_rows), "summary_engine": summary_engine,
        "email_configured": email_configured() and not args.no_email, "email_sent": email_sent,
    }
    write_json(output_dir / "pipeline_metadata.json", metadata)
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()


