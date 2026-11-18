# CLAUDE.md — Test tool

Ứng dụng Electron (Windows 10/11 x64) để kiểm tra laptop/PC cũ trước khi mua. Giao diện tiếng Việt, chạy offline, build ra EXE portable.
Trả lời người dùng bằng tiếng Việt, ngắn gọn. Chi tiết tính năng cho người dùng nằm ở README.md; file này dành cho người sửa code.

## Lệnh

```bash
pnpm install --frozen-lockfile   # pnpm 10 (packageManager trong package.json)
pnpm start                       # build CSS rồi mở app
pnpm test                        # unit test (node:test, tests/*.test.cjs)
pnpm test:e2e                    # chạy app Electron thật ở chế độ ẩn, thử toàn bộ chức năng (~5 phút)
pnpm dist                        # build CSS + EXE portable → release/v<version>/Test-tool-<version>-portable.exe
pnpm build:css                   # styles/app.css → src/app.css (Tailwind v4 + daisyUI 5)
```

- Sửa xong luôn chạy `pnpm test` và `pnpm test:e2e`; kết quả E2E in dòng `N/N nhóm chức năng đạt`.
- Khởi động lại app: `taskkill //F //IM electron.exe` rồi `pnpm start` (chạy nền). Bản build: `taskkill //F //IM "Test tool.exe"`.
- E2E và app thật cùng ghi `%APPDATA%\test-tool`: tắt app trước khi chạy E2E.
- Electron 45 không có install script; file chạy Electron tự tải ở lần chạy đầu. `pnpm-workspace.yaml` liệt kê các install script cố ý bỏ qua.
- Git: repo `github.com/luhau983/test-tool`, nhánh `main`, push qua SSH. Chỉ commit / push khi người dùng bảo. Mẫu commit: `[type] mô tả` + gạch đầu dòng (type: feat, fix, refactor, perf, test, docs, chore).
- `release/` và `node_modules/` không vào git (file Electron > 100 MB).

## Kiến trúc

| File | Vai trò |
|---|---|
| `src/main.cjs` | Main process: cửa sổ, IPC, chạy PowerShell, worker bài thử, xuất biên bản |
| `src/preload.cjs` | `window.inspect.*` qua contextBridge (renderer sandbox, không Node) |
| `src/renderer.js` + `src/index.html` | Toàn bộ giao diện; mỗi tab là `<section class="page">`, điều hướng bằng `go(page)` |
| `src/assessment.cjs` | Logic đánh giá thuần (UMD: dùng được ở renderer và Node). Phần lớn unit test nhắm vào đây |
| `src/collect.ps1` | Bộ thu thập: mỗi `Section 'tên' { ... }` thành `report.sections.tên = {status,data,error}` |
| `src/smart.ps1` | Đọc SMART/NVMe bằng IOCTL (C# nhúng); chạy lại có quyền admin khi cần |
| `src/keyboards.ps1` | Danh sách bàn phím đang kết nối (gộp theo thiết bị vật lý) |
| `src/battery-sample.ps1` | Mẫu pin tức thời cho bài theo dõi tụt pin |
| `src/smbios.cjs` | Giải mã bảng SMBIOS thô (RSMB) → `smbios*` sections |
| `src/disk-health.cjs` | Giải mã SMART/NVMe → `report.diskDetails` |
| `src/usage-history.cjs` | Phiên bật/tắt máy từ nhật ký → `report.usage` |
| `src/diagnostic-worker.cjs` | worker_threads: CPU, RAM nhanh, RAM sâu (`memoryDeep`), ghi/đọc ổ (`disk`) |
| `src/warranty-api.cjs`, `src/warranty-web.cjs` | Tra bảo hành theo số serial (API có khóa / trang hỗ trợ không khóa) |
| `src/report.cjs` | Biên bản HTML |
| `styles/app.css` → `src/app.css` | Theme `inspect` (sáng) / `inspect-dark`, font Open Sans trong `src/fonts` |

Luồng quét: `main.cjs` chạy `collect.ps1 -OutputPath <tmp>` → JSON → `enrichUsage(enrichDisks(enrichFirmware(report)))` → gửi renderer → `renderScan()` vẽ lại mọi tab và `renderSummary()` cho thẻ tổng quan đầu mỗi tab.

Tab (key trong `pages` của renderer): overview, hardware, disks, memory, windows, usage, firmware, warranty, battery, screen, input, media, diagnostics, summary, checklist.

IPC (đều qua `handle()` kiểm tra nguồn gọi là trang local): scan, disk-smart-admin, list-keyboards, battery-current/start/stop, warranty-config/web-lookup/browser/lookup/support, export-firmware, diagnostic, stop-test, open-tool, export.

## Nguyên tắc dữ liệu (quan trọng)

- **Đọc từ phần cứng / firmware / kernel, không tin registry Windows** (sửa được bằng regedit):
  - Model, số serial, BIOS, RAM: bảng SMBIOS thô.
  - CPU: CPUID qua `NtQuerySystemInformation(105)`.
  - Edition: `GetProductInfo`; build: `RtlGetVersion`.
  - GPU: PCI ID + tên trong file INF driver có chữ ký WHQL (`Get-AuthenticodeSignature`).
  - Model ổ: lệnh IDENTIFY. Khóa OEM: bảng ACPI MSDM (chỉ xuất 5 ký tự cuối).
  - Registry chỉ dùng để **so sánh** và đánh dấu "bị sửa" (`hardwareTruth` trong `assessment.cjs`, bảng "Đối chiếu Windows ↔ phần cứng").
- **Không bịa:** dữ liệu thiếu thì ghi "chưa xác định", không suy đoán thành kết luận. Ngưỡng tự đặt phải ghi rõ là gợi ý của app.
- **Chỉ đọc:** app không ghi thiết lập BIOS / Windows, chỉ mở trang Cài đặt (`open-tool`). Thay đổi có rủi ro phải được người dùng duyệt.
- **Không nhắc tên Dell** ở giao diện, biên bản, README, tên file, tên biến. Ngoại lệ duy nhất: URL máy chủ hãng trong `warranty-api.cjs` / `warranty-web.cjs` (`TOKEN_URL`, `WARRANTY_URL`, `PORTAL_URL`, `SUPPORT_HOST`) và tên trường JSON do API của hãng quy định (`serviceTag`, `servicetags`). Trong giao diện dùng "số serial", "hãng", "Tra bảo hành", "chẩn đoán tích hợp của hãng (F12)".
- Bí mật: khóa API chỉ giữ trong RAM của main process, không lưu đĩa, không đưa vào biên bản.

## Quy ước code

- **PowerShell `.ps1` phải là UTF-8 có BOM** (Windows PowerShell 5.1); `tests/core.test.cjs` kiểm tra BOM. Khi sửa bằng script, đọc `utf-8-sig` và ghi lại có BOM.
- PowerShell: `$(if (x) { a })` thiếu `else { $null }` sẽ ra `{}` trong JSON. Luôn có `else { $null }`.
- Thêm section mới vào `collect.ps1`:
  1. Nếu là dữ liệu thô / nội bộ, thêm key vào danh sách loại trừ của bảng phần cứng (`renderer.js`, dòng lọc `hardwareSections`) và của `report.cjs`.
  2. Thêm key vào danh sách section phải `ok` trong `tests/e2e-full.cjs`.
  3. Script `.ps1` mới phải thêm vào `asarUnpack` trong `package.json`.
- Tailwind chỉ quét `src/index.html` và `src/renderer.js`: tên class phải viết **nguyên chữ** trong code, không ghép chuỗi. Rule daisyUI không nằm trong layer nên override cần `!important`. Màu dark mode: override trong `styles/app.css` với `[data-theme="inspect-dark"]`.
- Nút sinh ra lúc render (`data-goto`, `data-tool`, `data-test`, `data-mem-share`) dùng **event delegation** ở `document`, không gắn trực tiếp.
- Mỗi tab có thẻ tổng quan: thêm builder vào `SUMMARIES` trong renderer + `<div class="page-summary" data-summary="tab">` trong HTML.
- Logic thuần đặt trong `assessment.cjs` (export qua `api`) để unit test được; renderer chỉ vẽ.
- File I/O bài thử ổ: ghi với cờ write-through `0x04000000`, đọc lại với cờ unbuffered `0x02000000` (bỏ qua cache Windows, buffer `Buffer.allocUnsafeSlow`). Đọc qua cache cho số ảo (vd. 11 GB/s).
- RAM sâu: kích thước = % RAM đang trống, luôn chừa 1,5 GiB (`memoryTestMiB` trong main), chia khối 256 MiB.
- Tham số thứ 3 của IPC `diagnostic` là MiB cho `disk`, là % RAM trống cho `memoryDeep`.
- Cỡ chữ gốc 15px (`html` trong `styles/app.css`); 1rem = 15px (thanh bên 4rem = 60px, 14rem = 210px; E2E kiểm số này).
- Không có `any`; thông báo lỗi tiếng Việt, cụ thể, nói cách xử lý.

## E2E (`tests/e2e-full.cjs`)

- Chạy app thật, cửa sổ ẩn; dialog, liên kết ngoài, API / trang bảo hành đều được giả lập, không gửi gì ra mạng. Biến môi trường `QA_APP_DIR=<thư mục app đã giải nén>` để thử bản build.
- `disk-smart-admin` bị giả lập là người dùng hủy UAC.
- Cửa sổ test nhỏ: phần tử ở cuối trang (vd. vùng touchpad) phải `scrollIntoView` trước khi gửi click bằng tọa độ.
- Đếm kết quả trong `#testResults` theo **chênh lệch trước/sau** vì bước trước có thể đã thêm kết quả.
- Kiểm tra cú pháp trước khi chạy: `node --check tests/e2e-full.cjs`. Lỗi cú pháp sẽ bật hộp thoại Electron và treo lệnh.

## Môi trường máy dev

- Windows 11, PowerShell 5.1 cho script của app. Bash tool là Git Bash: dùng `//F` cho taskkill.
- UAC ở máy này tự nâng quyền không hỏi (ConsentPromptBehaviorAdmin = 0), nên không thấy popup UAC khi thử.
- Máy dev là PC để bàn: SSD SATA KIOXIA + NVMe Lexar NQ780, RAM 2×16 GB DDR4-3600, GTX 1050 Ti, Windows 11 Pro Retail. Không có pin, không có màn hình laptop: test pin / màn hình laptop chỉ chạy được bằng dữ liệu giả lập.
- Dữ liệu app: `%APPDATA%\test-tool` (chỉ cài đặt giao diện + cache Chromium). Kết quả quét chỉ nằm trong RAM; file tạm `test-tool-*` trong `%TEMP%` bị xóa sau khi dùng.

## Việc còn mở

- EXE chưa ký số (SmartScreen sẽ cảnh báo).
- Phần đọc kết quả Windows Memory Diagnostic mới chỉ được kiểm bằng dữ liệu giả lập: chưa chạy mdsched thật vì nó khởi động lại máy.
- Tra bảo hành bằng API có khóa chưa được kiểm với tài khoản thật.
- Version vẫn là 1.2.0; build mới ghi đè file cũ trong `release/v1.2.0/`.
