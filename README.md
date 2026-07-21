# Pipeline dữ liệu mưa và cảnh báo sạt lở

Dự án tự động lấy dữ liệu từ VRain và NCHMF, sửa lỗi Unicode tiếng Việt, chuẩn hóa tọa độ, tạo dữ liệu cho Power BI, dùng Gemini tạo bản tin và gửi kết quả qua Gmail SMTP.

## Luồng xử lý

1. Tải lượng mưa hiện tại từ VRain.
2. Tải cảnh báo sạt lở/lũ quét từ NCHMF theo giờ Việt Nam hiện tại.
3. Sửa lỗi mã hóa tiếng Việt và chuẩn hóa hai nguồn về một schema.
4. Xuất CSV UTF-8 BOM và GeoJSON để dùng với Power BI/Azure Maps.
5. Chỉ gửi thống kê và 20 điểm nổi bật cho Gemini, không gửi toàn bộ dữ liệu thô.
6. Gửi email kèm các file kết quả qua Gmail SMTP.

## Cài đặt cục bộ

Yêu cầu Python 3.10 trở lên.

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

Điền khóa vào `.env`, sau đó chạy:

```powershell
python download_combined.py
```

Chạy không gửi email:

```powershell
python download_combined.py --no-email
```

Truy vấn thời điểm cụ thể:

```powershell
python download_combined.py --date "2026-07-21 14:00:00" --sogiodubao 6
```

## Biến môi trường

| Biến | Bắt buộc | Ý nghĩa |
|---|---:|---|
| `GEMINI_API_KEY` | Không | API key Google AI Studio. Thiếu key thì dùng thống kê cục bộ. |
| `GEMINI_MODEL` | Không | Mặc định `gemini-2.5-flash`. |
| `SMTP_USER` | Khi gửi mail | Địa chỉ Gmail gửi. |
| `SMTP_APP_PASSWORD` | Khi gửi mail | App Password; không dùng mật khẩu Gmail chính. |
| `MAIL_TO` | Khi gửi mail | Một hoặc nhiều địa chỉ, phân tách bằng dấu phẩy. |
| `NCHMF_COOKIE` | Tùy nguồn | Cookie nếu endpoint NCHMF yêu cầu. |
| `FORECAST_HOURS` | Không | Số giờ dự báo, mặc định 6. |

Không commit `.env`. Trên GitHub tạo Repository Secrets: `GEMINI_API_KEY`, `SMTP_USER`, `SMTP_APP_PASSWORD`, `MAIL_TO`, và `NCHMF_COOKIE` nếu cần.

## File đầu ra

- `outputs/powerbi_data.csv`: bảng hợp nhất dùng trực tiếp trong Power BI.
- `outputs/rainfall.csv`: dữ liệu trạm mưa.
- `outputs/landslide_warnings.csv`: cảnh báo sạt lở/lũ quét.
- `outputs/map.geojson`: điểm bản đồ GeoJSON.
- `outputs/ai_summary.txt`: bản tin Gemini hoặc bản tin cục bộ.
- `outputs/pipeline_metadata.json`: trạng thái lần chạy.

## Power BI

Sau khi workflow chạy, `outputs/powerbi_data.csv` được cập nhật trong repository. Với repository công khai, trong Power BI Desktop chọn **Get data → Web** và dùng URL raw:

```text
https://raw.githubusercontent.com/OWNER/REPOSITORY/BRANCH/outputs/powerbi_data.csv
```

Thiết lập trong Power BI:

- `latitude`: Data category **Latitude**;
- `longitude`: Data category **Longitude**;
- dùng Azure Maps visual;
- `risk_level`: Legend;
- `rainfall_mm`: Size hoặc Tooltip;
- lọc `record_type` để tách trạm mưa và cảnh báo.

Nếu repository riêng tư, nên đồng bộ CSV sang OneDrive/SharePoint hoặc kho dữ liệu có xác thực, không nhúng GitHub token trong Power BI.

## GitHub Actions

Workflow `.github/workflows/data-pipeline.yml` chạy mỗi 6 giờ và có thể chạy thủ công. Workflow kiểm thử, chạy pipeline, lưu artifact 30 ngày và commit các file Power BI trở lại repository.

## Kiểm thử

```powershell
python -m unittest discover -s tests -v
```

## Lưu ý vận hành

- Bật xác minh hai bước trước khi tạo Gmail App Password.
- Dữ liệu và bản tin AI chỉ mang tính hỗ trợ; luôn đối chiếu thông báo chính thức.
- Thư mục `chrome-whisper-gpt` là dự án độc lập cũ, không tham gia pipeline dữ liệu này.
