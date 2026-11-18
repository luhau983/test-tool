# Dell Inspect

Ứng dụng Electron tiếng Việt để kiểm tra laptop Windows cũ trước khi mua. Chạy offline, không cần cài Node.js trên máy được kiểm tra. Không phải phần mềm của Dell.

## Chạy ngay

Mở `release/v1.2.0/Dell-Inspect-1.2.0-portable.exe`. Có thể chép tệp EXE vào USB rồi mở trên chiếc laptop định mua. Hỗ trợ Windows 10/11 x64; không dành cho Windows 7 hay ARM64.

1. Cắm sạc, lưu công việc. Khi mở, ứng dụng tự quét cấu hình và điền Service Tag Dell đọc từ BIOS / SMBIOS. Đợi quét xong rồi bấm **Test toàn bộ**. Nếu đang tra một máy khác, có thể nhập mã riêng hoặc bấm **Dùng Tag máy này** để trở về mã của máy đang chạy. Máy không phải Dell sẽ được báo rõ, không lấy serial của hãng khác làm Service Tag Dell.
2. Ứng dụng đọc cấu hình/firmware rồi chấm sức khỏe ổ cứng (S.M.A.R.T.), chạy CPU 1 luồng 15 giây, RAM 64 MiB và thử ghi/đọc tệp 256 MiB có đo tốc độ. Bài thử ổ chạy lần lượt trên mọi ổ có ký tự ổ đĩa, không cần chọn thư mục.
3. Làm theo hướng dẫn màn hình, bàn phím, touchpad, loa, micro, webcam và pin; ở mỗi bước bấm **Đạt**, **Có lỗi** hoặc **Bỏ qua**. Ứng dụng không tự chấm đạt: chỉ lựa chọn của người thử được ghi vào biên bản. Kết thúc (hoặc bấm Dừng) sẽ mở trang **Kết quả lượt test**: số bước đạt / lỗi / bỏ qua, thời gian, ghi nhận từng bước (số phím đã nhận, số click, điểm ảnh nghi ngờ, kết quả CPU/RAM/ổ) và cấu hình máy. Thống kê này được đưa vào báo cáo HTML.
4. Trong biên bản, ghi kết quả thử từng cổng, mạng, pin, sạc, BIOS và ngoại hình. Xuất báo cáo HTML. Có thể mở bằng trình duyệt và in thành PDF.
5. Tab **Pin & sạc** hiển thị thiết kế / sạc đầy / độ chai / chu kỳ từ `powercfg`, trạng thái nguồn từ `GetSystemPowerStatus`, điện áp và công suất tức thời nếu `root/wmi BatteryStatus` cung cấp. Có thể chọn 2/10/30 phút, ghi điều kiện thử, rút sạc rồi bấm test. Lấy mẫu khoảng mỗi 15 giây cộng thời gian đọc thiết bị; ghi % bắt đầu/kết thúc, điểm % giảm, thời gian thực tế và biểu đồ, không dự đoán thời lượng chính xác. Không có pin hoặc thiếu dữ liệu thì không bắt đầu. Cắm sạc, gián đoạn trên 45 giây hoặc mức pin ≤5% sẽ kết thúc theo dõi; app không can thiệp cơ chế nguồn hay ngăn máy sập nếu pin lỗi. Dừng test pin trước khi đóng app.
6. Tab **Màn hình** có **Tự chạy màu test điểm chết**, tự đổi 7 màu/mẫu mỗi 3 giây. Click vị trí nghi ngờ để ghi tọa độ tham khảo; Esc thoát. Đây là quan sát của người kiểm tra, không phải phát hiện điểm chết vật lý tự động. Tọa độ CSS và DPR không bảo đảm trùng pixel vật lý trên panel. Không có vị trí đánh dấu không có nghĩa màn hình đạt.
7. Lưu báo cáo trước khi thoát / khởi động lại; dữ liệu đánh dấu chỉ giữ trong phiên ứng dụng, không tự lưu. Chạy Dell F12 → Diagnostics và F2 → BIOS riêng với người bán. Khởi động lại ứng dụng sẽ bắt đầu một phiên mới.

## Tra Dell theo Service Tag

Tab **Tra Dell API** có các cách:

- **Dell web · không cần khóa** (mặc định): POST đến `https://www.dell.com/support/assetdiscovery/en-vn/validate/asset`, với `Selection`, `appName=warranty` và các cờ tìm kiếm của website. Đây là endpoint web nhận diện / xác thực mã, không phải hợp đồng API TechDirect được bảo đảm ổn định. App hiện các trường JSON thực tế trả về, không tự suy đoán model hay bảo hành từ HTTP 200. Endpoint có thể chỉ trả thông tin định tuyến; nếu cần bảo hành đầy đủ, tra trang Dell hoặc dùng TechDirect.
- Nếu endpoint web bị HTTP 403, app báo yêu cầu bị chặn, không gọi mã máy là sai. Có nút **Mở trang Dell trong app** để xem trực tiếp trong một cửa sổ website không có Node/preload, tách khỏi giao diện local. Cửa sổ này và request web dùng chung một session chỉ ở RAM; không nhúng cookie sao chép từ Chrome vào mã nguồn hay bản EXE. Không bảo đảm mở website sẽ làm API hết bị chặn. Nút mở trình duyệt ngoài vẫn có sẵn.
- Có khóa: nhập Client ID và Client Secret đã được Dell TechDirect phê duyệt cho **Warranty API**, bấm dùng khóa cho phiên, rồi tra model / ngày xuất xưởng / quốc gia / từng dịch vụ bảo hành. Có tùy chọn tra trong lượt Test toàn bộ; mặc định tắt. API chính thức không phải API truy cập ẩn danh. Đăng ký ở [Dell TechDirect](https://techdirect.dell.com/).

OAuth POST `https://apigtwb2c.us.dell.com/auth/oauth/v2/token`; dữ liệu GET `https://apigtwb2c.us.dell.com/PROD/sbil/eapi/v5/asset-entitlements?servicetags=...`. Khóa chỉ ở RAM của main process; token được cache đến gần hạn. Không nhúng khóa trong EXE, lưu ra đĩa, hoặc xuất ra báo cáo. Khi đóng app phải nhập lại. Nếu chia sẻ app thì người dùng khác phải có quyền API riêng. Không nhập khóa bí mật vào chat.

Chỉ khi bạn bấm tra / chọn tra trong Test toàn bộ, Service Tag và yêu cầu xác thực mới được gửi đến Dell qua HTTPS. Không gửi cấu hình quét hay ảnh/âm thanh. Kết quả API được đưa vào báo cáo, có thời điểm tra và mã máy đã tra; có thể khác mã máy đang kiểm tra. Không có dữ liệu / bị từ chối / hết hạn truy cập được báo rõ, không biến thành “hết bảo hành”. API Warranty không được dùng để khẳng định toàn bộ cấu hình CPU/RAM/SSD xuất xưởng hay linh kiện hiện tại. Chưa xác minh bằng tài khoản TechDirect thật nếu chưa có khóa được duyệt; các kiểm thử API dùng phản hồi mô phỏng.

Nếu Windows hoặc phần mềm bảo vệ của người bán không cho phép chạy tệp EXE chưa ký số, không tắt bảo vệ để chạy. Thống nhất với người bán và dùng các bài chẩn đoán có sẵn của Dell. Bản build cá nhân chưa có chữ ký nhà phát hành.

## Cấu hình và firmware

- Quét trực tiếp máy đang chạy: CPU, RAM, GPU/driver/độ phân giải, máy/mainboard/BIOS/Service Tag, ổ và phân vùng, pin, thiết bị âm thanh/camera/Bluetooth/USB/mạng, Secure Boot/TPM và nhật ký hệ thống có chọn lọc.
- Hãng / model / Service Tag / BIOS / mainboard / CPU / khe RAM chỉ lấy từ bảng SMBIOS thô, không dùng Windows CIM (`Win32_ComputerSystem`, `Win32_BIOS`, `Win32_BaseBoard`, `Win32_Processor`, `Win32_PhysicalMemory`). Đọc SMBIOS lỗi thì các mục này hiện chưa xác định, không lấy dữ liệu Windows thay thế.
- **BIOS / SMBIOS:** `GetSystemFirmwareTable(RSMB)` đọc bảng firmware thô do Windows cung cấp; giải mã Type 0/1/2/3/4/16/17/22. Bảng tất cả cấu trúc giữ lại type, handle, phần byte định dạng và chuỗi, kể cả type OEM chưa giải mã. Có nút xuất chính xác bộ byte RSMB `.bin`, bao gồm header Windows 8 byte.
- Thông số khe RAM và mức tối đa do firmware báo có thể thiếu/sai hoặc khác giới hạn hỗ trợ của model. Số liệu BIOS không tự chứng minh máy chưa sửa hay pin/ổ chính hãng.
- Thiết lập Dell được đọc từ WMI `root/dcim/sysman/biosattributes` nếu có provider. Không ghi thiết lập, không gọi API thay BIOS, không đọc/bỏ qua mật khẩu. Máy không hỗ trợ hoặc không đủ quyền sẽ hiện chưa xác định. Không tự cài Dell Command Monitor.
- Bộ đếm ổ không đọc được thì để trống, không biến thành 0. `Healthy` của Windows chỉ dùng khi ổ không tự báo gì.

## Windows

Tab **Windows**: phiên bản (Edition, 25H2, build), ngày cài, khởi động lần cuối; **bản quyền / crack** kèm bằng chứng (trạng thái, kênh, 5 ký tự cuối của khóa, khóa OEM trong BIOS, máy chủ KMS, domain, dấu vết công cụ crack); **thời điểm kích hoạt**; bảo mật (Secure Boot, TPM, Defender / phần mềm diệt virus); **tài khoản trên máy** (gồm tài khoản người bán để lại); bản cập nhật gần đây; nút mở nhanh Cài đặt Windows (Kích hoạt, Cơ quan / trường học, Windows Update, Tài khoản, Windows Security, Reset, Thông tin máy) — app chỉ mở trang Cài đặt, không tự thay đổi.

- Windows không lưu ngày kích hoạt. App đọc các lần kiểm tra bản quyền (Security-SPP, event 1003) trong nhật ký Application: lần cũ nhất đã thấy *đã kích hoạt* là mốc “ít nhất từ”; nếu trước đó có lần *chưa kích hoạt* thì ra khoảng thời gian.

- **Microsoft Office**: *Office bản quyền* / *Microsoft 365 (thuê bao)* / *Có dấu hiệu crack* / *Nghi crack (KMS)* / *Bản quyền doanh nghiệp* / *Chưa kích hoạt*. Bằng chứng: sppc.dll giả trong thư mục Office (Ohook), dấu vết công cụ crack, khóa Volume (GVLK) trên máy không thuộc domain kèm các yêu cầu KMS gửi tới máy chủ bên ngoài (đọc từ nhật ký SPP, sự kiện 12288).
- **Quản lý thiết bị (MDM)**: *Đăng ký Autopilot của tổ chức* (cài lại Windows vẫn bị bắt đăng nhập tài khoản công ty — nặng nhất) / *Đang bị quản lý (MDM)* (Intune…) / *Gia nhập tổ chức* (Azure AD / domain) / *Có phần mềm quản lý từ xa* (SCCM, Absolute, NinjaRMM, ManageEngine…) / *Không bị quản lý*. Nguồn: `dsregcmd /status`, `HKLM\SOFTWARE\Microsoft\Enrollments`, `Provisioning\Diagnostics\Autopilot`, danh sách dịch vụ — tất cả chỉ đọc.

- **Đối chiếu Windows ↔ phần cứng**: những gì Windows lấy từ registry (sửa được bằng regedit) được đọc lại từ nguồn không sửa được rồi so: CPU từ CPUID (kernel), Edition từ mã SKU bản quyền, build từ RtlGetVersion, card đồ họa từ PCI ID, model ổ từ lệnh IDENTIFY của ổ, khóa OEM từ bảng ACPI MSDM trong BIOS (chỉ hiện 5 ký tự cuối). App hiển thị giá trị thật; mục nào khác Windows bị đánh dấu "bị sửa". Model, Service Tag, BIOS, RAM vẫn đọc từ bảng SMBIOS như trước.

## RAM

Tab **RAM** đọc từ bảng SMBIOS: từng khe (trống / có RAM), dung lượng, loại DDR, dạng (SO-DIMM / hàn trên bo), tốc độ định mức và đang chạy, hãng (mã JEDEC hoặc suy từ part number), part number, serial, rank, điện áp, kênh. Nhận xét: kênh đôi / đơn, RAM chạy chậm hơn định mức, khác loại, còn khe nâng cấp, dung lượng Windows dùng được.

Kiểm tra RAM:
- **Thử nhanh**: 64 MiB, 4 mẫu (vài giây).
- **Thử sâu**: 25 / 50 / 75% RAM đang trống (luôn chừa 1,5 GiB để Windows không đẩy RAM ra ổ), 5 bài: địa chỉ trong ô nhớ, đảo bit 0/1, bàn cờ 1010/0101, bit chạy, ngẫu nhiên. Khoảng 3–6 giây mỗi GiB. Báo từng lỗi (bài, đoạn, byte, giá trị cần / đọc được, số bit sai). Chỉ kiểm được phần RAM Windows cấp cho app.
- **Windows Memory Diagnostic**: nút mở công cụ có sẵn của Windows (cần quyền quản trị, khởi động lại rồi quét toàn bộ RAM). Lần quét sau app đọc kết quả từ nhật ký System (`MemoryDiagnostics-Results`).

## Thông tin hiển thị

Mỗi tab mở đầu bằng các thẻ tổng quan. Font Open Sans (OFL, đóng gói trong `src/fonts`, không tải từ mạng), cỡ chữ gốc 15px (chữ thường ~13px).

## Sử dụng

- **Số lần sập** (nhật ký System): màn hình xanh kèm mã lỗi, mất điện / treo cứng, giữ nút nguồn để tắt; lỗi phần cứng WHEA (RAM, PCIe, CPU).
- **Mốc dùng máy lần đầu**: ngày thiết lập Windows (sự kiện đầu tiên trong nhật ký Setup, ngày tạo tài khoản đầu tiên), ngày cài Windows gốc / hiện tại, ước tính ngày ổ cứng bật lần đầu. Windows không lưu ngày kích hoạt quá hạn nhật ký; máy tự kích hoạt ở lần có mạng đầu tiên sau khi thiết lập.

Tab **Sử dụng** dựng lại các lần dùng máy từ nhật ký System (Kernel-General 12/13, Kernel-Power 41/42/107/506/507, Power-Troubleshooter 1): bắt đầu, kết thúc, thời lượng, mở bằng (bật máy / khởi động lại / thức dậy), kết thúc bằng (tắt máy / ngủ / mất điện–treo / đang chạy); tổng giờ, trung bình mỗi ngày, số lần tắt đột ngột và biểu đồ giờ dùng 30 ngày. Nhật ký giới hạn dung lượng và có thể bị xóa nên đây không phải tuổi máy.

## Giao diện

Nút mặt trời / mặt trăng trên thanh trên chuyển sáng / tối (nhớ lựa chọn; lần đầu theo cài đặt Windows). Thanh tiến độ khi quét nằm ngay dưới thanh trên.

## Ổ cứng (S.M.A.R.T.)

Tab **Ổ cứng** hiển thị từng ổ dạng tab: ô *Tình trạng sức khỏe* (Tốt / Cẩn thận / Xấu / Chưa rõ, kèm %), ô *Nhiệt độ*, firmware, serial, giao tiếp, chế độ truyền (SATA/600…), chuẩn, tính năng (TRIM, NCQ…), tổng đọc/ghi, số giờ chạy, số lần bật, bảng thuộc tính S.M.A.R.T. và nút thử ghi/đọc đo tốc độ.

- Dữ liệu đọc thẳng từ driver lưu trữ (`src/smart.ps1`, giải mã ở `src/disk-health.cjs`), không qua WMI:
  - NVMe: Identify Controller + SMART / Health Information (log 02h). Không cần quyền quản trị.
  - SATA: IDENTIFY DEVICE + Device Statistics (log 04h: giờ chạy, số lần bật, LBA ghi/đọc, nhiệt độ, % hao mòn). Không cần quyền quản trị.
  - SATA: bảng thuộc tính SMART (SMART READ DATA / THRESHOLDS) **cần quyền quản trị**. Sau mỗi lần quét, nếu có ổ cần quyền, app tự mở hộp thoại UAC của Windows để bạn bấm Yes; chỉ trình đọc SMART chạy bằng quyền quản trị. Bấm No thì app không hỏi lại trong phiên đó; nút *Đọc bằng quyền quản trị* trên tab Ổ cứng để hỏi lại.
- Quy tắc chấm (của app, không phải của hãng): **Xấu** khi thuộc tính ≤ ngưỡng, NVMe Critical Warning bit 0/2/3, dự phòng dưới ngưỡng hoặc hết độ bền; **Cẩn thận** khi có sector remap / pending / uncorrectable (05, C5, C6), lỗi Media Errors, lỗi đọc không sửa được, quá nhiệt hoặc độ bền còn ≤ 10%.
- *Bật lần đầu*: ổ không lưu ngày này; app hiện mốc “trước <hôm nay − số giờ chạy>”, lần bật đầu thật còn sớm hơn.
- *Tuổi thọ SSD*: % độ bền còn lại (ổ tự báo Percentage Used), tổng đã ghi, GB ghi mỗi giờ chạy và ước tính thời gian còn lại theo tốc độ hao mòn đến nay, giả định 8 giờ/ngày. Đây là ước tính tuyến tính, không phải bảo hành.
- USB / RAID có thể không trả dữ liệu SMART qua driver; khi đó app ghi lý do và để *Chưa rõ*.
- Tổng quan có **ngày cài Windows** (`Win32_OperatingSystem.InstallDate`, đổi khi cài lại, không phải ngày xuất xưởng), **bản quyền Windows** (`SoftwareLicensingProduct`: trạng thái kích hoạt, kênh OEM / Retail / Volume; chỉ lưu 5 ký tự cuối của khóa) và **chu kỳ sạc pin** (`powercfg`, thiếu thì lấy `root/wmi BatteryCycleCount`). Từ 500 chu kỳ được đánh dấu lưu ý (ngưỡng gợi ý của app).
- **Bản quyền hay crack**: kết luận *Bản quyền hợp lệ* / *Có dấu hiệu crack* / *Nghi crack (KMS)* / *Bản quyền doanh nghiệp* / *Chưa kích hoạt*, kèm bằng chứng:
  - Dấu vết công cụ crack (chỉ đọc): thư mục KMSpico, KMSAutoS, AAct_Tools, Online_KMS_Activation, SECOH-QAD / SppExtComObjHook trong System32; dịch vụ KMSELDI / AutoKMS; tác vụ hẹn giờ AutoPico, KMS_VL_ALL, Activation-Renewal…; hook registry `SppExtComObj.exe`.
  - KMS38: hạn kích hoạt KMS vượt xa 180 ngày (tới 2038).
  - Máy chủ KMS là localhost / IP nội bộ trên máy không thuộc domain (giả lập KMS).
  - Khóa KMS (GVLK) trên máy không thuộc domain → nghi crack KMS online; thuộc domain → bản quyền doanh nghiệp.
  - Giới hạn: kích hoạt HWID trái phép trông giống hệt bản quyền số thật, app không loại trừ được hoàn toàn. Dấu vết đã bị xóa sạch cũng không phát hiện được.
- Pin dùng `powercfg /batteryreport /xml`; chai = `max(0, 100 − FullChargeCapacity/DesignCapacity × 100)`. Ngưỡng 30% chỉ là gợi ý của app, không phải tiêu chuẩn Dell. Dữ liệu bất thường/thiếu được giữ chưa xác định. Không dự đoán thời lượng từ độ chai.
- Tên các cột kỹ thuật giữ nguyên để dễ đối chiếu nguồn. Băng thông, nhiệt độ CPU/GPU, VRAM chính xác, số giờ dùng máy tổng cộng, lịch sử sửa chữa, BIOS password, mọi chức năng cổng và quyền sở hữu không được khẳng định tự động.

## Giới hạn bài thử

Không có phần mềm Windows nào kiểm tra tuyệt đối toàn bộ máy. CPU chỉ tải 1 luồng ngắn; RAM chỉ một vùng nhớ của ứng dụng (có thể nằm trong bộ nhớ ảo); ổ chỉ thử một tệp có thể qua cache. Không quét mọi sector, không stress GPU, không đo nhiệt độ CPU và không thay thế Dell ePSA / chẩn đoán RAM sâu. Từng chức năng chỉ xác nhận được bằng điều kiện thử phù hợp.

Loa có âm kiểm tra 1 giây ở mức tín hiệu thấp; vẫn phải tự chỉnh âm lượng Windows phù hợp. Webcam/mic có danh sách chọn và dò lại thiết bị; chỉ bật khi bấm nút, tự tắt khi đổi tab trong app hoặc app bị ẩn. Bản ghi micro giữ trong RAM để nghe lại, không xuất trong báo cáo. Không có telemetry hoặc upload ảnh/âm thanh; kết nối Dell chỉ theo hành động tra cứu đã mô tả trên.

App chạy quyền người dùng thường; chỉ trình đọc SMART của ổ SATA xin quyền quản trị qua hộp thoại UAC (xem mục Ổ cứng). Không chỉnh BIOS, registry, driver, dịch vụ hoặc tự khởi động lại. Bài thử ổ tạo một thư mục tên ngẫu nhiên trên ổ cần thử (thư mục Temp nếu là ổ hệ thống, gốc ổ với ổ khác) rồi xóa ngay sau bài thử; ghi tạm 256 MiB – 16 GiB tùy lựa chọn (cần trống thêm 1 GiB), ghi thẳng xuống ổ (write-through) và lấy mẫu tốc độ suốt quá trình để thấy lúc bộ đệm SLC của SSD đầy. Tốc độ đọc có thể đến từ bộ nhớ đệm Windows nên chỉ để tham khảo.

## Phát triển / build

```text
npm ci
npm start
npm test
npm run test:e2e
npm run dist
```

Node.js 22.12+; Electron, electron-builder, Tailwind CSS và daisyUI khóa phiên bản trong package-lock.json. Giao diện dùng component [daisyUI](https://daisyui.com/components/) (theme `inspect` trong `styles/app.css`); `npm run build:css` biên dịch ra `src/app.css` để app chạy offline, không tải CSS từ CDN. `npm start` và `npm run dist` tự build CSS trước. Nếu môi trường bỏ qua install script, chạy `node node_modules/electron/install.js` để tải runtime trước khi mở app. Giữ `src/collect.ps1` dạng UTF-8 **có BOM** để tương thích Windows PowerShell 5.1. Mã nguồn `src/`, kiểm thử `tests/`. `npm run test:e2e` chạy app Electron thật ở chế độ ẩn và thử toàn bộ chức năng (quét, Test toàn bộ + thống kê, CPU/RAM/ổ, màn hình, bàn phím, touchpad, âm thanh/camera, pin, tra Dell, biên bản, bảo mật IPC); dialog, liên kết ngoài và Dell được giả lập nên không gửi gì ra mạng.

Renderer tắt Node integration, bật sandbox/context isolation, CSP giới hạn tài nguyên nội bộ. IPC chỉ cho phép các lệnh cố định từ trang local chính. Báo cáo escape dữ liệu; raw scan và media không được tự gửi đi.

## Nguồn kỹ thuật

- [Microsoft GetSystemFirmwareTable](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-getsystemfirmwaretable)
- [DMTF SMBIOS specification](https://www.dmtf.org/standards/smbios)
- [Dell BIOS WMI attributes](https://downloads.dell.com/manuals/common/dell-agentless-client-manageability.pdf)
- [Microsoft storage reliability counters](https://learn.microsoft.com/en-us/powershell/module/storage/get-storagereliabilitycounter)
- [Microsoft powercfg](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/powercfg-command-line-options)
- [Dell F12 Diagnostics](https://www.dell.com/support/kbdoc/en-us/000181163/how-to-enter-the-built-in-diagnostics-32-bit-diagnostics-supportassist-epsa-epsa-and-psa)
- [Dell F2 battery / adapter](https://www.dell.com/support/contents/en-us/videos/videoplayer/check-ac-adapter-and-battery-status-in-bios/6176627522001)
