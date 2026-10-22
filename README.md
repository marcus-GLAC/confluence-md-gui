# Confluence → Markdown

Công cụ có giao diện web giúp **export trang Confluence ra Markdown (kèm hình ảnh)** và **đưa lên GitHub** chỉ với vài cú nhấp.

## Cài đặt (1 lần)

**1. Cài `uv`.** Mở PowerShell (Windows) hoặc Terminal (macOS/Linux):

```powershell
# Windows
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**2. Đóng terminal, mở lại, rồi cài công cụ:**

```bash
uv tool install git+https://github.com/marcus-GLAC/confluence-md-gui
```

## Sử dụng

```bash
cme-gui
```

Trình duyệt sẽ tự mở. Làm lần lượt 5 bước trên màn hình:
**Kết nối Confluence → Export → Kiểm tra hình ảnh → Xem trước → Đưa lên GitHub**.
Tắt công cụ bằng `Ctrl + C` trong terminal.

Bạn cần chuẩn bị:

- **Confluence API token**: [tạo tại đây](https://id.atlassian.com/manage-profile/security/api-tokens)
- **GitHub token** (chỉ khi đưa lên GitHub): [tạo tại đây](https://github.com/settings/personal-access-tokens/new), chọn repo đích và cấp quyền **Contents: Read and write**

Token chỉ dùng trong lúc chạy, không được lưu lại.

## Cập nhật / gỡ cài đặt

```bash
uv tool upgrade confluence-md-gui     # cập nhật bản mới
uv tool uninstall confluence-md-gui   # gỡ
```

## Lỗi thường gặp

| Lỗi | Cách xử lý |
|---|---|
| `cme-gui` không được nhận diện | Đóng terminal và mở lại sau khi cài |
| Không đăng nhập được Confluence | Kiểm tra địa chỉ (`https://tencongty.atlassian.net`), email và API token |
| Ảnh không hiện trên GitHub | Xem bước **Kiểm tra hình ảnh** để biết ảnh nào lỗi và vì sao |
| Lỗi đường dẫn quá dài (Windows) | Chọn thư mục lưu ngắn, ví dụ `C:\cme-export` |

---

Xây dựng dựa trên [confluence-markdown-exporter](https://github.com/Spenhouet/confluence-markdown-exporter).
Font: Montserrat (OFL), Roboto (Apache 2.0), DejaVu Sans (Bitstream Vera License).
