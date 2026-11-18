(function(){
function mediaError(error,kind){
  const device=kind==='camera'?'camera':'micro';
  const messages={
    NotFoundError:`Windows chưa cung cấp thiết bị ${device} nào cho ứng dụng. Nếu máy không có ${device}, chọn “Không có / bỏ qua”. Nếu có, thử ứng dụng Camera / ghi âm của Windows, kiểm tra công tắc vật lý và Device Manager.`,
    DevicesNotFoundError:`Không tìm thấy ${device}. Cắm thiết bị rồi bấm dò lại.`,
    NotAllowedError:`Quyền ${device} bị từ chối. Kiểm tra quyền truy cập thiết bị cho ứng dụng desktop trong cài đặt Windows.`,
    PermissionDeniedError:`Quyền truy cập ${device} bị từ chối. Kiểm tra cài đặt Windows.`,
    NotReadableError:`Có thiết bị ${device} nhưng không đọc được. Đóng Teams, Zoom, Camera hoặc ứng dụng đang dùng thiết bị; kiểm tra driver rồi thử lại.`,
    TrackStartError:`Không khởi động được ${device}. Có thể thiết bị đang bận hoặc driver gặp lỗi.`,
    OverconstrainedError:`Thiết bị ${device} không đáp ứng chế độ yêu cầu. Chọn thiết bị khác hoặc dò lại.`,
    AbortError:`Windows đã ngắt mở ${device}. Thử lại hoặc cắm lại thiết bị.`,
    SecurityError:`Truy cập ${device} bị hệ thống chặn. Kiểm tra chính sách thiết bị với chủ máy.`
  };
  return messages[error?.name] || `Không mở được ${device}: ${error?.message || 'lỗi chưa xác định'}. Chưa đủ dữ liệu để kết luận phần cứng hỏng.`;
}
if(typeof module!=='undefined')module.exports={mediaError};else window.mediaErrors={mediaError};
})();
