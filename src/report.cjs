const {assess,data} = require('./assessment.cjs');
const escape = value => String(value ?? '—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Statistics table for the latest "Test toàn bộ" run; empty string when there was no run.
function runSection(run) {
  if (!run) return '';
  const count = label => run.steps.filter(s => s.status === label).length;
  const seconds = Math.max(0, Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000));
  const span = Number.isFinite(seconds) ? `${Math.floor(seconds / 60)} phút ${seconds % 60} giây` : '—';
  return `<h2>Kết quả lượt Test toàn bộ</h2><p>Bắt đầu ${escape(run.startedAt)} · thời gian ${escape(span)}${run.stopped ? ' · <b>dừng giữa chừng</b>' : ''}</p>
  <p><b>Đạt ${count('Đạt')}</b> · <b class="fail">Có lỗi ${count('Có lỗi')}</b> · Bỏ qua ${count('Bỏ qua')}</p>
  <table><tr><th>Bước</th><th>Kết quả</th><th>Ghi nhận</th></tr>${run.steps.map(s => `<tr><td>${escape(s.title)}</td><td class="${s.status === 'Có lỗi' ? 'fail' : ''}">${escape(s.status)}</td><td>${escape(s.detail)}</td></tr>`).join('')}</table>`;
}
function makeReport(scan, manual, diagnostics, notes, run = null) {
  const time = new Date().toLocaleString('vi-VN');
  const sections = Object.entries(scan?.sections || {}).filter(([key])=>!['firmwareRaw','smartRaw','powerEvents','office','mdm','hardwareTruth','stability','firstUse'].includes(key)).map(([key,section])=>`<h2>${escape(key)}</h2>${section.status !== 'ok' ? `<p>Chưa xác định: ${escape(section.error)}</p>` : section.data.length ? `<div class="table"><table><thead><tr>${Object.keys(section.data[0]).map(k=>`<th>${escape(k)}</th>`).join('')}</tr></thead><tbody>${section.data.map(row=>`<tr>${Object.keys(section.data[0]).map(k=>`<td>${escape(row[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p>Không có dữ liệu. Không có nghĩa là đạt.</p>'}`).join('');
  return `<!doctype html><html lang="vi"><meta charset="UTF-8"><title>Báo cáo Test tool</title><style>body{font:15px/1.6 Segoe UI,sans-serif;max-width:1120px;margin:40px auto;padding:0 24px;color:#193041}h1{color:#087d72}h2{margin-top:32px}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #d9e3e6;padding:9px;text-align:left;vertical-align:top;white-space:pre-wrap;word-break:break-word}.table{overflow:auto}th{background:#eff5f5}.warn,.fail{color:#a64022}.unknown{color:#72613b}small{color:#586e7b}@media print{body{margin:0}table{table-layout:fixed}}</style>
  <h1>Test tool / Biên bản kiểm tra laptop</h1><p>Xuất lúc ${escape(time)} · Quét lúc ${escape(scan?.collectedAt || 'Chưa quét')}</p><p>${escape(data(scan,'smbiosSystem')[0]?.Product)} · Service Tag: ${escape(data(scan,'smbiosSystem')[0]?.SerialNumber)} <small>(SMBIOS)</small></p>
  <p><b>Không phải chứng nhận toàn bộ máy đạt.</b> Kết quả là ảnh chụp tại thời điểm kiểm tra. Phần mềm không xác nhận máy chưa sửa, pin chính hãng, nguồn gốc, khóa BIOS, mọi ô RAM hay mọi sector ổ đĩa. Số 0 do driver báo cũng có thể không phản ánh đầy đủ.</p>
  ${runSection(run)}
  <h2>Điểm cần chú ý</h2>${assess(scan).map(c=>`<p class="${c.state}"><b>${escape(c.title)}</b><br>${escape(c.detail)}</p>`).join('')}
  <h2>Thử trực tiếp (người kiểm tra tự đánh dấu)</h2><table><tr><th>Hạng mục</th><th>Kết quả</th><th>Ghi chú</th></tr>${manual.map(m=>`<tr><td>${escape(m.title)}</td><td>${escape(m.status)}</td><td>${escape(m.note)}</td></tr>`).join('')}</table>
  <h2>Bài thử trong ứng dụng</h2>${diagnostics.length ? diagnostics.map(d=>`<p><b>${escape(d.title)}</b> · ${escape(d.state)} · ${escape(d.at)}<br>${escape(d.detail)}</p>`).join('') : '<p>Chưa chạy bài thử CPU / RAM / tệp.</p>'}
  <h2>Ghi chú mua máy</h2><p style="white-space:pre-wrap">${escape(notes)}</p>${sections}
  <h2>Kiểm tra thêm trên Dell</h2><p>Khởi động máy, nhấn F12 tại logo Dell → Diagnostics. Ghi lại error code, validation code nếu có. Vào BIOS bằng F2 để kiểm tra Service Tag, Battery Health, AC Adapter và mật khẩu BIOS với người bán. Ứng dụng không tự khởi động lại máy.</p>
  <p>Nguồn: <a href="https://www.dell.com/support/kbdoc/en-us/000181163/how-to-enter-the-built-in-diagnostics-32-bit-diagnostics-supportassist-epsa-epsa-and-psa">Dell Diagnostics</a> · <a href="https://www.dell.com/support/contents/en-us/videos/videoplayer/check-ac-adapter-and-battery-status-in-bios/6176627522001">Dell BIOS pin / sạc</a> · <a href="https://learn.microsoft.com/en-us/powershell/module/storage/get-storagereliabilitycounter">Microsoft bộ đếm ổ đĩa</a></p></html>`;
}
module.exports={escape,makeReport};
