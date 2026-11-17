# Cảnh báo biển báo cho xe máy — Hà Nội (web app)

Web app chạy trên trình duyệt điện thoại. Không cần build, chỉ là file tĩnh.

## Đưa lên mạng

GPS trên trình duyệt chỉ chạy khi trang mở bằng `https://`, nên phải đặt app lên một chỗ có HTTPS. Một trong các cách:

- **Netlify Drop** (nhanh nhất): vào app.netlify.com/drop, kéo cả thư mục này vào, nhận link https.
- **GitHub Pages**: đẩy thư mục lên một repo, bật Pages (Settings → Pages → branch main, thư mục root).
- **Cloudflare Pages**, hoặc S3 + CloudFront nếu đã có AWS.

Thử trên máy tính trước (localhost cũng được coi là an toàn nên GPS và mô phỏng đều chạy):

```
npx serve .
```

Trên điện thoại: mở link, chọn "Thêm vào màn hình chính" để dùng như app.

## Dùng lần đầu

1. Mục **Dữ liệu trên máy** → **Tải nội thành Hà Nội**. App tải dữ liệu đường từ OpenStreetMap qua Overpass API (12 ô, vài phút; nên dùng Wi-Fi). Dữ liệu lưu trong máy, lần sau không phải tải lại.
2. Nếu có Mapillary access token (miễn phí, tạo tại mapillary.com/dashboard/developers): dán vào ô token → **Tải biển Mapillary nội thành**.
3. Thử ở chế độ **Mô phỏng trên bản đồ**: phóng to bản đồ, chạm để vẽ tuyến, bấm Bắt đầu.
4. Ra đường: chế độ **GPS thật** → Bắt đầu. Màn hình được giữ sáng; tắt màn hình hoặc chuyển app khác thì trình duyệt sẽ dừng GPS.

## App cảnh báo gì

Theo dữ liệu đường OSM:
- Đi ngược chiều đường một chiều (báo sau khoảng 2 giây, lặp lại mỗi 20 giây nếu vẫn đi ngược).
- Đường phía trước cấm xe máy, hoặc là đường một chiều ngược hướng.
- Đang đi trên đường cấm xe máy, kể cả cấm theo giờ (`motorcycle:conditional`) và cao tốc.
- Giới hạn tốc độ của đoạn đường (tag `maxspeed`), và cảnh báo khi chạy quá 3 km/h.

Theo biển báo (OSM, Mapillary, biển tự thêm): biển phía trước theo hướng đi, lọc theo loại xe và khung giờ.

## Dữ liệu và độ tin cậy

- OSM ở Hà Nội có khá đủ đường một chiều; giới hạn tốc độ và cấm xe máy theo giờ thì thiếu nhiều. Mục Dữ liệu cho biết đã tải được bao nhiêu đoạn mỗi loại.
- Biển OSM chỉ dùng được khi nằm trên đường và có `direction=forward/backward`; các biển còn lại bị bỏ qua và app có báo số lượng.
- Biển Mapillary do máy nhận diện tự động nên có thể sai. Hướng biển được suy ra từ `aligned_direction + 180°` (hằng `MLY_HEADING_OFFSET` trong `js/sources.js`). Nên kiểm tra với một biển thật: nếu app đọc biển của chiều ngược lại thì đổi hằng này thành 0.
- Phần thiếu thì tự bổ sung bằng **+ Thêm biển ở vị trí này**. Mỗi người **Xuất JSON**, gửi nhau rồi **Nhập JSON** để gộp.
- Có thể sửa thẳng trên OpenStreetMap (đường một chiều, `maxspeed`, `motorcycle:conditional`). Người khác cũng được hưởng, và app tải lại là thấy.

## Cấu trúc

```
index.html, style.css     giao diện
js/engine.js              hướng đi, tốc độ, cảnh báo biển báo
js/roads.js               khớp đường, ngược chiều, đường cấm, tốc độ theo đường
js/sources.js             tải Overpass/Mapillary, đổi sang mã biển QCVN 41:2024
js/app.js                 GPS, mô phỏng, giọng nói, bản đồ, lưu trữ
sw.js                     cho phép mở app khi mất mạng
test/                     test logic: npm test  (Node 20+)
```

Các ngưỡng (khoảng cách cảnh báo, độ lệch hướng, độ lệch ngang…) nằm trong `DEFAULTS` của `js/engine.js` và đầu các hàm trong `js/roads.js`.

## Giới hạn

- Trình duyệt không cho chạy GPS nền: phải để màn hình sáng (gắn điện thoại lên ghi-đông). Muốn chạy nền thì quay lại app native (bản Expo trước đó).
- Khớp đường dựa trên khoảng cách và hướng. Ở nút giao phức tạp, cầu vượt, đường gom sát nhau vẫn có thể nhầm. Khi có hai đường sát nhau (dưới 8 m) mà một đường đi được hợp lệ thì app không báo ngược chiều, để tránh báo nhầm.
- Chưa có cảnh báo cấm rẽ theo quan hệ `restriction` của OSM.
- App chỉ hỗ trợ, người lái vẫn phải quan sát biển thật.
