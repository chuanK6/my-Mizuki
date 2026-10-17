# 后台图片上传到 Cloudflare R2

文章、日记、项目封面和相册共用 `POST /api/admin/upload/`，上传成功后自动填写公开图片地址。已有 Cloudinary 图片继续使用原地址，不需要先迁移。

## 1. 创建桶并开启公开访问

1. 在 Cloudflare 控制台打开 **R2 Object Storage**，创建一个桶，例如 `mizuki-images`。
2. 打开桶的 **Settings**。可先启用 **Public Development URL**，得到 `https://pub-xxx.r2.dev`；正式使用时建议绑定自己的图片域名，例如 `https://images.example.com`。开发域名有速率限制。
3. 保存这个公开地址，后续填写 `R2_PUBLIC_URL`。不要填写带有 `r2.cloudflarestorage.com` 的 S3 API 地址，那不是公开图片地址。

本项目的网站域名是 **`klt.ccwu.cc`**，图片域名是 **`cdn.klt.ccwu.cc`**。网站域名绑定 Cloudflare Pages；只有图片子域名绑定 R2 的 `boke` 桶。把正在使用的网站域名绑定 R2 会改变该域名的路由，导致网站无法正常访问。

公开地址意味着知道图片 URL 的人可以访问原图；相册页面密码不会给 R2 原图增加访问密码。

## 2. 本地后台配置

在 R2 控制台管理 API Token，创建限于该桶的 **Object Read & Write** 凭据。保存生成的 **Access Key ID** 和 **Secret Access Key**。这里使用的是 S3 兼容凭据，不是把 Cloudflare API Token 本身填入密钥字段。

把以下内容补充到项目根目录的 `.env.local`（已被 Git 忽略），不要发到聊天或提交到仓库：

```dotenv
R2_ACCOUNT_ID=Cloudflare账户ID
R2_BUCKET_NAME=boke
R2_ACCESS_KEY_ID=生成的AccessKeyID
R2_SECRET_ACCESS_KEY=生成的SecretAccessKey
R2_PUBLIC_URL=https://cdn.klt.ccwu.cc
```

账户 ID 和 S3 API 地址可在 R2 控制台找到。通常无需填写 `R2_ENDPOINT`；若桶使用特殊地区的地址，把控制台提供的地址填入该变量。

运行 `corepack pnpm dev`，通过 `http://localhost:3000/admin/` 使用后台。本地上传经 `scripts/admin-vite-plugin.mjs` 和 `scripts/local-r2-upload.mjs` 在服务端签名。支持 `.env` 和 `.env.local`，后者优先；进程环境变量的优先级最高。密钥不会传到浏览器。更改环境后重启开发服务器。

## 3. 线上后台配置

在 Cloudflare Pages 项目中：

1. **Settings → Bindings** 添加 R2 Bucket 绑定，变量名必须为 **`R2_BUCKET`**，选择刚创建的桶。
2. 在项目变量中添加 **`R2_PUBLIC_URL=https://cdn.klt.ccwu.cc`**。
3. 部署新的前端和 Functions。绑定修改后也需要重新部署；如需使用预览部署的后台，请为对应环境配置绑定和变量。

线上通过 R2 原生绑定上传，无需设置 S3 Access Key。原有后台登录和 GitHub Secrets 继续保留。Pages 的部署分支须包含 `functions/`，不能只部署没有 Functions 的静态 HTML。

浏览器只请求自己网站的后台接口，通常无需为桶额外配置上传 CORS。

### 从网站域名切换到图片子域名

在 R2 桶的自定义域名中移除 `klt.ccwu.cc`，添加 `cdn.klt.ccwu.cc` 并等待其状态变为 Active；在 Pages 的自定义域名中确认 `klt.ccwu.cc` 已关联网站，DNS 按 Pages 提示恢复。同步更新本地 `.env.local` 和 Pages 对应环境的 `R2_PUBLIC_URL`，然后重新部署线上后台。

桶名、对象路径和密钥无需更换，也不用重新上传图片。若文章或相册已保存旧的 `https://klt.ccwu.cc/boke/...` 图片链接，将这些图片链接的域名改为 `cdn.klt.ccwu.cc`；普通网站链接仍使用 `klt.ccwu.cc`。

## 4. 上传与相册管理

- 支持 JPEG、PNG、GIF、WebP、AVIF，单张最多 10 MB；服务端也会检查大小和图片文件头。
- 对象路径为 `boke/<模块>/<年>/<月>/<随机ID>.<扩展名>`，同名图片不会互相覆盖。
- 文章上传后插入正文；日记和项目上传后自动填写图片地址，随后保存内容。
- 相册选择图片后点击“保存相册”，上传后可设置封面。相册元数据记录 `id`、`key`、`storage: "r2"`、`url`、`name`、`size` 和封面状态。
- 图片上传即时写入 R2；内容保存仍写入编辑分支，点击“部署更新”才发布内容。
- 相册中“移除”只删除图片引用，保留 R2 对象，以免影响尚未部署的旧页面或其他文章引用。永久删除无用对象可在 R2 控制台操作；放弃编辑后未引用的上传文件也可在那里清理。
- R2 只存储原图，不执行 Cloudinary 的自动变换。原图尺寸和格式保持不变。

## 验证

配置完成后，在四个模块各上传一张图片，确认返回地址可以在未登录窗口打开。相册连续上传两张同名图片，检查它们均保留，并验证封面切换。

代码测试无需真实桶：

```bash
node --test tests/admin-r2.test.mjs tests/admin-regressions.test.mjs
corepack pnpm run test:admin-browser
```

缺少配置时，上传接口返回明确的配置提示，不会回退到 Cloudinary。仅完成代码测试不能代替真实桶和域名的联网验证。
