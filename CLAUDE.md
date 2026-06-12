# Repository Guide

Tài liệu này mô tả cấu trúc và các nguyên tắc kỹ thuật cần biết khi sửa
Payment Gateway.

## Runtime

- Framework: NestJS 10.
- Package manager: pnpm 9.15.9.
- Runtime đã kiểm tra: Node.js 20.
- Browser automation: Playwright Chromium.
- Queue và persistence: Redis + BullMQ.
- Cấu hình nghiệp vụ: `config/config.yml`.
- Cấu hình môi trường: `.env`.

## Commands

```bash
pnpm install
pnpm playwright install chromium
docker compose -f docker-compose.dev.yml up -d
pnpm start:dev
```

Kiểm tra trước khi hoàn tất thay đổi:

```bash
pnpm test -- --runInBand
pnpm build
pnpm exec eslint <các-file-typescript-đã-sửa>
```

Các lệnh khác:

```bash
pnpm start
pnpm start:debug
pnpm start:prod
pnpm test:watch
pnpm test:cov
pnpm test:e2e
pnpm format
```

## Local environment

Khi app chạy bằng pnpm:

```dotenv
PORT=3001
REDIS_HOST=localhost
REDIS_PORT=6380
CAPTCHA_API_BASE_URL=http://localhost:1234
GATEWAY_AUTO_CRON=false
GATEWAY_PRELOGIN=true
PAYMENT_CHECK_TIMEOUT_SEC=30
PAYMENT_CHECK_INTERVAL_SEC=15
PAYMENT_CHECK_MAX_ATTEMPTS=2
```

`docker-compose.dev.yml` chỉ chạy Redis ở port 6380 và captcha resolver ở port 1234. `docker-compose.yml` chạy cả app và dùng hostname nội bộ `redis`.

## Architecture

### Gateways

- `src/gateways/gates.services.ts`: base class `Gate`, cron, warm-up và scan.
- `src/gateways/gates-manager.services.ts`: validate YAML, tạo/destroy gateway,
  trạng thái và chống scan trùng trên cùng gateway.
- `src/gateways/gateway-factory/gate.factory.ts`: factory theo `GateType`.
- `src/gateways/gateway-factory/*`: implementation từng ngân hàng/blockchain.

`Gate.getHistory()` phải trả `Payment[]` với:

```ts
type Payment = {
  transaction_id: string;
  content: string;
  amount: number;
  date: Date;
  gate: GateType;
  account_receiver: string;
};
```

`scanGateOnce()` chuẩn bị proxy rồi gọi `getHistory()`. Manager giữ một Promise
đang chạy cho mỗi gateway để tránh nhiều request cùng lúc.

### Checkout

- `src/payments/checkout.service.ts`: tạo VietQR request và đối chiếu.
- `src/payments/checkout.controller.ts`: REST API `/api/payment-requests`.
- `public/index.html`, `public/app.js`, `public/styles.css`: trang thanh toán.

Checkout request được lưu trong memory 15 phút. Verify chạy theo timeout,
interval và max attempts từ `.env`. Match yêu cầu đủ account, amount, content và
thời gian.

### Payment events

Luồng sự kiện:

```text
gateway/checkout
  -> payment.history-updated
  -> PaymentService.addPayments()
  -> payment.created
  -> webhook + Telegram/Discord
```

`PaymentService` loại transaction trùng theo `transaction_id` và giữ tối đa 500
payment. `DISABLE_SYNC_REDIS=true` hiện chỉ bỏ bước nạp payment cũ khi bootstrap;
`addPayments()` vẫn gọi `saveRedis()` cho payment mới.

### Admin

- `src/admin/admin-auth.service.ts`: tạo secret path/password, scrypt hash và
  signed session cookie.
- `src/admin/admin.service.ts`: overview, bank CRUD/toggle và transaction list.
- `src/admin/admin.controller.ts`: page route và API admin.
- `admin-ui/admin.html`, `public/admin.js`, `public/admin.css`: frontend.

Admin hỗ trợ ACB, MB Bank, TPBank và VCB. Thay đổi được ghi trực tiếp vào YAML
bằng temporary file + atomic rename, sau đó gateway được tạo lại.

Không trả mật khẩu hoặc login ID nguyên bản về frontend. VCB trả `userAgent`
vì đây không phải credential.

### Queue, bot và webhook

- `src/webhook/webhook.service.ts`: queue `webhook`, retry ba lần.
- `src/bots/bot.service.ts`: queue `bot-TELEGRAM`/`bot-DISCORD`.
- `src/bots/bot-factory/*`: transport cụ thể.
- `src/shards/middlewares/queues.middleware.ts`: Bull Board tại
  `/admin/queues`.

Bull Board hiện không dùng AdminSessionGuard. Không giả định route này đã được
bảo vệ.

## Bank-specific behavior

### MB Bank

- Login qua full Chromium chạy `--headless=new`.
- Captcha lấy từ response `/getCaptchaImage`.
- Sau login, lịch sử gọi API bằng session ID và device ID.
- UI hoặc endpoint ngân hàng đổi có thể làm selector/response matcher hỏng.

### ACB

- Dùng persistent profile `.browser-data/acb-<gateway-name>`.
- `ACB_SAFEKEY_CONSOLE=true` nhập OTP sáu số từ terminal.
- `ACB_MANUAL_LOGIN=true` mở browser để xác thực thủ công.
- Sau login, cookie được chuyển sang `request-promise`.
- Nếu response lịch sử không có `#table1`, coi session đã hết hạn, clear session,
  login lại và retry đúng một lần.
- Không tạo retry vô hạn trong `getHistory()`.

### TPBank

- Login và lấy lịch sử qua API.
- Yêu cầu `device_id`.
- Access token được clear trước thời điểm hết hạn.
- Nếu history trả HTTP 401, clear token, login lại và retry đúng một lần.
- Ưu tiên timestamp từ `transactionDate`, `valueDate`, rồi `bookingDate`.
- Nếu TPBank chỉ trả ngày hiện tại mà không có giờ, dùng thời điểm quét để
  checkout không loại nhầm giao dịch vừa nhận.

### Vietcombank

- Request/response dùng encryption trong `vcb/encrypt.ts`.
- Yêu cầu `device_id`.
- `user_agent` phải dùng thống nhất cho captcha, login và history.
- `getBrowserMetadata()` derive `DT`, `PM`, `OV` từ User-Agent.
- Mã `20231` là lỗi trình duyệt chưa xác thực hoặc fingerprint không khớp.
- Không thay public/private key hoặc metadata nếu chưa đối chiếu frontend VCB.

### USDT

- TRON dùng TronGrid.
- BEP20 dùng Etherscan V2; `password` là API key.
- Cả hai quy đổi USDT sang VND qua Binance P2P.
- USDT không nằm trong `getPaymentTargets()`, vì vậy không được scan bởi checkout
  VietQR. Muốn tự theo dõi cần bật auto cron hoặc bổ sung entry point scan riêng.

## Configuration invariants

Schema gateway nằm trong `GatesManagerService.validateBanksConfig()`.

- Tên gateway tạo hoặc sửa qua admin: 3-50 ký tự, chữ/số/`_`/`-`.
- YAML được nạp trực tiếp hiện chỉ yêu cầu `name` là chuỗi; không dựa vào admin
  regex để bảo vệ file cấu hình viết tay.
- `repeat_interval_in_sec`: 1-120.
- `get_transaction_day_limit`: 1-100, mặc định 14.
- `get_transaction_count_limit`: 1-100, mặc định 100.
- Bank gateway cần `login_id` và `password`.
- TPBank/VCB cần `device_id`.
- `user_agent` tối đa 500 ký tự.

Nếu thêm field mới:

1. Cập nhật `GateConfig`.
2. Cập nhật Joi schema.
3. Cập nhật admin create/update nếu field cần sửa từ UI.
4. Cập nhật `config/config.example.yml`.
5. Cập nhật README.
6. Thêm test giữ giá trị cũ khi edit với input trống nếu field có tính nhạy cảm.

## Adding a gateway

1. Thêm loại vào `GateType`.
2. Tạo class kế thừa `Gate`.
3. Implement `getHistory(): Promise<Payment[]>`.
4. Register trong `GateFactory`.
5. Cập nhật Joi validation.
6. Thêm bank metadata nếu gateway cần xuất hiện trong VietQR targets.
7. Nếu cần quản lý bằng admin, thêm vào `AdminService.supportedBankTypes` và UI.
8. Viết unit test cho parsing, session expiry và retry.

## Testing guidance

- Parsing HTML/API response phải có fixture cho response hợp lệ và response
  thiếu dữ liệu.
- Session expiry phải test rằng login lại và retry có giới hạn.
- Checkout phải test amount tối thiểu, match đủ điều kiện và max attempts.
- Admin edit phải giữ credential cũ khi form gửi chuỗi rỗng.
- Với frontend admin, kiểm tra modal add/edit và field điều kiện theo loại bank.

## Operational notes

- `config/config.yml`, `.browser-data` và `.admin-data` không được commit.
- Không log mật khẩu, token, cookie, SafeKey hoặc full config.
- Payment request chỉ ở memory; restart sẽ mất request đang chờ.
- Checkout ghi log `PaymentCheck` không chứa credential hoặc nội dung giao dịch.
- Redis vẫn bắt buộc cho BullMQ. `DISABLE_SYNC_REDIS=true` chưa tắt thao tác ghi
  payment mới vào Redis.
- Public payment APIs, stop-gate và Bull Board hiện chưa có auth riêng.
- Proxy config được load khi application bootstrap; sửa proxy YAML cần restart.
- Admin add/edit gateway có thể apply ngay mà không restart.
- Tránh refactor không liên quan trong các gateway vì luồng ngân hàng dễ thay đổi
  và khó kiểm thử end-to-end.
