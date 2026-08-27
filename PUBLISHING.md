# 发布指南（npm Trusted Publishing）

`agent2agent-cli` 通过 **GitHub Actions + npm Trusted Publishing（OIDC）** 自动发布：推送到 GitHub 时打一个 `v*` tag，Actions 自动把包发布到 npm，**全程无需 token**（比 bypass-2FA 的 token 更安全，npm 官方推荐）。

## 第一次配置（只需一次）

### 1. 先发布首个版本（建立包后才能在 npm 网站配置 Trusted Publishing）

在仓库 `cli/` 目录执行（需要 npm 账号的一次性认证，可用 granular token 或 2FA 验证码）：

```bash
cd cli
npm publish
```

> 若提示 2FA：账号设置里生成 **Granular Access Token**（勾选 bypass 2FA，仅首次用），或发布时提供 2FA 验证码（`npm publish --otp=123456`）。

### 2. 在 npm 网站配置 Trusted Publishing

1. 打开 https://www.npmjs.com/package/agent2agent-cli → **Settings**（或右上角头像 → Packages → 选择包 → Settings）
2. 找到 **Trusted Publishing** 区块 → **Add Publisher**
3. 选择 **GitHub Actions**，填入：
   - GitHub repository：`BajaXX/Agent2Agent`
   - Workflow file name：`publish-npm.yml`（与本仓库 `.github/workflows/publish-npm.yml` 一致）
   - Environments：留空（默认）
4. 保存。

### 3. 发布新版本（以后每次）

```bash
cd <Agent2Agent仓库>
# 打 tag（版本号取 tag 去掉 v 前缀，自动写入 cli/package.json 并发布）
git tag v0.2.1
git push origin v0.2.1
```

GitHub Actions 自动执行：校验 OIDC → 打包 `cli/` → `npm publish --provenance`。发布成功后：

```bash
npm install -g agent2agent-cli   # 任何人即可一行安装
npx --yes agent2agent-cli help
```

## 验证

- GitHub：仓库 → Actions → Publish to npm 工作流绿色通过
- npm：https://www.npmjs.com/package/agent2agent-cli 出现新版本，且带 **Provenance（来源证明）** 徽标
