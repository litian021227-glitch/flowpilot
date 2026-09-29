# FlowPilot 面试演示指南

## 一句话介绍

FlowPilot 是一个面向企业团队的 AI 工作流平台：它把企业知识、任务执行和人工审批串成闭环，让 Agent 输出结果后还能继续生成汇报或跟进任务。

## 推荐演示路径

1. 从官网进入产品预览，说明产品定位和使用场景。
2. 在工作台输入“分析本月销售数据，并给出三个改进建议”。
3. 展示 Agent 执行轨迹：理解任务、检索知识、分析计算、生成结果。
4. 展示来源引用，说明结果不是无依据生成。
5. 点击“生成汇报”或“创建跟进任务”，说明关键动作需要人工审批。
6. 打开任务中心，说明任务状态会被持久化并支持后续追踪。

## 技术架构

```text
React + Vite
      │
      ├── 工作台 / 知识库 / 任务中心
      │
      ▼
Node.js HTTP API
      ├── Agent 编排：/api/agent/run
      ├── 知识入库：/api/knowledge/ingest
      ├── 知识检索：/api/knowledge/search
      ├── 任务查询：/api/tasks
      └── 审批落地：/api/tasks/:id/approve
      │
      ├── OpenAI Responses API
      └── Supabase Postgres + pgvector
```

## Agent 设计要点

- 先检索上下文，再调用模型，降低脱离业务知识回答的风险。
- 每次执行返回 `summary`、`sources`、`trace` 和 `requiresApproval`。
- 生成汇报、创建跟进任务等有副作用的动作进入人工审批。
- OpenAI 限流或暂时不可用时进入 fallback 模式，任务仍然可追踪，不让用户看到空白错误。

## 面试中可以主动讲的工程取舍

### 为什么先做关键词检索？

当前版本优先保证一到两周内可上线和可演示，先采用可解释的文本切分与关键词检索。下一步可以把 `knowledge_chunks.embedding` 接入向量生成和相似度检索，再加入 rerank。

### 为什么保留人工审批？

Agent 的分析可以自动完成，但生成外发汇报或创建业务任务会产生实际影响。审批节点把建议和执行分开，符合企业对权限、责任边界和可追溯性的要求。

### 如何处理模型服务不可用？

服务端区分真实模型模式和 fallback 模式。遇到 429 或上游 5xx 时返回可解释的降级结果，并保留任务状态；遇到鉴权错误则明确提示配置问题。

## 部署信息

- 前端和 Node API：Render Web Service
- 数据库：Supabase Postgres
- 数据库初始化：`supabase/schema.sql`
- 生产环境变量：`OPENAI_API_KEY`、`OPENAI_MODEL`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`
- 健康检查：`GET /api/health`

## 后续迭代路线

1. 接入登录、workspace membership 和真正的 RLS 权限策略。
2. 将关键词检索升级为 embedding + pgvector 相似度检索。
3. 把 Agent 工具调用抽象为可注册工具，并记录每次 tool call。
4. 增加结构化输出 schema、重试策略、超时和成本统计。
5. 为关键 API 增加审计日志、限流和请求 ID。
