# 成年审核 · 激活码自助申请 — 部署与使用

## 流程一览
1. 用户在登录页点「没有激活码？申请内测资格 →」打开 `/verify`；
2. 填昵称/联系方式 + 上传成年证明图片 → 提交 → 得到**查询码**（VR-XXXXXXXX，自动存浏览器）；
3. 你在 `/verify/admin` 输入管理密钥审核：看图 → **通过并发码**（自动从 activation_codes 挑一个未用的绑定）或 **拒绝**（可填原因）；审核完成图片**立即从存储删除**；
4. 用户回 `/verify` 查询进度，通过后页面直接显示激活码。

## 上线前要做的两件事
1. **Supabase SQL Editor 执行一次** `docs/verify-supabase.sql`
   （建 `verification_requests` 表 + 私有桶 `verification-images`）。
2. **Netlify 环境变量加** `VERIFY_ADMIN_KEY=<你自己定的长密钥>`
   （本地开发放 `.env.local`）。没配这个变量审核台不可用（接口一律 401）。

## 安全/隐私设计
- 图片存**私有桶**，只有服务端（service_role）能读；管理页看图走 `/api/verify/admin/image` 代理，需管理密钥。
- 申请表 RLS 开启且无 policy → 客户端无法直接读写，只能走我们的 API。
- **审核完成（通过/拒绝）即删图**，库里只留文字记录（联系方式、状态、发放的码）。
- 查询码 8 位去混淆字符随机（31^8 ≈ 8500 亿组合），只有持码人能查到自己的状态。
- 提交接口：4MB/张、仅 JPG/PNG/WebP、同 IP 60 秒节流（尽力而为）。
- 发码逻辑：从 `activation_codes` 里挑 `status=active && used_count=0 && 未过期 && 未发给别的申请` 的码；
  没有可用码时审核会报错提示你先去补码。

## 日常操作
- 审核台：`https://<你的域名>/verify/admin`（手机也能用，密钥记在浏览器里）。
- 补激活码：往 Supabase `activation_codes` 表插新行即可（`code` 填你想要的码，其它字段默认）。
- 拒绝时填的原因会原样展示给申请者。
- 审核密钥 `VERIFY_ADMIN_KEY` 请妥善保管；遗忘可到部署平台环境变量里查看或重置。
