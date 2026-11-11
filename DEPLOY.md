# Triển khai lên máy chủ (cho cả team)

Ngoài cách chạy trên máy cá nhân (`cme-gui`), công cụ có **chế độ máy chủ** (`cme-gui --server`) để cả team dùng chung qua một đường link:

- Mỗi trình duyệt có **phiên riêng**: token Confluence/GitHub, tác vụ đang chạy, cài đặt và thư mục export đều tách biệt.
- Token chỉ giữ trong RAM, **không bao giờ ghi xuống đĩa**. Tính năng "Ghi nhớ đăng nhập" bị tắt.
- Người dùng không chọn được thư mục lưu. Máy chủ cấp cho mỗi phiên một thư mục tạm. Để giữ kết quả, người dùng **tải file .zip** hoặc **đẩy lên GitHub**.
- Phiên **hết hạn sau 12 giờ** không dùng (phiên chưa export gì thì sau 1 giờ). Khi hết hạn, mọi file của phiên bị xoá. Mỗi lần khởi động lại máy chủ cũng xoá sạch.
- Chỉ cho phép export từ Confluence Cloud (`*.atlassian.net`), để không ai dùng được máy chủ này gọi tới các địa chỉ khác.

> ⚠ **Bắt buộc phải có lớp đăng nhập phía trước.** Ai mở được link là dùng được máy chủ. Hãy đặt `CME_GUI_PASSWORD` (mật khẩu chung), hoặc dùng Cloudflare Access nếu domain nằm trên Cloudflare.

## Dokploy (VPS có sẵn Dokploy)

Dokploy tự build từ `Dockerfile`, và Traefik đi kèm Dokploy tự lấy chứng chỉ HTTPS (Let's Encrypt). Không cần Cloudflare. **Không dùng `docker-compose.yml`**: file đó dành cho cách Cloudflare Tunnel bên dưới.

1. **DNS:** ở nơi đang quản lý domain, thêm bản ghi `A`, ví dụ `confluence-md.congty.com`, trỏ về IP của VPS.
2. **Tạo ứng dụng:** chọn Project → **Create Service → Application**.
   - Source: GitHub (hoặc Git) → repo `marcus-GLAC/confluence-md-gui`, nhánh `main`.
   - Build Type: **Dockerfile**. Dockerfile Path: `Dockerfile`. Docker Context Path: `.`
3. **Environment:**
   ```
   CME_GUI_PASSWORD=<mật-khẩu-chung-cho-team>
   CME_GUI_ALLOWED_HOSTS=congty.atlassian.net
   CME_GUI_MAX_EXPORTS=2
   ```
4. **Mounts:** thêm một **Volume Mount** (volume có tên) với Mount Path `/data`. Dùng volume, đừng dùng Bind Mount: thư mục bind mount thuộc quyền `root`, app chạy bằng user `10001` sẽ không ghi được.
5. **Domains:** thêm `confluence-md.congty.com`, Container Port `8080`, bật **HTTPS** với Certificate **Let's Encrypt**.
6. Bấm **Deploy**, xem tab Logs. Thấy dòng `chế độ máy chủ đang chạy` là xong. Mở `https://confluence-md.congty.com`, trình duyệt sẽ hỏi mật khẩu: tên đăng nhập nhập gì cũng được, mật khẩu là `CME_GUI_PASSWORD`.

Lưu ý:
- Giữ **1 replica**, vì phiên nằm trong RAM.
- Mỗi lần deploy lại, container mới thay container cũ, nên **mọi phiên đang mở bị xoá**. Nếu bật Auto Deploy (deploy mỗi lần push code), hãy push vào lúc không ai đang dùng.
- Không cần bật thêm Basic Auth ở tab Security của Dokploy, vì `CME_GUI_PASSWORD` đã làm việc đó. Chọn một trong hai, đừng bật cả hai.

## Cách khác: VPS + Cloudflare Tunnel + Cloudflare Access

Ứng dụng **không mở cổng nào ra internet**. Container `cloudflared` chủ động kết nối ra Cloudflare. Cloudflare lo HTTPS và bắt người dùng đăng nhập (bằng email công ty hoặc Google) trước khi tới được app. Gói miễn phí dùng được tới 50 người.

**Bạn cần có:**
- Một VPS Linux nhỏ (1 vCPU, 1–2 GB RAM, ổ đĩa 20 GB trở lên) đã cài Docker. Ví dụ Hetzner, DigitalOcean, Vultr.
- Một tên miền đang quản lý DNS trên Cloudflare.

### 1. Tạo tunnel
1. Vào [Cloudflare Zero Trust](https://one.dash.cloudflare.com), chọn **Networks → Tunnels → Create a tunnel**, chọn loại **Cloudflared**.
2. Đặt tên, ví dụ `confluence-md`. Ở bước cài connector, sao chép **token** (chuỗi dài sau `--token`).
3. Ở tab **Public Hostname**, thêm:
   - Subdomain: `confluence-md`. Domain: tên miền của bạn.
   - Service: `HTTP`, URL: `app:8080`.

### 2. Bật đăng nhập (Cloudflare Access)
1. Vào **Access → Applications → Add an application → Self-hosted**.
2. Ở Application domain, nhập `confluence-md.<tên-miền>`.
3. Tạo policy **Allow**, Include **Emails ending in** `@congty.com` (hoặc liệt kê từng email).

### 3. Chạy trên VPS
```bash
git clone https://github.com/marcus-GLAC/confluence-md-gui && cd confluence-md-gui
echo "TUNNEL_TOKEN=<token ở bước 1>" > .env
docker compose up -d --build
docker compose logs -f app      # xem log
```

Mở `https://confluence-md.<tên-miền>`, đăng nhập Cloudflare Access, rồi dùng như bản cài trên máy.

**Cập nhật bản mới:** `git pull && docker compose up -d --build`. Lưu ý: khởi động lại sẽ xoá các phiên đang mở.

## Cách khác: Fly.io / Render / Railway

Những nền tảng này cấp sẵn một địa chỉ công khai (`*.fly.dev`, `*.onrender.com`…). Địa chỉ đó **không đi qua Cloudflare Access**, nên bắt buộc phải đặt `CME_GUI_PASSWORD`. Trình duyệt sẽ hỏi mật khẩu: tên đăng nhập nhập gì cũng được, mật khẩu là giá trị bạn đặt.

- Build từ `Dockerfile` trong repo. App đọc cổng từ biến `$PORT`, các nền tảng này tự cấp biến đó.
- Gắn ổ đĩa (volume) vào `/data`. Nếu không gắn thì file nằm trên đĩa tạm của container, vẫn chạy được nhưng mất khi deploy lại.
- Chỉ chạy **1 instance**, vì phiên nằm trong RAM của từng máy.
- Ổ đĩa gắn vào thường thuộc quyền `root`, trong khi app chạy bằng user `10001`. Nếu log báo lỗi quyền ghi `/data`, hãy chuyển quyền sở hữu thư mục đó cho uid `10001`, hoặc đặt `CME_GUI_DATA_DIR=/tmp/cme-data`.

## Lưu ý về giới hạn thời gian của Cloudflare

Cloudflare ngắt một yêu cầu nếu máy chủ không trả lời trong khoảng 100 giây (lỗi 524). Export và push chạy nền nên không bị ảnh hưởng. Riêng nút **Tải .zip** đóng gói xong mới gửi file, nên nếu tải một lần quá nhiều tài liệu nặng thì có thể bị ngắt. Khi đó hãy tải thành nhiều lần nhỏ.

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `CME_GUI_PASSWORD` | (trống) | Mật khẩu chung (HTTP Basic). Bỏ trống nếu đã có Cloudflare Access. |
| `CME_GUI_ALLOWED_HOSTS` | `*.atlassian.net` | Các Confluence được phép export, cách nhau bằng dấu phẩy. Ví dụ `congty.atlassian.net`. |
| `CME_GUI_MAX_EXPORTS` | `2` | Số lượt export chạy cùng lúc. Người tới sau phải chờ. |
| `CME_GUI_SESSION_TTL_HOURS` | `12` | Phiên không dùng quá thời gian này thì bị xoá cùng toàn bộ file. |
| `CME_GUI_SECURE_COOKIE` | `1` | Đặt `0` **chỉ khi** thử nghiệm qua `http://` (không có HTTPS). |
| `CME_GUI_DATA_DIR` | `/data` | Nơi lưu thư mục tạm của các phiên. |
| `CME_GUI_GITHUB_CLIENT_ID` | (OAuth App có sẵn) | Dùng GitHub OAuth App riêng của công ty nếu muốn. |
| `PORT` | `8080` | Cổng lắng nghe. |

## Thử nhanh trên máy

```bash
CME_GUI_SECURE_COOKIE=0 CME_GUI_DATA_DIR=/tmp/cme-data uv run cme-gui --server --port 8080
# mở http://127.0.0.1:8080
```
