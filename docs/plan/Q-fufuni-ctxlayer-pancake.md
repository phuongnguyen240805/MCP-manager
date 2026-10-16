# Fufuni → ctxlayer → Pancake MCP: kế hoạch nghiệm thu local

Ngày: 2026-10-16. Trạng thái: kế hoạch, chưa triển khai các module đề xuất.
Tiếp nối [kế hoạch KEDI](P-kedi-mcp-hub.md). Chỉ local, chưa deploy Cloudflare thật.

## 1. Mục tiêu và phạm vi

Xây MCP client trong backend Fufuni để nhân viên Halifruit liên kết tài khoản
ctxlayer và xem tối đa 5 đơn Pancake qua Gateway. Phải chứng minh lời gọi thực
sự đi qua ctxlayer, bị chặn khi Gateway OFF/thu hồi quyền, không có fallback
sang API Pancake trực tiếp.

MVP chỉ có `manage_orders` / `list`, kết quả compact và trường hiển thị tối thiểu.
Không tạo/sửa/xóa đơn, không thay checkout, cron đồng bộ hoặc ledger POS hiện có.
Không cần LLM, R2 hay một MCP server mới trong Fufuni cho luồng thử này.
Phê duyệt thao tác ghi là phase riêng sau khi read-only đạt.

Đầu ra nghiệm thu:

- Nhân viên bấm Kết nối ctxlayer, đăng nhập/cấp quyền và trở lại trang thử.
- Backend giữ token riêng theo store + danh tính nhân viên, trình duyệt không nhận token MCP.
- Bấm Xem 5 đơn → Fufuni gọi MCP tool qua Gateway → DTO đơn đã lọc.
- Nhân viên khác không sử dụng được kết nối hoặc kết quả của người trước.
- Gateway OFF/quyền bị thu hồi làm lần đọc tiếp theo thất bại, không gọi Pancake trực tiếp.
- Disconnect, expiry/refresh và reconnect có hành vi kiểm thử được.

## 2. Hiện trạng đã kiểm tra

| Thành phần | Source thực tế | Nhận định |
|---|---|---|
| Halifruit FE/BFF | `D:/workspace/halifruit-fe-v1/src/lib/fufuni/server-client.ts` | Next.js gọi Fufuni bằng server fetch/service binding; hỗ trợ public/admin key, chưa có MCP client |
| Backend Fufuni | `D:/monorepo-project-workspace/fufuni/apps/merchant/src/index.ts` | OpenAPIHono, Worker; đây là nơi đặt MCP client |
| Auth Fufuni | `src/middleware/auth.ts`, `src/types.ts` | Có Auth0 JWT/API key; AuthContext có `sub`, nhưng không được giả định mọi đường auth đã điền subject |
| Database Fufuni | `src/db.ts`, `src/do.ts` | `getDb()` đi qua MerchantDO SQLite; không tự thêm D1 cho tích hợp |
| Pancake hiện có | `src/routes/pancake.ts`, `lib/pancake-sync.ts`, `lib/commerce-pos.ts` | Đồng bộ và tạo đơn bằng API trực tiếp đã tồn tại; giữ riêng với chức năng thử MCP |
| ctxlayer | `apps/worker/src/oauth/provider-config.ts` | OAuth endpoints authorize/token/register, scope `mcp`; không có bằng chứng hỗ trợ client_credentials cho MVP |
| Gateway proxy | `apps/worker/src/mcp/`, `src/policy/` | Có adapter HTTP, live authorization và operation approval |
| Catalog Pancake | Người dùng đã refresh thành công 24 tool | Chứng minh MCP discovery, chưa chứng minh API key đọc được đơn của shop |

Fufuni đang có nhiều thay đổi chưa commit. Khi triển khai phải ghi baseline,
chỉ sửa file liên quan, không reset/stash/stage toàn bộ hoặc commit hộ thay đổi khác.
Repo `fufuni/apps/mcp` có sẵn nhưng không phải nơi đặt client nghiệp vụ này.

## 3. Kiến trúc và workflow

```text
Nhân viên đã đăng nhập Halifruit
  → Next.js BFF: phiên nhân viên + quyền vận hành
  → Fufuni /v1/integrations/ctxlayer/*: xác thực actor/store
  → OAuth token của chính actor trong MerchantDO, mã hóa
  → MCP Client + Streamable HTTP
  → https://localhost:8787/mcp
  → live visibility / ACL / action / project checks
  → up-pancake-pos__manage_orders, action=list
  → Pancake MCP http://127.0.0.1:3000/mcp
  → Pancake POS API (hoặc fixture ở bộ offline)
```

Tên tool trên Gateway phải xác minh bằng `tools/list`; tên trên là kỳ vọng
theo slug hiện dùng. Không lấy tool name/URL/args tùy ý từ trình duyệt.
Danh tính Halifruit và ctxlayer có thể khác subject; liên kết chỉ được thiết lập
sau OAuth callback thành công, không ghép bằng email do client gửi.

### Kết nối OAuth

1. BFF xác thực nhân viên; Fufuni kiểm tra quyền admin/staff được cấp cho chức năng này.
2. Fufuni khám phá protected-resource và authorization-server metadata từ issuer
   đã cấu hình. Chỉ chấp nhận endpoints thuộc allowlist cấu hình tin cậy.
3. Đăng ký OAuth client bằng DCR khi chưa có; lưu registration theo issuer/store,
   không tạo client mới mỗi lần click. Khóa redirect URI cố định.
4. Sinh state, PKCE S256, nonce giao dịch nội bộ; lưu verifier mã hóa, store/actor,
   browser-binding hash, expiry 10 phút. Không dùng một biến OAuth toàn cục.
5. BFF đặt cookie giao dịch HttpOnly, SameSite=Lax; browser redirect sang ctxlayer.
6. ctxlayer đăng nhập/consent → callback BFF. BFF chuyển code/state/binding qua
   server request được xác thực đến Fufuni. Callback là GET chỉ dùng kết thúc OAuth.
7. Fufuni kiểm tra state một lần, expiry, store/actor/browser binding, issuer và
   redirect URI trước exchange. Gửi resource/scope theo metadata và SDK hỗ trợ.
8. Lưu token mã hóa; xóa state/cookie trên mọi đường hoàn thành, kể cả deny/error.
   Redirect về một đường dẫn nội bộ cố định, không nhận return URL tùy ý.

MCP authorization dùng OAuth + PKCE theo [đặc tả chính thức](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
Dùng API của [TypeScript SDK v1](https://ts.sdk.modelcontextprotocol.io/client)
phù hợp các server đang ghim v1; kiểm tra phiên bản cụ thể trước khi thêm dependency.
Không trộn ví dụ SDK v2 vào code v1 và không tự viết JSON-RPC bằng fetch ad hoc.

### Đọc đơn và disconnect

1. Fufuni kiểm tra feature flag, actor/store và connection active.
2. Lấy token; refresh khi cần với cơ chế một refresh đang chạy cho mỗi connection.
   Commit token mới bằng version CAS, không ghi đè refresh token vừa được rotate.
3. Khởi tạo MCP Client, initialize, lấy catalog có giới hạn/phân trang, xác minh tool/schema.
4. Gọi tool đã allowlist với `action=list`, `page_size<=5`, `verbosity=compact`.
   Kiểm tra tên trường thực tế trong catalog Pancake trước khi chốt payload.
5. Parse content/structuredContent qua schema adapter; MCP `isError` phải coi là lỗi.
6. Chỉ trả ID/mã đơn, thời điểm, trạng thái, tổng tiền; không trả nguyên object
   khách hàng, điện thoại, địa chỉ, editor_id/creator_id hoặc upstream error body.
7. Đóng client/transport trong finally; MVP không pool chung client giữa nhân viên.
8. Disconnect tăng connection version, vô hiệu token local, xóa giao dịch chờ;
   thử revoke tại issuer nếu được hỗ trợ. Trạng thái remote revoke phải báo đúng.
   Response đang chạy chỉ được trả nếu connection version vẫn active khi hoàn tất.

Không cache dữ liệu đơn trong MVP; tất cả response chức năng này dùng no-store.
401 sau refresh lỗi → reconnect; 403 → báo thiếu quyền; timeout/429 → mã lỗi ổn định.
Không retry vô hạn; tối đa một refresh/retry auth cho thao tác đọc, tôn trọng deadline.
Không đổi mọi lỗi thành “token sai”. Không replay một thao tác ghi trong tương lai.

## 4. Ranh giới xác thực bắt buộc

- `FUFUNI_ADMIN_KEY` là quyền backend, không tự chứng minh người dùng nào đang gọi.
- Phase 0 phải kiểm tra Halifruit đang dùng Auth0 JWT hay phiên nội bộ. Phương án
  mặc định: forward JWT nhân viên đã verify issuer/audience/permission/store và giữ
  subject ổn định. Có thể gọi Fufuni trực tiếp để probe nếu JWT hiện có phù hợp.
- Nếu Halifruit không có JWT đó: thêm assertion BFF được ký, TTL ngắn, aud riêng,
  subject lấy từ phiên đã verify; Fufuni xác minh chữ ký/issuer/aud/store và chống replay
  ở request nhạy cảm. Đây là phần triển khai cần thiết, không thay bằng `X-User-Id`
  hoặc dùng chung admin key kèm email do client gửi.
- Binding browser và kết quả connect chỉ thuộc actor đã bắt đầu transaction.
- Feature thử chỉ mở cho nhân viên có quyền. Public/customer key không được gọi.
- CSRF/Origin protection cho BFF mutation dùng cookie; endpoint bearer-only phía
  Fufuni vẫn kiểm tra auth và không nhận credential từ query string.
- Không dùng token Pancake MCP, Pancake API key, Fufuni admin key thay OAuth token ctxlayer.
- Không thêm bypass auth, token tự ký giả làm access token ctxlayer, hay client_credentials
  khi chưa có hỗ trợ và bài kiểm chứng từ Gateway.

## 5. Endpoint đề xuất

Prefix Fufuni: `/v1/integrations/ctxlayer`. Mount tách khỏi `/integrations/pancake` hiện có.

| Method/path | Hành vi | Quyền |
|---|---|---|
| GET `/status` | disconnected/connecting/connected/reauth_required; không có token | Actor nhân viên hiện hành |
| POST `/connect` | Tạo giao dịch, trả authorization URL + opaque transaction ID | Actor + browser binding |
| POST `/complete` | BFF hoàn tất code/state exchange server-to-server | Actor + binding + one-time state |
| DELETE `/connection` | Disconnect connection của actor hiện hành | Actor + mutation protection |
| GET `/pancake/orders?limit=5` | Gọi đúng tool/action read-only, trả DTO allowlist | Actor + connection của store |

BFF nhận browser callback tại `/api/integrations/ctxlayer/callback`; các BFF handler
khác mirror status/connect/disconnect/orders và dùng cùng schema. Callback public về
network nhưng phải kiểm tra phiên/binding/state; không mang Fufuni admin key trên URL.
Không tạo endpoint “call bất kỳ tool nào” trong MVP.

Error codes: `mcp_disabled`, `identity_required`, `mcp_not_connected`,
`mcp_reauth_required`, `mcp_forbidden`, `mcp_tool_unavailable`, `mcp_schema_changed`,
`mcp_timeout`, `mcp_rate_limited`, `mcp_upstream_error`, `mcp_invalid_response`.
Log correlation ID, actor/store, tool, latency và stable code; không log token,
authorization code, query credential, raw đơn hàng hoặc exchange response body.

## 6. Cấu trúc file đề xuất

Tất cả file ghi `[mới]` là đề xuất, chưa được tạo bởi bản kế hoạch này.

```text
fufuni/apps/merchant/
├── src/
│   ├── integrations/ctxlayer/             [mới]
│   │   ├── contracts.ts                  # Request/response Zod + DTO
│   │   ├── config.ts                     # Typed Env, endpoint allowlist
│   │   ├── identity.ts                   # Verified actor/store
│   │   ├── oauth.ts                      # DCR, PKCE, complete, refresh, revoke
│   │   ├── secrets.ts                    # AES-GCM + key version
│   │   ├── store.ts                      # Persistence abstraction / DO RPC
│   │   ├── sql.ts                        # Schema và SQL trong DO
│   │   ├── client.ts                     # SDK lifecycle, auth, timeout
│   │   ├── pancake-orders.ts             # Tool allowlist + DTO adapter
│   │   └── errors.ts                     # Stable errors/redaction
│   ├── routes/ctxlayer.ts                [mới] thin OpenAPI handlers
│   ├── index.ts                          [sửa] mount router
│   ├── types.ts                          [sửa] Env/DO RPC/auth typing
│   └── do.ts                             [sửa] schema lifecycle + atomic RPC
├── tests/ctxlayer/                       [mới]
│   ├── oauth.test.ts
│   ├── authorization.test.ts
│   ├── orders.test.ts
│   ├── store.runtime.test.ts
│   └── transport.runtime.test.ts
├── scripts/smoke-ctxlayer.mjs            [mới]
└── .env.example                         [sửa] placeholder, không có secrets

halifruit-fe-v1/src/
├── lib/fufuni/ctxlayer.server.ts         [mới] typed server fetch
├── app/api/integrations/ctxlayer/        [mới] BFF routes + callback
└── app/<staff-area>/integrations/ctxlayer/ [mới] chọn theo guard staff sẵn có
    └── page.tsx                         # Connect/status/read/disconnect
```

Chọn staff-area theo router/auth thực tế ở phase 0, không dựng trang trong
storefront public. Dùng schema contract được đồng bộ từ Fufuni/OpenAPI, không
cho hai bên tự diễn giải khác kiểu response. SQL đặt trong module sql/DO,
không inline trong route. Refresh/state consume là DO RPC atomic, không giả định
hai lời `query()` + `run()` riêng tạo thành transaction.

Storage dự kiến trong MerchantDO của store hiện hành:

- `ctxlayer_clients`: issuer/client registration/redirect fingerprint, unique issuer+config.
- `ctxlayer_connections`: unique actor_issuer+actor_sub; encrypted token bundle,
  key version, expiry, status, generation, refresh claim/version, timestamps.
- `ctxlayer_oauth_transactions`: hashed state, actor/store/browser-binding,
  encrypted verifier, expiry, consumed flag; consume một lần bằng atomic RPC.
- `ctxlayer_audit`: metadata connect/disconnect/read result code, không lưu đơn/token.

Store isolation dựa trên MerchantDO routing hiện có, vẫn bind store vào OAuth
transaction và identity. Mã hóa AES-GCM với random IV và AAD store+actor+issuer;
key tách khỏi database. Dọn giao dịch hết hạn qua cơ chế cleanup sẵn có.

## 7. Cấu hình local

| Thành phần | Địa chỉ dự kiến |
|---|---|
| ctxlayer | `https://localhost:8787/mcp` |
| Fufuni merchant | `http://localhost:8788` |
| Halifruit | `http://localhost:3002` |
| Pancake MCP thật | `http://127.0.0.1:3000/mcp` |
| Fixture POS | `http://127.0.0.1:3101/mcp` |

Env mới trong Fufuni (tên đề xuất, chưa có hiệu lực):

```dotenv
CTXLAYER_MCP_ENABLED=false
CTXLAYER_MCP_URL=https://localhost:8787/mcp
CTXLAYER_OAUTH_REDIRECT_URI=http://localhost:3002/api/integrations/ctxlayer/callback
CTXLAYER_PANCAKE_UPSTREAM_SLUG=up-pancake-pos
CTXLAYER_MCP_TIMEOUT_MS=15000
CTXLAYER_MCP_MAX_RESPONSE_BYTES=262144
CTXLAYER_TOKEN_KEY_VERSION=1
CTXLAYER_TOKEN_KEY=<base64 random 32-byte key, private local env>
```

BFF dùng `FUFUNI_BACKEND_URL=http://localhost:8788` và identity config ở phase 0.
Không fallback URL production khi đang test MCP local. Không đặt secret dưới
`NEXT_PUBLIC_*`. Feature flag chỉ bật sau policy và identity gate.

Fufuni cần lệnh dev local-only dùng `wrangler.halifruit.jsonc --local --port 8788`,
resource names/persistence riêng và env local; kiểm tra config trước khi chạy.
Thử HTTPS trust từ workerd của Fufuni tới ctxlayer ngay phase 0. Không dùng
`NODE_TLS_REJECT_UNAUTHORIZED=0`, không giả định Node CA tự áp dụng cho workerd.
Nếu chứng chỉ local chưa được tin cậy, sửa trust hoặc dùng transport local do
runtime hỗ trợ và đồng bộ issuer/base URL/DCR; không tiếp tục OAuth với issuer lệch.
Không mở tunnel public hay deploy để lách vấn đề trust trong phạm vi local.

## 8. Phases, checklist và gate

### Phase 0 — baseline, identity và network

- [ ] Ghi revision/status ba repo; giữ nguyên thay đổi đang có trong Fufuni/Halifruit.
- [ ] Đọc AGENTS trong đường dẫn làm việc; kiểm tra scripts/package manager từng repo.
- [ ] Xác minh phiên staff Halifruit → verified actor/store Fufuni, chọn JWT hoặc BFF assertion.
- [ ] Lệnh local Fufuni đúng config/store, không remote binding/cron ngoài ý muốn.
- [ ] Probe issuer metadata và TLS từ chính Fufuni workerd; thống nhất callback.
- [ ] Baseline các suite auth/stores/commerce/pancake của Fufuni.

Gate: có danh tính ổn định đã verify, mạng local hoạt động và không đụng production.
Không bỏ gate này bằng một token dùng chung gắn email tự khai báo.

### Phase 1 — contract, persistence và OAuth backend

- [ ] Typed Env, feature flag default OFF; dependency MCP client ghim version v1.
- [ ] Schema/DO RPC: encrypted token, atomic state consume, version/refresh locking.
- [ ] DCR/PKCE/callback, cookie binding, cleanup mọi nhánh, reconnect/disconnect.
- [ ] Endpoint auth/store isolation, public-key denied, Origin/CSRF ở BFF.
- [ ] Test restart vẫn đọc được connection; sai key/AAD không decrypt được.

Gate: kết nối OAuth thật local thành công; token không rời server; state replay/cross-user fail.

### Phase 2 — MCP adapter read-only và nghiệm thu backend

- [ ] `initialize` + paginated `tools/list`, xác minh tool/schema theo upstream đã cấu hình.
- [ ] Chỉ gọi manage_orders/list; validate input giới hạn 5, response compact/size cap.
- [ ] DTO parser và lỗi ổn định cho MCP isError, JSON sai, timeout/401/403/429.
- [ ] Token refresh đồng thời một lần, rotated token không bị ghi đè; client luôn close.
- [ ] Backend có thể chạy smoke không cần UI/LLM; tuyệt đối không direct-API fallback.

Gate: Fufuni gọi fixture thông qua ctxlayer; OFF/revoke làm số lần đọc fixture không tăng.

### Phase 3 — màn hình Halifruit dành cho staff

- [ ] Trang guarded: status, Connect, Read 5 orders, Disconnect; loading và lỗi dễ hiểu.
- [ ] BFF route server-only; no-store, schema chung, không generic tool execute.
- [ ] Callback khi người dùng cancel, hết phiên, mở nhiều tab hoặc logout/login người khác.
- [ ] Không ảnh hưởng checkout/customer page hoặc gọi MCP tự động khi render storefront.

Gate: nhân viên thao tác trọn luồng bằng UI; staff khác không thấy kết nối/kết quả của họ.

### Phase 4 — acceptance và báo cáo

- [ ] Offline fixture suite và local browser OAuth smoke đạt trên cùng revision.
- [ ] API Pancake thật: một lần đọc tối đa 5 đơn khi credential đã cấu hình; không ghi.
- [ ] Verify/build theo từng repo; ctxlayer `bun run verify` nếu có sửa code ctxlayer.
- [ ] Regression Fufuni auth/stores/pancake-sync/commerce; test UI/BFF Halifruit liên quan.
- [ ] Báo cáo phân biệt fixture pass, OAuth pass, provider pass/blocked; không log PII.
- [ ] PR tách Fufuni backend và Halifruit UI; ghi dependency, migration và rollback.

Gate: đủ bằng chứng workflow + deny/revoke; không coi 24 cached tools là provider acceptance.

### Phase 5 — ghi có phê duyệt (ngoài MVP)

Chỉ triển khai khi có yêu cầu riêng: Fufuni đề xuất `request_operation`, admin
khác duyệt trong ctxlayer, requester execute/read theo operation ID. `unknown`
phải đối soát, không resend. Phải thiết kế quan hệ với `commerce-pos.ts` trước
khi cho tạo đơn để tránh hai pipeline cùng ghi một giao dịch.

## 9. Ma trận kiểm thử bắt buộc

| Tình huống | Bằng chứng mong đợi |
|---|---|
| Chưa đăng nhập/public key/shared admin key thiếu actor | 401/403 trước MCP call |
| State sai, hết hạn, replay, callback khác browser/store/user | Không exchange/lưu token |
| OAuth deny hoặc metadata/issuer lạ | Cleanup state, không open redirect/SSRF |
| Hai người connect cùng lúc | Mỗi token lưu đúng actor/store |
| Token hết hạn, hai request cùng refresh | Một refresh hợp lệ; không ghi đè token mới |
| Refresh grant bị revoke | Reauth required, không fallback secret khác |
| MCP catalog tool đổi/mất hoặc schema không hợp lệ | Stable error, không chọn tool gần giống |
| MCP trả isError/JSON sai/response quá lớn | Không trả success hoặc raw upstream body |
| Read 5 đơn qua fixture | Đúng DTO; marker/counter chứng minh đi qua ctxlayer |
| OFF/ACL/project revoke trong session đã mở | Không tăng upstream read count |
| Xin action create/delete qua endpoint read-only | Bị từ chối trước MCP call |
| Disconnect rồi request mới/in-flight hoàn tất | Không trả dữ liệu bằng connection đã bị thu hồi |
| Hai store dùng cùng subject | Token/đơn của store A không dùng cho B |
| Restart backend | Connection bền vững, OAuth state vẫn expiry/consume đúng |
| Provider thật read | Tối đa 5 đơn, DTO tối thiểu, không mutation |
| Pipeline commerce cũ | Các suite regression không đổi hành vi |

Báo cáo cuối ghi revision, config local đã che secrets, command, pass/fail,
upstream fixture counters và stable error. Không lưu ảnh token hoặc nội dung đơn
khách hàng vào Git. CLI dùng RTK cho search/read/check; không lọc payload MCP bằng RTK.

## 10. Thứ tự PR và rollback

1. Fufuni identity + contracts + persistence + OAuth (feature OFF).
2. Fufuni MCP adapter + backend fixture acceptance.
3. Halifruit staff UI/BFF + local OAuth/read acceptance.
4. Evidence/cấu hình read-only provider thật, nếu môi trường sẵn sàng.

Rollback bằng feature flag OFF và disconnect/grant revocation khi cần; giữ schema
thêm mới tương thích, không drop bảng đang chứa token bằng migration rollback tự động.
Không thay nguồn dữ liệu commerce bằng MCP ở milestone này.

## 11. Trạng thái của bản kế hoạch

Đã kiểm tra source và thiết kế workflow/folder/contracts/gates. Chưa thêm SDK,
endpoint, bảng OAuth hoặc màn hình Halifruit; chưa chạy provider acceptance mới.
Kế hoạch lưu tại ctxlayer theo yêu cầu, phần triển khai chính nằm trong Fufuni.
