# confluence-md-gui

Lệnh `cme-gui` mở một giao diện web trên máy (127.0.0.1), bọc quanh
[confluence-markdown-exporter](https://github.com/Spenhouet/confluence-markdown-exporter) 5.5.0:

1. **Export** một trang / trang + con / folder / cả space ra `.md` kèm ảnh.
2. **Kiểm tra ảnh**: tìm ảnh sẽ không hiện trên GitHub (trỏ về Confluence, thiếu file, có `?width=…`, file > 100MB).
3. **Xem trước** file `.md` có ảnh ngay trong app.
4. **Push lên GitHub** qua API (không cần cài Git), chỉ đẩy file mới/thay đổi, cảnh báo nếu repo public.

Token Confluence và GitHub **không được lưu** xuống đĩa. Chỉ địa chỉ, email, thư mục, repo được nhớ
(Windows: `%APPDATA%\ConfluenceMdGui\settings.json`, macOS/Linux: `~/.config/ConfluenceMdGui/`).

## Cài đặt

**Bước 1 – cài [uv](https://docs.astral.sh/uv/)** (một lần; uv tự tải Python nếu máy chưa có):

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Mở lại terminal sau khi cài.

**Bước 2 – cài cme-gui**, chọn một trong hai:

```bash
# Từ file .whl được gửi cho bạn
uv tool install confluence_md_gui-0.1.0-py3-none-any.whl

# Hoặc từ repo GitHub (cần quyền đọc repo nếu repo private)
uv tool install git+https://github.com/marcus-GLAC/confluence-md-gui
```

## Sử dụng

```bash
cme-gui                 # mở trình duyệt với giao diện
cme-gui --port 8000     # cố định cổng
cme-gui --no-browser    # không tự mở trình duyệt (in ra link)
```

Nhấn `Ctrl+C` trong terminal để tắt.

Cần chuẩn bị:

- Confluence API token: https://id.atlassian.com/manage-profile/security/api-tokens
- GitHub fine-grained token, quyền **Contents: Read and write** cho repo đích:
  https://github.com/settings/personal-access-tokens/new

## Cập nhật / gỡ

```bash
uv tool install --force <file .whl mới>    # hoặc: uv tool upgrade confluence-md-gui (nếu cài từ git)
uv tool uninstall confluence-md-gui
```

## Phát triển & đóng gói

```bash
uv run cme-gui          # chạy từ mã nguồn
uv build                # tạo dist/confluence_md_gui-<version>-py3-none-any.whl để gửi đi
```

Tăng `version` trong `pyproject.toml` và `src/confluence_md_gui/__init__.py` mỗi lần phát hành.

## Ghi chú

- Trên Windows nên để thư mục kết quả ngắn (vd. `C:\cme-export`) vì giới hạn đường dẫn ~260 ký tự.
- Push không xoá file trên GitHub khi file đã bị xoá ở máy.
- Export lại chỉ tải trang đã thay đổi (tính năng có sẵn của cme).
