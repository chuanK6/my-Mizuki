# Cloudflare 在线管理后台

部署到 Cloudflare Pages 后，需要在项目 Settings -> Variables and Secrets 中配置以下 Secrets：

```text
SESSION_SECRET       至少 32 位随机字符串
GITHUB_TOKEN         具备目标仓库 Contents: Read and write 权限的 Fine-grained token
GITHUB_EDIT_BRANCH   可选，默认 content-draft
```

后台账号固定为 `s0xu`，密码只以 PBKDF2-SHA256 哈希保存在服务端函数中，不会发送到浏览器或以明文提交。Cloudflare Web Crypto 要求 PBKDF2 迭代次数不超过 `100000`，因此自定义哈希也必须使用 `100000` 次。GitHub 仓库默认为 `chuanK6/my-Mizuki` 的 `master` 分支，也可通过 `GITHUB_OWNER`、`GITHUB_REPO`、`GITHUB_BRANCH` 覆盖。GitHub Token 只配置在 Cloudflare Secrets，不能写入前端代码。

部署完成后访问 `/admin/` 登录。保存操作提交到 GitHub 的 `content-draft` 编辑分支，点击“部署更新”后合并到 `master` 并触发 Pages 构建。

Cloudflare Pages 的构建分支必须使用包含 `functions/` 目录的 `master`，构建输出目录仍为 `dist`。如果当前项目绑定的是 GitHub Actions 生成的 `pages` 分支，则 Functions 不会被识别；请在 Cloudflare Pages 设置中改为连接 `master`，或使用 Wrangler 部署 Functions。

后台点击“保存”只提交到 `content-draft`，不会触发 Pages 构建；点击“部署更新”才会将该分支合并到 `master` 并触发部署。关闭浏览器后登录 Cookie 会消失，需要重新登录。

图片统一上传到 R2。线上为 Pages 添加名为 `R2_BUCKET` 的桶绑定，并设置 `R2_PUBLIC_URL`；本地使用 S3 兼容凭据。创建桶、公开域名和配置步骤见 [R2 图片存储](./r2-storage.md)。已有 Cloudinary 图片地址继续保留。
