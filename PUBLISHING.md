# 发布指南（npm Trusted Publishing）

`agent2agent-cli` 通过 **GitHub Actions + npm Trusted Publishing（OIDC）** 自动发布：推送到 GitHub 时打一个 `v*` tag，Actions 自动把包发布到 npm，**全程无需 token**（比 bypass-2FA 的 token 更安全，npm 官方推荐）。

## 第一次配置（已完成 ✅）

> `agent2agent-cli@0.2.0` 已发布到 npm registry，Trusted Publishing 已关联 GitHub 仓库。
> 若将来在其它账号/环境重新初始化，参考以下步骤：
>
> 1. 在仓库 `cli/` 目录执行 `npm publish`（首次需 npm 账号认证，2FA 时提供验证码 `npm publish --otp=<验证码>`）。
> 2. 在 npm 网站包 Settings 中配置 Trusted Publishing（见下文）。

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

---

## VSCode / Cursor 扩展发布（GitHub Releases 自动化）

VSCode 扩展（`extensions/a2a-vscode`）同样通过 **GitHub Actions** 自动化构建与发布。

### 自动化流程
每次向 GitHub 推送 `v*` tag 时，GitHub Actions（`.github/workflows/release-extension.yml`）会自动运行：
1. 安装依赖并自动同步最新 `cli/a2a.js` 到扩展；
2. 依据当前 Git Tag 自动同步扩展版本号；
3. 执行 `vsce package` 构建出 `a2a-vscode.vsix`；
4. 自动创建 GitHub Release，将 `.vsix` 文件上传到 Release Assets 中；
5. 同时生成 Artifact 供 GitHub 页面直接下载。

### 客户端一键升级体验
用户安装过一次扩展后：
- 每次打开 Cursor / VSCode，扩展会自动检测 GitHub 上的最新版本；
- 检测到新版时，IDE 右下角自动弹窗：**“发现新版本，是否立即自动更新？”**；
- 点击「立即自动更新」，扩展直接后台从 GitHub Release 下载新版 `.vsix` 并静默安装，提示重载窗口即可生效。
- 也可以随时在命令面板运行 `Agent2Agent: 检查扩展更新` 主动检测。
