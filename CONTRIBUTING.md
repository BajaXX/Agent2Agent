# 贡献指南

感谢你对 Agent2Agent 感兴趣！无论是提交 Issue、修复 Bug、改进文档还是新增特性，都欢迎参与。

## 开发环境

- Node.js ≥ 20
- 可选：Docker + Docker Compose（容器内开发 / 验证部署）

```bash
git clone git@github.com:BajaXX/Agent2Agent.git
cd Agent2Agent
npm install
npm start        # 启动服务端，默认 http://127.0.0.1:3081
```

## 代码结构

```
server/          # 平台服务端（Express + better-sqlite3 + 文件系统）
  src/db.js      #   SQLite 初始化与迁移
  src/auth.js    #   token 签发 / 校验（sha256）
  src/storage.js #   文档 / 记忆文件读写
  src/sse.js     #   SSE 事件分发
  src/routes/    #   accounts / messages / tasks / documents / memory / summary / events
web/             # 人类看板（纯静态 SPA，无构建链）
cli/platform.js  # 统一 CLI（单文件、零第三方依赖）
skills/          # 统一 skills 包（SKILL.md 规范 + 各产品安装说明书）
docs/            # design.md（系统设计）+ api.md（API 契约）
scripts/         # 冒烟测试
```

## 提交规范

- 提交信息使用英文，采用 [Conventional Commits](https://www.conventionalcommits.org/) 风格：

  ```
  feat: 新增能力
  fix: 修复缺陷
  docs: 文档变更
  refactor: 重构
  test: 测试
  ```

- 一个提交只做一件事，保持历史清晰。
- 提交前请确保冒烟测试通过：`bash scripts/smoke-test.sh`（49 项断言）。

## 测试

```bash
bash scripts/smoke-test.sh
```

冒烟测试覆盖：注册 / 鉴权 / 消息收发与状态机 / 任务看板 / 文档上传下载 / 双向镜像同步与冲突 / 记忆版本与乐观锁 / check-in / 聚合与 SSE / 幂等键。

## Issue 规范

- 提问前先搜索是否已有相似 Issue。
- Bug 报告请包含：复现步骤、预期行为、实际行为、服务端日志、环境信息。
- 特性建议请说明使用场景与期望行为。

## Pull Request 流程

1. Fork 仓库并创建特性分支：`git checkout -b feat/your-feature`。
2. 实现变更并补充 / 更新测试。
3. 运行冒烟测试确认无回归。
4. 提交并推送，创建 PR 时描述变更动机与影响范围。
5. 保持 PR 小而聚焦，便于评审。

## 许可证

提交代码即表示你同意其以 [MIT License](./LICENSE) 授权发布。
