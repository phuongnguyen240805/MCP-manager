# Worker dev trên tài khoản Cloudflare của bạn

Worker này là `ctxlayer-dev` (`[env.dev]` trong `wrangler.toml`). Nó dùng bộ
tài nguyên riêng trên **tài khoản của bạn**. Không deploy từ file này và
không điền credential thật vào git.

`wrangler dev` (local) **không** dùng `[env.dev]`. Local vẫn là top-level +
`.dev.vars`. `[env.dev]` chỉ dành cho `wrangler deploy --env dev`.

Tên R2, Vectorize và queue là **toàn account**. Đừng deploy worker này vào
đúng account đang chạy production `ctxlayer` nếu production đã chiếm các tên
đó — hai worker sẽ dùng chung bucket, index và queue.

## Plan

Cần **Workers Paid**. Durable Objects, Queues và Vectorize không chạy trên
plan Free. Workers AI phải được bật trên account (binding `AI`, không có id);
lượt gọi tính phí theo neuron. R2 có hạn mức riêng, không thay plan của Worker.

## Tài nguyên phải tồn tại

| Tài nguyên | Tên | Binding |
|---|---|---|
| D1 | `ctxlayer-dev` | `DB` |
| KV | namespace tạo với title `ctxlayer-dev-oauth` | `OAUTH_KV` |
| R2 | `ctxlayer-docs` | `DOCS_BUCKET` |
| Vectorize | `ctxlayer-docs` — 768 chiều, metric cosine | `DOCS_INDEX` |
| Vectorize | `ctxlayer-docs-lexical` — 1536 chiều, metric cosine | `DOCS_LEXICAL_INDEX` |
| Workers AI | bật trên account, không tạo id | `AI` |
| Durable Object | class `DocRoomDO` (`new_classes`) và `McpSessionDO` (`new_sqlite_classes`) | `DOC_ROOM_DO`, `MCP_SESSION_DO` |
| Queue | `ctxlayer-usage` | `USAGE_QUEUE` |
| Queue | `ctxlayer-reindex` | `DOC_REINDEX_QUEUE` |
| Queue | `ctxlayer-git-sync` | `GIT_SYNC_QUEUE` |
| Queue | `ctxlayer-jobs` | `JOBS_QUEUE` |

Durable Object không có lệnh create riêng. Migration `v1` trong `[env.dev]`
tạo class ở lần deploy đầu. Cron của top-level (`0 3 * * *`, `0 * * * *`)
được kế thừa.

`database_id` và KV `id` trong `[env.dev]` đang là id toàn số 0. `bootstrap`
thấy placeholder đó thì tạo tài nguyên và ghi id thật lại vào `wrangler.toml`.

## Lệnh

Từ root repo, sau `wrangler login` (hoặc `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID`):

```bash
bun install --frozen-lockfile
bun run bootstrap -- --env dev
wrangler d1 migrations apply DB --remote --env dev
```

`bootstrap --env dev` chỉ sửa id trong `[env.dev]`. Nó không đụng D1/KV của
worker top-level. Nó vẫn tạo (nếu chưa có) bucket `ctxlayer-docs`, hai index
Vectorize và bốn queue ở trên.

Secrets — `wrangler secret put` hỏi giá trị trên stdin, không đặt giá trị lên
argv và không commit. Chưa có secret thì đường gateway tắt; cookie vẫn chạy
khi đã có `SESSION_COOKIE_SECRET`.

```bash
wrangler secret put ENCRYPTION_KEY --env dev
wrangler secret put SESSION_COOKIE_SECRET --env dev
wrangler secret put KEDI_GATEWAY_ISSUER --env dev
wrangler secret put KEDI_GATEWAY_AUDIENCE --env dev
wrangler secret put KEDI_GATEWAY_PUBLIC_JWK --env dev
wrangler secret put KEDI_GATEWAY_ALLOWED_TENANTS --env dev
```

`ADMIN_EMAILS` và secret IdP (`GOOGLE_*`, `GITHUB_*`) chỉ cần khi đăng nhập
bằng cookie. Gateway không dùng chúng.

Subdomain `workers.dev` nằm ở dashboard Workers & Pages. Deploy:

```bash
export PUBLIC_BASE_URL="https://ctxlayer-dev.<subdomain>.workers.dev"
bun run deploy -- --env dev
```

`scripts/deploy.mjs` từ chối origin còn chữ `example.workers.dev`. Sau deploy,
nếu URL thật khác giá trị đã export, sửa `PUBLIC_BASE_URL` và deploy lại.

## Curl local (không deploy)

1. Copy `.dev.vars.example` thành `.dev.vars`. Điền `ENCRYPTION_KEY` và
   `SESSION_COOKIE_SECRET` (`openssl rand -base64 32`). Giữ bốn biến
   `KEDI_GATEWAY_*` ; issuer, audience và tenant giữ đúng placeholder.
2. Tạo cặp khóa dev và một assertion (private key nằm ở
   `.dev-kedi-gateway-key.json`, không in ra):

```bash
bun scripts/kedi-gateway-assertion.mjs
```

3. Dán dòng `KEDI_GATEWAY_PUBLIC_JWK=...` đè placeholder trong `.dev.vars`.
4. Terminal khác: `bun run dev:worker` (HTTPS `https://localhost:8787`).
5. Gọi me bằng JWT script vừa in (hết hạn sau 60 giây; chạy lại script để
   ký assertion mới, khóa public không đổi trừ khi `--rotate`):

```bash
curl -k https://localhost:8787/api/me \
  -H "Authorization: Bearer <assertion>"
```

Member nhận 200 ở `/api/me` và 403 ở `/api/admin/users`. Admin:

```bash
bun scripts/kedi-gateway-assertion.mjs --role admin --sub user_admin
```

Cookie + `X-CSRF` không đổi khi request không gửi `Authorization`.
