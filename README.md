# FlowPilot

FlowPilot 是一个面向企业团队的 AI 业务流程自动化平台 Demo，展示从任务输入、知识库检索、Agent 执行到人工审批和任务更新的完整闭环。

面试演示、架构说明与追问准备见：[docs/INTERVIEW_GUIDE.md](docs/INTERVIEW_GUIDE.md)

完整交付状态与生产化缺口见：[docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md)

## 功能

- AI 任务工作台：销售分析、结果摘要、趋势图表和来源引用
- Agent 执行轨迹：任务理解、知识库检索、数据分析和结果生成
- 知识库：文档录入、文本切分、关键词检索
- 任务中心：任务列表、状态筛选、Agent 任务和审批任务
- 人工审批：生成汇报、创建跟进任务并持久化状态
- Demo fallback：没有外部服务配置时也可以完整演示
- Supabase-ready：提供 PostgreSQL、pgvector、RLS schema

## 工作流接口

- `POST /api/agent/run`：执行 Agent，持久化任务、运行记录和审批请求
- `GET /api/tasks`：查看任务中心
- `POST /api/tasks`：手动创建任务
- `PATCH /api/tasks/:id`：更新任务标题或状态
- `GET /api/tasks/:id`：查看任务详情、Agent 运行和审计轨迹
- `GET /api/workspaces`：查看工作区
- `GET /api/team`：查看工作区成员
- `POST /api/team/invite`：创建成员邀请记录
- `GET /api/integrations`：查看应用集成目录和连接状态
- `PATCH /api/integrations/:provider`：更新集成连接状态
- `GET /api/settings`：查看工作区设置
- `PATCH /api/settings`：更新模型、审批开关和并发限制
- `POST /api/tasks/:id/approve`：通过或拒绝任务审批
- `POST /api/knowledge/ingest`：导入知识文档并切分内容
- `GET /api/knowledge/documents`：查看知识库文档
- `GET /api/knowledge/chunks?documentId=...`：查看文档切分后的知识片段
- `GET /api/approvals`：查看待审批事项
- `GET /api/agent/runs?taskId=...`：查看 Agent 执行记录
- `GET /api/audit?taskId=...`：查看任务审计轨迹
- `GET /api/workspace/summary`：一次获取工作台统计和各模块数据

## 本地运行

```bash
npm install
npm run api
npm run dev
```

前端默认地址：`http://127.0.0.1:5173`

API 健康检查：`http://127.0.0.1:8787/api/health`

## 环境变量

复制 `.env.example` 为 `.env`：

```env
AI_PROVIDER=deepseek
AI_API_KEY=
AI_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-flash
API_PORT=8787
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
ALLOWED_ORIGIN=*
REQUEST_LIMIT=120
```

没有 `AI_API_KEY` 时，Agent 使用 Demo 模式；没有 Supabase 配置时，任务和知识片段使用内存 fallback。项目仍兼容旧的 `OPENAI_API_KEY` / `OPENAI_MODEL` 配置。

API 默认按客户端地址限制每分钟 POST 请求数，可通过 `REQUEST_LIMIT` 调整；生产环境建议将 `ALLOWED_ORIGIN` 设置为正式前端域名。

Supabase Auth 已接入邮箱登录、注册、会话恢复和退出。完成 Supabase Auth 配置并确认 `workspace_members` 成员关系后，将 Render 的 `REQUIRE_AUTH` 改为 `true`，后端会校验 Bearer Token；开发阶段保持 `false` 可继续使用 Demo 模式。

## 数据库

在 Supabase SQL Editor 中执行 `supabase/schema.sql`。脚本包含 `workspace_members` 和基于成员角色的 RLS policy；首次启用真实登录后，需要把注册用户的 UUID 写入 `workspace_members`，再允许其访问对应工作区。`SUPABASE_SERVICE_ROLE_KEY` 只允许在服务端使用。

## Docker

```bash
docker build -t flowpilot .
docker run --env-file .env -p 8787:8787 flowpilot
```

## 生产部署建议

- 前端部署到 Vercel 或静态托管平台
- API 部署到 Railway、Render、Fly.io 或任意 Node 容器平台
- 将 `/api` 代理到 API 服务地址
- 配置 OpenAI 和 Supabase 服务端密钥
- 上线前替换 Demo RLS policy、增加日志和限流

## Render 一体化部署

项目已提供 `render.yaml`，适合将前端和 API 部署为一个 Web Service：

1. 将项目推送到 GitHub。
2. 登录 Render，选择 New → Blueprint。
3. 选择这个 GitHub 仓库，Render 会读取 `render.yaml`。
4. 在 Environment 中填写 `AI_API_KEY`、`SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`。当前 Blueprint 默认使用 DeepSeek：`AI_BASE_URL=https://api.deepseek.com`、`AI_MODEL=deepseek-flash`。
5. 确认 `ALLOWED_ORIGIN` 为 `https://flowpilot-9hrw.onrender.com`；如果 Render 分配了新的服务域名，需要同步修改。
6. 点击 Apply，等待构建完成。
7. 打开 `https://你的服务名.onrender.com/api/health`，看到 `ok: true` 即部署成功。

Render 会使用 `npm ci` 构建，并用 `npm start` 启动；服务会自动监听 Render 注入的 `PORT`。
