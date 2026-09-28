# FlowPilot

FlowPilot 是一个面向企业团队的 AI 业务流程自动化平台 Demo，展示从任务输入、知识库检索、Agent 执行到人工审批和任务更新的完整闭环。

## 功能

- AI 任务工作台：销售分析、结果摘要、趋势图表和来源引用
- Agent 执行轨迹：任务理解、知识库检索、数据分析和结果生成
- 知识库：文档录入、文本切分、关键词检索
- 任务中心：任务列表、状态筛选、Agent 任务和审批任务
- 人工审批：生成汇报、创建跟进任务并持久化状态
- Demo fallback：没有外部服务配置时也可以完整演示
- Supabase-ready：提供 PostgreSQL、pgvector、RLS schema

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
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
API_PORT=8787
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

没有 `OPENAI_API_KEY` 时，Agent 使用 Demo 模式；没有 Supabase 配置时，任务和知识片段使用内存 fallback。

## 数据库

在 Supabase SQL Editor 中执行 `supabase/schema.sql`。生产环境需要把示例 RLS policy 改为基于 workspace membership 的权限策略，并且只在服务端使用 `SUPABASE_SERVICE_ROLE_KEY`。

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
4. 在 Environment 中填写 `OPENAI_API_KEY`、`SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`。
5. 点击 Apply，等待构建完成。
6. 打开 `https://你的服务名.onrender.com/api/health`，看到 `ok: true` 即部署成功。

Render 会使用 `npm ci` 构建，并用 `npm start` 启动；服务会自动监听 Render 注入的 `PORT`。
