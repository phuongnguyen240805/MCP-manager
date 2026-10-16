# Đồng bộ catalog: Fufuni → ctxlayer → Pancake MCP → database → Halifruit

Ngày cập nhật: 2026-10-16. Trạng thái: đã triển khai lõi đồng bộ và nghiệm thu bằng fixture local;
chưa nghiệm thu tài khoản tích hợp/IdP và shop Pancake thật.
Tiếp nối [KEDI Hub](P-kedi-mcp-hub.md). Phạm vi local, chưa deploy Cloudflare thật.

## 1. Mục tiêu đã chốt

Người dùng chọn **sản phẩm, biến thể, giá và tồn kho trước**. Fufuni chủ động
chạy job lấy dữ liệu thông qua ctxlayer, chuẩn hóa và lưu database. Halifruit
đọc API Fufuni; mở trang không chờ MCP hoặc Pancake hoạt động.

```text
Cron hoặc admin bấm Đồng bộ trong Fufuni
  → job theo store/shop/kho, lấy lease
  → MCP client trong Fufuni
  → ctxlayer: kiểm tra quyền integration principal
  → pancake-pos-mcp
  → Pancake POS API
  ← dữ liệu phân trang trả qua MCP/Gateway
  → xác minh đủ snapshot, chuẩn hóa theo model Fufuni
  → commit atomically vào MerchantDO SQLite
  → cập nhật sync status + invalidation cache

Halifruit → API catalog/inventory Fufuni → dữ liệu đã lưu
```

MVP không có read-through MCP trong request storefront, không kết nối OAuth cho
từng khách mua hàng, không lấy đơn hàng/khách hàng và không ghi ngược Pancake.
Job định kỳ dùng connection tích hợp của store, tách khỏi phiên người xem Halifruit.
Đây là thiết kế thay thế bản trước vốn tập trung đọc 5 đơn trực tiếp.

Mục tiêu nghiệm thu:

- Đồng bộ thử một sản phẩm qua Gateway, đọc lại từ database/API Fufuni.
- Chạy lại không trùng sản phẩm/biến thể; giá VND và tồn đúng kho.
- Full snapshot hợp lệ cập nhật danh mục; lỗi giữa chừng giữ snapshot trước.
- Tắt Gateway/thu hồi quyền chặn job mới, nhưng Halifruit vẫn đọc dữ liệu đã commit
  theo chính sách độ mới của giá/tồn; không tự quay về API Pancake trực tiếp.
- Hai store/shop không dùng chung connection, mapping hoặc trạng thái job.
- Báo cáo có run ID, thời điểm thành công, số bản ghi/warnings và lỗi ổn định.

## 2. Hiện trạng và hướng tái sử dụng

| Thành phần thực tế | Vai trò |
|---|---|
| `fufuni/apps/merchant/src/lib/pancake-sync.ts` | Đã có runner sync, lease, normalize, apply snapshot, cache invalidation |
| `lib/pancake-source.ts` | Đọc REST trực tiếp và model/normalizer; cần tách transport khỏi normalization |
| `lib/pancake-store.ts`, `src/do.ts` | Mapping stable IDs, DO transaction, inventory/reservation và báo cáo |
| `src/routes/pancake.ts` | Admin status/sync đã có; tái sử dụng thay vì tạo luồng sync cạnh tranh |
| `src/index.ts` scheduled handler | Chạy theo store registry; tích hợp job với cùng orchestrator |
| `lib/stores.ts` | Resolve store/env và MerchantDO; thêm cấu hình MCP theo store |
| `lib/commerce-pos.ts` | Luồng ghi đơn Pancake riêng, ngoài phạm vi thay đổi |
| `halifruit-fe-v1/src/lib/fufuni/server-client.ts` | Đã đọc catalog/inventory qua API Fufuni; giữ đường dữ liệu này |
| `ctxlayer/src` trong các workspace worker/shared/web | Proxy, invocation policy, credential và approval hiện có |

Source backend: `D:/monorepo-project-workspace/fufuni/apps/merchant`.
FE/BFF: `D:/workspace/halifruit-fe-v1`. Gateway: repo ctxlayer hiện tại.
`fufuni/apps/mcp` không phải nơi đặt MCP client nghiệp vụ.

Giữ normalizer, stable ID và DO commit hiện có khi hợp đồng dữ liệu tương thích.
Thêm `CatalogSource` với hai implementation rõ ràng `direct` và `ctxlayer_mcp`.
Một store chỉ chọn **một source cho mỗi run**, cả manual và cron dùng chung.
Mode MCP fail phải báo lỗi, tuyệt đối không fallback direct hoặc chạy hai job
cùng ghi catalog. Chuyển source bằng cấu hình có audit, không bằng catch lỗi.

Không mở rộng âm thầm giới hạn snapshot hiện có (20 trang × 30 biến thể, 600).
Vượt giới hạn phải lỗi rõ; phase mở rộng dùng staging/versioned snapshot riêng.
Fufuni/Halifruit đang có thay đổi chưa commit: giữ baseline và chỉ commit phần
thuộc tích hợp, không reset/stash/stage toàn bộ thay đổi sẵn có.

## 3. Hợp đồng MCP là gate đầu tiên

24 cached tools chỉ chứng minh discovery. Phải xác minh tools/action/schema và
đủ trường để tái tạo snapshot của normalizer Fufuni.

| Nhu cầu | Công cụ/action ứng viên cần xác minh |
|---|---|
| Shop cố định của connection | Metadata shop đã cấu hình hoặc `get_shop_info` / `get` |
| Kho và khả năng dùng kho | `manage_warehouses` / `list`, `get` |
| Sản phẩm | `manage_products` / `list`, `get` |
| Biến thể, giá, tồn từng kho | `manage_products` / `list_variations` hoặc tool đọc snapshot chuyên biệt |

Source đã kiểm tra: `manage_products/list_variations` hiện yêu cầu product_id;
không giả định tồn tại endpoint tool “liệt kê mọi biến thể” tương đương REST
`products/variations`. Kiểm tra pagination và consistency của từng action thực tế.

Compact masks hiện bỏ images, một số cờ publish/hidden/locked, source SKU và
currency metadata cần cho normalizer. Không mặc định trường bị bỏ là false/0/null,
không dùng global stock thay stock kho, không chuyển hàng bị ẩn thành active.

Thứ tự chọn giải pháp:

1. Dùng tools đọc hiện có nếu response đủ trường và đủ chứng cứ pagination.
   `verbosity=full` chỉ là probe/adapter input có giới hạn; vẫn phải lọc audit
   fields có thể chứa credential identifiers trước khi log/lưu/trả ra.
2. Nếu thiếu: thêm **một tool đọc snapshot catalog** trong Pancake MCP, schema
   versioned, fields allowlist, page/count metadata và stock theo warehouse.
   Tool này chỉ đọc API, không thay normalizer Fufuni bằng prompt hay LLM.
3. Không triển khai commit catalog production-like cho tới khi fixture và schema
   kiểm chứng đủ shop/kho/variant IDs, SKU, ảnh, giá/currency, trạng thái và tồn.

Mọi text từ MCP là input không tin cậy. Parse JSON/schema; xử lý MCP `isError`;
không eval, không inline vào prompt, không gửi kết quả qua LLM để tiết kiệm token.
SDK client v1 tương thích server đang ghim v1; version cụ thể chốt sau runtime probe.

## 4. Danh tính job và OAuth tích hợp theo store

Cron không có phiên trình duyệt. Dùng integration principal chuyên dụng trên
ctxlayer, ví dụ `fufuni-catalog-sync`, active, không cần quyền admin Gateway,
thuộc Team/Product được giới hạn đúng connection đọc catalog của store.

OAuth của Gateway hiện có authorize/token/register, scope `mcp`; chưa có bằng
chứng client_credentials. MVP không thêm bypass hay dùng admin session cookie
của người thao tác làm credential cron.

Workflow provisioning:

1. Admin Fufuni có quyền store bấm Kết nối nguồn catalog; backend tạo transaction
   state+PKCE S256, bind store/admin/browser, expiry 10 phút, redirect URI cố định.
2. Người vận hành đăng nhập ctxlayer bằng integration principal và consent.
3. Callback BFF chuyển code/state/browser-binding server-to-server đến Fufuni.
4. Backend consume state atomic, xác minh issuer/resource/redirect và exchange.
5. Lưu encrypted OAuth token bundle theo store+issuer+integration connection.
   Không trả token cho Halifruit; shared Pancake token và API key không thay token này.
6. Cron refresh bằng token đã cấp, không cần admin giữ trình duyệt mở.
7. Grant bị revoke, principal bị khóa hoặc refresh thất bại → pause/reauth_required;
   admin kết nối lại. Không lấy token từ store khác hay tự đổi principal.

Gate: chứng minh connection thuộc integration principal đã định. Nếu không có
metadata đáng tin để kiểm tra subject từ token, thêm API identity tối thiểu trên
Gateway hoặc provisioning assertion có xác thực; không giải mã token opaque để
đoán subject và không tin email do browser gửi. Grant vẫn có expiry/revocation;
không gọi đây là machine-to-machine client_credentials.

Admin API tiếp tục dùng auth/permission store hiện có. Admin key dùng chung có
thể authorize backend operation nhưng không tự chứng minh audit actor con người:
UI cần verified staff subject; dùng Auth0 JWT hoặc BFF assertion đã verify,
không nhận `X-User-Id`/email tùy ý. Callback chống CSRF/state replay, cleanup
mọi nhánh; endpoint return URL và metadata không được trở thành open redirect/SSRF.

Gateway Invocation policy chỉ allow các tool/action đọc cần thiết theo contract
đã chốt; tất cả write action không có rule thì deny. Connection cố định shop:
scope account do Pancake MCP giữ; không giả lập shop argument không có trong tool.

## 5. Workflow job và commit

1. Resolve store → source mode → connection generation → shop/warehouse config.
2. Kiểm tra flags, active connection và limit; manual/cron cùng acquire lease
   của pipeline Pancake hiện có. Chỉ một run được quyền ghi cho store/shop/kho.
3. Tạo durable run record: run ID, source/config fingerprint, lease token, thời gian,
   trigger manual/cron, mode trial/full, state `running`.
4. MCP initialize/tools discovery có giới hạn; đọc theo trang với timeout/body cap.
   Mỗi trang validate schema, unique IDs, counts/cursor và warehouse consistency.
5. Thu thập snapshot theo giới hạn hiện có, không vừa fetch vừa ghi bảng live.
   Nếu phải kéo dài quá lease, heartbeat có fencing token và deadline; worker cũ
   không được commit sau khi lease đã mất. MVP không vô hạn resume job dài.
6. Normalizer tạo product/variant/VND-price/warehouse-stock, stable IDs theo
   shop+kind+source ID; giữ SKU fallback ổn định và link mapping.
7. Recheck connection generation/source config/lease và quyền trước commit.
   Thực hiện check cùng DO transaction ở ranh giới local commit; Gateway vẫn
   kiểm tra quyền mỗi call. Không hứa atomic revoke giữa hai dịch vụ độc lập.
8. DO transaction commit snapshot + mappings + run success + snapshot metadata.
   Trial không retire missing; full chỉ retire absent khi toàn bộ snapshot hợp lệ.
9. Preserve `reserved` và các field Fufuni sở hữu. Giá VND nguyên không âm;
   stock đúng warehouse, không âm; fractional stock phải theo quy tắc draft/cảnh báo.
10. Commit thành công mới invalidate cache catalog/inventory đang phục vụ Halifruit.
    Cache invalidation lỗi là `succeeded_with_warning`, không rollback catalog đã lưu.
11. Lỗi fetch/schema/count/auth/commit → run failed/blocked, giữ snapshot trước,
    lưu stable error và backoff. Không tự đổi zero inventory do network failure.

State: `queued` nếu có dispatcher → `running` → `succeeded` / `succeeded_with_warning`
/ `failed` / `blocked` / `abandoned`. Claim manual đồng bộ chạy được trước khi thêm
queue; không trả “queued” nếu chưa persist và chưa có executor đáng tin thực thi.
Lease timeout khi process chết được phân loại abandoned lúc lần kiểm tra tiếp theo.

MVP full snapshot có giới hạn, không dùng timestamp làm watermark incremental
khi chưa kiểm chứng updated_at/deletion semantics. Sau này incremental dùng cửa sổ
overlap, checkpoint sau commit và full reconciliation định kỳ; không advance
checkpoint khi trang lỗi. Retry bounded cho read transient/429, không retry
schema/config/permission error liên tục. Job không ghi API Pancake.

## 6. Dữ liệu lưu và API phục vụ

Tái sử dụng bảng commerce product/variant/price/inventory và `pancake_links`.
Giữ rule ownership: Pancake sở hữu dữ liệu catalog được mapping; Fufuni sở hữu
reservation/cart/payment. Không dùng upsert để xóa reservation hoặc ghi đè
metadata thủ công ngoài field map đã xác nhận.

Storage tích hợp trong MerchantDO của store, không thêm R2/D1:

- `ctxlayer_clients`: registration theo issuer+redirect config, secret mã hóa nếu có.
- `ctxlayer_connections`: integration principal reference, encrypted token bundle,
  expiry, key version, generation, refresh fencing/version, trạng thái.
- `ctxlayer_oauth_transactions`: hashed state, admin/browser/store binding,
  encrypted PKCE verifier, expiry, one-time consume.
- `pancake_sync_runs`: run/source/config/lease, counts/warnings/error, timestamps.
- `pancake_sync_state` hiện có: last_success_at, snapshot version, selected source;
  thay đổi schema additive, migration theo DO lifecycle hiện tại.

AES-GCM random IV, AAD store+connection+issuer, key tách database. Token refresh
single-flight + CAS; không để request cũ ghi đè refresh token đã rotate.

API quản trị đề xuất (tên/schema chốt khi triển khai):

| API | Vai trò |
|---|---|
| `GET /v1/integrations/pancake/status` | Source, connection status, last sync, counts, staleness; không secrets |
| `POST /v1/integrations/pancake/sync` | Trial/full dùng runner hiện có; auth admin + rate limit |
| `GET /v1/integrations/pancake/runs/:id` | Kết quả run theo store, lỗi đã lọc |
| `POST /v1/integrations/ctxlayer/connect` | Provision integration connection |
| `POST /v1/integrations/ctxlayer/complete` | BFF hoàn tất OAuth; one-time state |
| `DELETE /v1/integrations/ctxlayer/connection` | Pause job mới, tăng generation, revoke nếu hỗ trợ |
| API products/inventory Fufuni hiện có | Halifruit đọc DB, không gọi MCP |

Giá/tồn có snapshot age: hiển thị `last_success_at` trên trang vận hành, phân biệt
last_attempt và last_success. Khi sync hỏng, catalog đã commit vẫn đọc được;
quyết định stale stock có được checkout theo TTL hay phải chặn cần được cấu hình
và kiểm thử, tái sử dụng guard `inventory_stale` hiện có. Không hứa tồn POS real-time
hoặc giữ chỗ atomic chỉ vì job polling chạy thành công.

## 7. Cấu trúc folder đề xuất

Các file mới bên dưới là đề xuất, chưa được tạo bởi tài liệu này.

```text
fufuni/apps/merchant/src/
├── integrations/ctxlayer/               # mới: kết nối reusable
│   ├── config.ts                       # Typed Env, trusted endpoints
│   ├── contracts.ts                    # OAuth/status schemas
│   ├── oauth.ts                        # DCR/PKCE/refresh/revoke
│   ├── secrets.ts                      # Token encryption
│   ├── store.ts                        # DO persistence/RPC
│   ├── client.ts                       # MCP lifecycle, auth, deadline
│   └── errors.ts                       # Stable error mapping
├── integrations/pancake/                # mới: nguồn catalog
│   ├── catalog-source.ts               # Interface, source selector
│   ├── direct-source.ts                # Bọc reader REST hiện có
│   ├── mcp-source.ts                   # MCP → canonical source snapshot
│   ├── source-schemas.ts               # Schema/version/pagination checks
│   └── sync-runs.ts                    # Run status/checkpoints
├── lib/pancake-sync.ts                  # sửa: inject source, giữ orchestrator
├── lib/pancake-source.ts                # tách: model/normalize khỏi HTTP
├── lib/pancake-store.ts                 # sửa tối thiểu: run/source metadata
├── lib/stores.ts                        # cấu hình source theo store
├── routes/pancake.ts                    # mở rộng status/sync/run
├── routes/ctxlayer.ts                   # mới: integration provisioning
├── do.ts                               # schema, atomic claim/commit/refresh
├── types.ts                            # Env + RPC typing
└── index.ts                            # route/scheduled wiring

fufuni/apps/merchant/tests/
├── ctxlayer/                            # OAuth, isolation, transport tests
└── pancake-mcp-sync/                    # paging, mapping, rollback, replay
fufuni/apps/merchant/scripts/smoke-pancake-mcp-sync.mjs

pancake-pos-mcp/src/tools/               # chỉ thêm tool snapshot nếu gate yêu cầu

halifruit-fe-v1/src/lib/fufuni/           # giữ API đọc catalog hiện có
halifruit-fe-v1/src/app/<staff-area>/integrations/pancake/
                                        # status, connect, sync trial, run report
halifruit-fe-v1/src/app/api/integrations/ctxlayer/callback/
                                        # BFF provisioning, không phục vụ storefront
```

Không thêm SQL vào route. Schema/DO RPC state consume, lease fencing, snapshot
commit và token CAS phải atomic. Contract OpenAPI/backend và typed BFF cùng schema.
Chọn staff-area theo router/guard thực tế, không dựng trang public cho admin token.

## 8. Cấu hình local

| Dịch vụ | Địa chỉ dự kiến |
|---|---|
| ctxlayer | `https://localhost:8787/mcp` |
| Fufuni | `http://localhost:8788` |
| Pancake MCP | `http://127.0.0.1:3000/mcp` |
| Halifruit | `http://localhost:3002` |

Env đề xuất trong backend, chưa có hiệu lực cho đến khi triển khai:

```dotenv
PANCAKE_CATALOG_SOURCE=ctxlayer_mcp
PANCAKE_SYNC_ENABLED=false
CTXLAYER_MCP_ENABLED=false
CTXLAYER_MCP_URL=https://localhost:8787/mcp
CTXLAYER_PANCAKE_UPSTREAM_SLUG=up-pancake-pos
CTXLAYER_OAUTH_REDIRECT_URI=http://localhost:3002/api/integrations/ctxlayer/callback
CTXLAYER_TOKEN_KEY_VERSION=1
CTXLAYER_TOKEN_KEY=<base64 random 32-byte key trong private local env>
```

Giữ shop/kho mapping theo store; API key Pancake và `MCP_AUTH_TOKEN` cho mode MCP
chỉ cần tại Pancake MCP. Credential direct hiện có có thể vẫn cần cho workflow khác,
không xóa toàn cục khi chuyển reader catalog. Không đưa secret vào `NEXT_PUBLIC_*`.

Local Worker Fufuni dùng config Halifruit với `--local --port 8788`, persistence
riêng; không chạy lệnh deploy hoặc gọi URL backend production mặc định của FE.
Ban đầu chỉ trigger trial manual; bật cron local sau khi fixture pass. Tần suất
15 phút là cấu hình cron hiện có, cần đo quota/latency trước khi giữ cho MCP.

Gate network: probe discovery từ chính workerd Fufuni tới ctxlayer HTTPS local.
Tin cậy cert đúng cách; không `NODE_TLS_REJECT_UNAUTHORIZED=0`. Nếu phải thay
local transport/origin, đồng bộ issuer/resource/redirect/DCR trước OAuth, không
mở tunnel/deploy ngoài phạm vi local. Chưa cần Queue/Workflow/R2 mới cho snapshot
đã giới hạn; nếu runtime deadline không đủ, thiết kế durable dispatcher/staging
với ownership/checkpoint rõ ràng rồi mới mở rộng dung lượng.

## 9. Phases và checklist

### Phase 0 — baseline và contract

- [ ] Đọc AGENTS từng repo; ghi status/revision, giữ thay đổi sẵn có.
- [ ] Chạy baseline auth/store/pancake-sync/commerce; xác minh DO/store routing.
- [ ] Chốt integration principal, quyền read-only, config local và TLS workerd.
- [ ] Probe catalog/schema/response; lập field matrix normalizer vs MCP fields.
- [ ] Quyết định dùng tools hiện có hay thêm snapshot reader trong MCP con.

Gate: đủ field/pagination/kho và có đường OAuth cho background job; chưa commit catalog.

### Phase 1 — connection của store

- [ ] Typed Env, source flag default direct/disabled theo môi trường đã chọn; không tự bật cron.
- [ ] OAuth/DCR/PKCE, integration identity verification, encrypted token persistence.
- [ ] Refresh lock/CAS, disconnect generation và reauth_required; state/callback security.
- [ ] Gateway read-only rules; fake token không vượt auth và không fallback direct.

Gate: connection vẫn dùng được sau restart/backend job không có phiên browser.

### Phase 2 — source adapter và job trial

- [ ] Tách reader khỏi normalizer, CatalogSource interface và MCP implementation.
- [ ] Fixture catalog đa trang có product/variant/price/warehouse stock/flags/images.
- [ ] Trial một sản phẩm: fetch → normalize → atomic commit → đọc API Fufuni.
- [ ] Replay trial không tạo trùng; không retire sản phẩm ngoài trial.
- [ ] Gateway OFF/schema/auth/page lỗi giữ catalog trước, run báo lỗi rõ.

Gate: dữ liệu đã persist và còn đọc được khi MCP tắt; counter chứng minh job qua Gateway.

### Phase 3 — full snapshot và cron

- [ ] Manual/cron dùng chung lease, fencing và source selector theo store.
- [ ] Full snapshot completeness checks, counts/unique IDs, retire an toàn.
- [ ] Reservation preserved, giá VND đúng, stock đúng kho, policy draft giữ nguyên.
- [ ] Cache invalidation sau commit, warning riêng; stale inventory guard được kiểm thử.
- [ ] Retry/backoff/deadline/abandoned; không hai pipeline direct/MCP cùng ghi.

Gate: full sync và repeat đúng; process crash/page failure không tạo snapshot dở dang.

### Phase 4 — Halifruit đọc DB và trang vận hành

- [ ] FE/BFF dùng API catalog/inventory hiện có, không thêm MCP read-through.
- [ ] Staff UI status/connect/trial/full/report/disconnect, auth đúng store.
- [ ] Halifruit vẫn đọc snapshot trước khi Gateway offline; hiển thị trạng thái sync
      trên trang admin và áp dụng TTL giá/tồn cho checkout theo policy hiện có.
- [ ] Customer không gọi được sync/admin API và không thấy secret/run data nhạy cảm.

Gate: chứng minh API request storefront không phát sinh outbound MCP call.

### Phase 5 — nghiệm thu và handover local

- [ ] Offline multi-page fixture, OAuth real local, provider read-only khi có config.
- [ ] So sánh snapshot normalized của direct vs MCP trên cùng fixture, không so hai
      lần lấy live có thể đã thay đổi; provider probe ghi thời điểm/nguồn rõ ràng.
- [ ] Test hồi quy commerce/auth/store/sync; typecheck scoped nếu baseline repo còn lỗi.
- [ ] Báo cáo revision/command/pass-fail/limits; phân biệt fixture, OAuth và provider.
- [ ] Commit/PR theo repo, migration additive, rollback source flag có kiểm soát.

Gate: sản phẩm/biến thể/giá/tồn hiển thị qua Fufuni API và deny/revoke có bằng chứng.
Không mở đồng bộ đơn hàng hoặc ghi Pancake trong milestone này.

## 10. Ma trận kiểm thử

| Tình huống | Kết quả cần đạt |
|---|---|
| Cron không có browser session | Dùng connection store, refresh hợp lệ |
| State replay/sai store/issuer/browser | Không exchange hoặc lưu connection |
| Principal/grant bị revoke | Job blocked/reauth; không dùng credential khác |
| MCP tool/schema thiếu trường | Lỗi contract; không default làm sai sản phẩm |
| Giá VND, flags, ảnh và source SKU | Mapping giữ semantics hiện có |
| Stock hai warehouse | Chỉ nhập kho cấu hình, giữ reserved Fufuni |
| Snapshot đủ trang nhưng duplicate ID/count lệch | Reject snapshot, giữ DB trước |
| Trial một sản phẩm | Không retire ngoài trial; repeat không trùng |
| Full repeat/source direct→MCP | Stable ID và mapping không đổi |
| Manual/cron đồng thời; worker cũ mất lease | Chỉ chủ lease hiện hành được commit |
| Page 2 timeout/429/quyền bị thu hồi | Run lỗi/backoff; snapshot cũ nguyên vẹn |
| Crash trước/trong DO commit | Không có catalog nửa mới nửa cũ |
| Source config/disconnect đổi giữa run | Generation/fingerprint check chặn commit cũ |
| Commit xong cache purge lỗi | Success with warning; không chạy lại mutation ngoài ý muốn |
| Hai store/shop | Không lẫn token/link/giá/tồn/run status |
| Gateway OFF sau sync | FE đọc DB; job mới thất bại; stale checkout guard áp dụng |
| Customer mở trang sản phẩm | Không MCP initialize/callTool |
| Provider read-only trial/full | Không tạo/sửa/xóa trên Pancake |

Audit chỉ lưu run/store/source/tool/code/latency/count, không log token, OAuth code,
credential-bearing URLs, full provider bodies hoặc raw data có định danh nhạy cảm.
CLI dùng RTK; không lọc JSON nghiệp vụ bằng RTK và không dùng LLM cho normalize.

## 11. PR và rollback

1. Contract/source split + MCP snapshot tool nếu cần.
2. OAuth integration connection theo store và persistence/refresh tests.
3. MCP CatalogSource + job trial/full/lease/commit/cache acceptance.
4. Halifruit status/provisioning UI + đọc catalog đã persist + local evidence.

Tắt job mới bằng flags; connection revoke/disconnect nếu cần. Rollback source mode
chỉ bởi admin có audit sau xác minh mapping/schema parity, không fallback tự động.
Giữ catalog đã commit và run history; không drop bảng token/run trong rollback.
Provider OFF không tự xóa catalog hoặc ép inventory về 0. Checkout vẫn theo policy
stale inventory, không bỏ guard để trang có vẻ hoạt động.

## 12. Trạng thái

Đã triển khai trong working tree Fufuni và Pancake MCP, kèm thay đổi identity
resource của Gateway. Các phase/checklist phía trên là tiêu chí gốc; bằng chứng
đã đạt và giới hạn thực tế được ghi bên dưới, không mặc định mọi checkbox đã đạt.

## 13. Báo cáo triển khai local

### Đã có code

- Pancake MCP: tool mới `read_catalog_snapshot`, action `page`, 30 biến thể/trang,
  tối đa 20 trang/600 biến thể. Trả shop ID, warehouse, count metadata và schema
  version 1; allowlist fields giữ giá/currency, ảnh, SKU, trạng thái và stock theo kho.
  Không dùng compact masks làm mất field, không trả audit identifiers không cần thiết.
- ctxlayer: resource có xác thực `ctxlayer://identity` trả user ID hiện hành,
  chặn tài khoản không active; Fufuni dùng để đối chiếu integration principal.
- Fufuni: `src/integrations/ctxlayer/{config,secrets,store,client,oauth,setup-html}.ts`,
  `src/integrations/pancake/{mcp-source,sync-runs}.ts`, `src/routes/ctxlayer.ts`.
  Có OAuth/DCR/PKCE, encrypted tokens theo store/config, state/browser/actor binding,
  token refresh CAS, disconnect generation và run history trong MerchantDO.
- Runner `pancake-sync.ts` chọn source `direct` hoặc `ctxlayer_mcp`, không fallback.
  Manual và cron dùng cùng runner/lease. MCP mode không cần Pancake API key ở reader
  Fufuni; không xóa key phục vụ workflow direct/order khác.
- Trial/full dùng normalizer, stable IDs và transaction catalog có sẵn; giữ reserved,
  chỉ retire absent ở full snapshot hợp lệ; kiểm tra lease/connection generation khi commit.
  Mất Gateway/quyền/schema/page lỗi không thay snapshot đã commit.
- Trang vận hành local đặt tại Fufuni `/v1/integrations/ctxlayer/setup`: connect,
  status, complete OAuth, trial/full và disconnect. Mutation dùng JWT staff Fufuni
  đã verify, browser binding/Origin protection; token nhập chỉ ở memory trang.
  Sau redirect OAuth phải nhập lại JWT để hoàn tất, không lưu vào localStorage.
- Halifruit giữ đường đọc API Fufuni hiện có, không thêm MCP vào storefront.
  Source đã kiểm tra cho thấy NextAuth của Halifruit hiện chưa cấu hình staff login
  (`isAuthConfigured()` trả false). Vì vậy màn hình vận hành chạy ở backend Fufuni;
  không dựng BFF giả danh nhân viên bằng admin key dùng chung.
- Test-only entry `tests/fixtures/ctxlayer-runtime-worker.ts` chỉ được dùng bởi test
  config tạm; production main không tham chiếu, không có route seed/bypass trong app thật.

### Kiểm chứng đã chạy

| Kiểm tra | Kết quả |
|---|---|
| ctxlayer `VITEST_MAX_WORKERS=2 bun run verify` qua RTK | Đạt typecheck/lint/unit/integration |
| Gateway catalog integration | D1/ACL thật + SDK client/leaf transport, identity resource, session cũ bị chặn sau OFF và user suspend |
| Pancake MCP `bun run typecheck`, `bun run test` | Đạt; catalog contract cập nhật 25 tools, tổng 166 tests |
| Fufuni `npm run typecheck:ctxlayer`, `npm run test:ctxlayer` | Đạt; 12 test về state, CAS, mã hóa, job commit, rollback và schema |
| Fufuni `npm run test:ctxlayer:runtime` | Đạt trên Worker/SQLite thật, OAuth issuer và MCP HTTP là fixture local |
| Runtime trial/full/repeat | 1 → 31 → 31 sản phẩm, created counts 1 → 30 → 0; hai trang nguồn |
| Runtime OFF/disconnect | Job thất bại, upstream read count không tăng; API catalog vẫn trả 31 sản phẩm đã lưu |
| Hồi quy Fufuni | `test:pancake`, `test:stores`, `test:shipping`, `test:commerce` đạt |
| Halifruit | Jest `src/lib/fufuni/fufuni.test.ts --runInBand` đạt, không sửa source frontend |
| Fufuni Worker dry-run | Đạt với config Halifruit; không deploy |
| Probe workerd → Gateway HTTPS local | Metadata trả HTTP 200, không tắt kiểm tra TLS |

Runtime fixture kiểm tra PKCE/refresh/identity và đường HTTP đến database; test
Gateway riêng dùng proxy/policy production. Chưa chạy một acceptance có browser,
IdP thật, integration principal thật và API shop thật trên cùng một chain.
Không tính fixture là bằng chứng đã đồng bộ dữ liệu khách hàng thật.

Windows Application Control chặn workerd cũ đi kèm Wrangler 4.90.1. Đã nâng
dev dependency merchant lên Wrangler **4.120.1** và workers-types **5.20260804.1**
(SDK MCP client ghim **1.29.0**), cập nhật npm lockfile và chạy lại runtime/dry-run.
Không thay đổi chính sách Windows. Full `tsc -p tsconfig.json` Fufuni còn lỗi nền
ở AI tokens/categories/checkout/orders; typecheck phạm vi tích hợp đã đạt.

### Chạy lại và cấu hình tài khoản thật trên local

1. Khởi động lại Pancake MCP bằng source mới; refresh catalog trong ctxlayer.
   Catalog mới có 25 tools, gồm `read_catalog_snapshot`.
2. Tạo/chọn integration user trong ctxlayer; gán Team/Product và visibility của
   `up-pancake-pos`; ghi user ID vào `CTXLAYER_PRINCIPAL_ID` ở Fufuni.
3. Invocation policy của upstream chọn Product đó, chỉ allow tool
   `read_catalog_snapshot`, action `page`, resource argument `warehouse_id`
   là ID kho thực tế đã cấu hình. User tích hợp phải thuộc Team của Product.
4. Cấu hình private Fufuni `.dev.vars`: source `ctxlayer_mcp`, MCP flag true,
   Gateway URL, slug, principal ID, shop/kho và token encryption key.
   Redirect URI dùng `http://localhost:8788/v1/integrations/ctxlayer/callback`
   cho default store; store khác dùng prefix `/stores/<id>` tương ứng.
   Giữ `PANCAKE_SYNC_ENABLED=false` cho tới khi trial/full được nghiệm thu.
5. Fufuni local database cần currency VND active/decimal_places=0 và region phù hợp
   theo provisioning có sẵn. Không chạy script init với URL backend production mặc định.
6. Chạy `rtk npm run dev:halifruit:local` từ `fufuni/apps/merchant`; mở
   `http://localhost:8788/v1/integrations/ctxlayer/setup`. Dùng staff JWT có quyền
   admin store để provision. Đăng nhập ctxlayer bằng đúng integration user;
   principal khác bị từ chối khi đọc identity resource.
7. Trial một sản phẩm, kiểm tra report và API DB; full/repeat; sau đó mới bật cron.
   Disconnect xóa credential local và chặn run mới; response ghi rõ chưa revoke
   issuer grant từ xa. Muốn thu hồi grant hoàn toàn, dùng quản trị grants ctxlayer.
8. Halifruit local đặt `FUFUNI_BACKEND_URL=http://localhost:8788` và public key
   của đúng local database. Trang sản phẩm tiếp tục dùng API Fufuni hiện có.

```powershell
# Từ fufuni/apps/merchant, không cần credential Pancake thật cho các fixture tests
rtk npm run typecheck:ctxlayer
rtk npm run test:ctxlayer
rtk npm run test:ctxlayer:runtime
rtk proxy node scripts/probe-ctxlayer-local.mjs https://localhost:8787
```

### Giới hạn và bàn giao

- Còn nghiệm thu IdP/browser thật và provider read-only với tài khoản/shop đã cấu hình.
  Không có remote Cloudflare deploy, remote migration hay provider mutation trong đợt này.
- Chưa thêm incremental sync, durable queue executor, retention/cleanup run history
  hoặc keyring nhiều encryption versions. Full snapshot vẫn chịu giới hạn cũ;
  run quá lease sẽ không được commit. Quy mô lớn cần phase staging/checkpoint riêng.
- Không cache OAuth secret hoặc connection trong biến global. Disconnect local được
  kiểm tra lại khi commit; không tuyên bố atomic revocation giữa Gateway và Fufuni.
- Thay đổi Fufuni được giữ trong working tree để không gom các file nền chưa commit
  của người dùng vào một PR không thể review. Bản đối chiếu trước khi sửa nằm ở
  `C:/Users/ADMIN/AppData/Local/Temp/kedi-sync-baseline-20261016/fufuni`.
