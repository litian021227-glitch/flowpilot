# FlowPilot 生产化执行报告（2026-09-30）

## 执行基线

- 线上基线：`83acf38`，Render 处于 Live。
- 本轮改动在本地完成，未自动推送、未自动部署、未操作 Supabase 控制台，也未创建 OAuth 应用或发送真实邀请邮件。
- 本轮没有把任何真实 API Key、JWT、OAuth secret 或 service role key 写入仓库、日志、测试 fixture 或前端构建产物。

## 已完成的代码改动

### Agent 与 API

- 增加 DeepSeek/OpenAI provider 的统一超时配置：`AI_TIMEOUT_MS`、`AI_MAX_RETRIES`。
- 对超时、408、429、5xx 做有限指数退避；失败进入可解释 fallback，不让任务永久停留在 running。
- 增加请求体大小限制、request id、结构化请求完成日志和脱敏错误日志。
- 增加 Agent 请求幂等键入口；内存模式已覆盖，Supabase 完整能力需要执行迁移。
- 增加任务状态机校验，禁止非法状态跳转。

### Auth 与 workspace

- 统一解析 Bearer 用户、workspace header/query 和 membership role。
- 任务、知识、审批、Agent runs、审计、团队、集成和设置的 Supabase 查询开始使用 workspace scope。
- `REQUIRE_AUTH=true` 时匿名业务请求返回 401；健康检查保持公开。

### 知识库

- 增加 PDF、DOCX、XLSX、CSV、TXT 文件 API。
- 增加扩展名、MIME、文件魔数、大小校验。
- 增加 Supabase Storage 上传、异步索引状态、删除和重新索引 API。
- 增加前端知识库上传入口和 processing/failed 状态展示。
- Storage bucket 和数据库迁移仍需人工在 Supabase 控制台完成。

### 集成与团队

- Slack/Notion/Webhook 未完成 OAuth 或签名校验前只能显示未连接/待配置。
- Webhook 增加 HMAC、时间戳防重放、event id 幂等和 payload 限制。
- 邀请增加 token hash、过期时间、接受/拒绝接口和一次性状态。
- 增加成员角色更新和移除接口，owner 不能被移除或降级。

### 测试与 CI

- 增加 `npm test` 和 GitHub Actions CI：安装、构建、测试、diff 检查。
- 自动化覆盖健康检查、Demo fallback、幂等重复提交、文件类型拒绝、Webhook 签名/重放和生产模式匿名拒绝。

## 已实际通过的命令

```text
npm ci       PASS
npm run build PASS
npm test     PASS (5 tests)
git diff --check PASS
```

## 未完成或需要人工确认

1. Supabase 执行 `supabase/migrations/20260930_production_hardening.sql`。
2. 创建私有 Storage bucket `flowpilot-knowledge` 并配置 Storage RLS policy。
3. Supabase 配置邮箱确认、Auth redirect URL，并将真实用户 UUID 写入 `workspace_members`。
4. 确认 Render 的 `AI_API_KEY`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` 等变量，然后在权限验收后设置 `REQUIRE_AUTH=true`。
5. 轮换历史上曾经暴露或使用过的旧 API Key。
6. 使用真实 DeepSeek Key 对 Render 线上 `/api/agent/run` 做成功、429、超时和错误配置测试。
7. 真实登录、RLS 跨 workspace 隔离、文件 Storage 生命周期和 OAuth 尚未完成线上验收。
8. Slack/Notion OAuth、外部通知发送、异步队列/可替换 worker、embedding/向量混合检索和监控告警仍未完成。

## 真实线上测试结论

本轮尝试访问 `https://flowpilot-9hrw.onrender.com/api/health` 和 Agent 接口时，本机 Windows Schannel 在 TLS 握手阶段返回 `SEC_E_NO_CREDENTIALS`，请求未到达 Render。因此不能声称真实 DeepSeek 调用已经通过；需要在浏览器、Render Shell 或网络凭据正常的环境重新执行。

## 部署建议

当前本地代码可以继续部署，但在 Supabase migration、Storage、membership 和生产环境变量完成前，不建议把 Render 切换到 `REQUIRE_AUTH=true`。完成人工清单后，再推送本轮提交并按 smoke test 验收：健康检查、匿名 401、登录、任务、Agent、审批、文件上传/删除、跨 workspace 隔离、Webhook 重放和回滚。
