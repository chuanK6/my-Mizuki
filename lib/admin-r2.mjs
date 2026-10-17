import { AwsClient } from "aws4fetch";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + 64 * 1024;
const scopes = new Set(["posts", "diary", "projects", "albums"]);
const cacheControl = "public, max-age=31536000, immutable";

export class UploadError extends Error {
	constructor(message, status = 400) { super(message); this.status = status; }
}

export function publicImageBase(env) {
	let url;
	try { url = new URL(String(env.R2_PUBLIC_URL || "")); } catch {
		throw new UploadError("请先配置 R2_PUBLIC_URL（R2 图片公开访问域名）", 503);
	}
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
		throw new UploadError("R2_PUBLIC_URL 必须是 HTTPS 图片域名，不包含账号、查询参数或片段", 503);
	}
	if (url.hostname.endsWith(".r2.cloudflarestorage.com")) {
		throw new UploadError("R2_PUBLIC_URL 请填写公开域名或 r2.dev 地址，不能使用 S3 API 地址", 503);
	}
	return url.href.replace(/\/+$/u, "");
}

function s3Config(env) {
	const names = ["R2_ACCOUNT_ID", "R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
	const missing = names.filter((name) => !String(env[name] || "").trim());
	if (missing.length) throw new UploadError(`R2 尚未配置：${missing.join("、")}`, 503);
	if (!/^[a-f\d]{32}$/iu.test(env.R2_ACCOUNT_ID) || !/^[a-z\d][a-z\d.-]{1,61}[a-z\d]$/u.test(env.R2_BUCKET_NAME)) {
		throw new UploadError("R2_ACCOUNT_ID 或 R2_BUCKET_NAME 格式不正确", 503);
	}
	const endpoint = new URL(env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
	const hosts = ["", ".eu", ".fedramp"].map((region) => `${env.R2_ACCOUNT_ID}${region}.r2.cloudflarestorage.com`);
	if (endpoint.protocol !== "https:" || !hosts.includes(endpoint.hostname) || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
		throw new UploadError("R2_ENDPOINT 必须是此账户的 R2 S3 API 地址", 503);
	}
	return {
		base: `${endpoint.origin}/${env.R2_BUCKET_NAME}`,
		client: new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto", retries: 2 }),
	};
}

async function readForm(request) {
	if (!request.headers.get("content-type")?.startsWith("multipart/form-data;")) throw new UploadError("请使用表单上传图片");
	if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES) throw new UploadError("单张图片不能超过 10 MB", 413);
	if (!request.body) throw new UploadError("请选择要上传的图片");
	const reader = request.body.getReader();
	const chunks = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_REQUEST_BYTES) {
				await reader.cancel();
				throw new UploadError("单张图片不能超过 10 MB", 413);
			}
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	try {
		return await new Response(new Blob(chunks), { headers: { "content-type": request.headers.get("content-type") } }).formData();
	} catch { throw new UploadError("图片上传表单格式错误"); }
}

function imageType(bytes) {
	const starts = (...signature) => signature.every((byte, index) => bytes[index] === byte);
	const text = (start, end) => new TextDecoder().decode(bytes.slice(start, end));
	if (starts(0xff, 0xd8, 0xff)) return { mime: "image/jpeg", ext: "jpg" };
	if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { mime: "image/png", ext: "png" };
	if (["GIF87a", "GIF89a"].includes(text(0, 6))) return { mime: "image/gif", ext: "gif" };
	if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
	if (text(4, 8) === "ftyp") {
		const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
		if (boxSize >= 16 && boxSize <= bytes.length) {
			for (let offset = 8; offset + 4 <= Math.min(boxSize, 256); offset += 4) {
				if (offset !== 12 && ["avif", "avis"].includes(text(offset, offset + 4))) return { mime: "image/avif", ext: "avif" };
			}
		}
	}
	throw new UploadError("仅支持 JPEG、PNG、GIF、WebP、AVIF 图片", 415);
}

export async function uploadImage(request, env) {
	const origin = request.headers.get("origin");
	if (origin && origin !== new URL(request.url).origin) throw new UploadError("不允许跨站上传图片", 403);
	const base = publicImageBase(env);
	const binding = env.R2_BUCKET && typeof env.R2_BUCKET.put === "function" ? env.R2_BUCKET : null;
	const s3 = binding ? null : s3Config(env);
	const form = await readForm(request);
	const scope = String(form.get("scope") || "posts");
	if (!scopes.has(scope)) throw new UploadError("图片所属模块无效");
	const file = form.get("file");
	if (!file || typeof file.arrayBuffer !== "function" || !file.size) throw new UploadError("请选择非空的图片文件");
	if (file.size > MAX_IMAGE_BYTES) throw new UploadError("单张图片不能超过 10 MB", 413);
	const bytes = new Uint8Array(await file.arrayBuffer());
	const { mime, ext } = imageType(bytes);
	const createdAt = new Date().toISOString();
	const key = `boke/${scope}/${createdAt.slice(0, 7).replace("-", "/")}/${crypto.randomUUID()}.${ext}`;
	const name = String(file.name || `image.${ext}`).split(/[\\/]/u).pop().replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 180) || `image.${ext}`;
	try {
		if (binding) {
			await binding.put(key, bytes, { httpMetadata: { contentType: mime, cacheControl }, customMetadata: { scope } });
		} else {
			const response = await s3.client.fetch(`${s3.base}/${key}`, {
				method: "PUT", body: bytes,
				headers: { "content-type": mime, "cache-control": cacheControl, "x-amz-meta-scope": scope },
				signal: AbortSignal.timeout(60000),
			});
			if (!response.ok) throw new UploadError(`R2 上传失败（HTTP ${response.status}），请检查桶名和对象读写权限`, 502);
		}
	} catch (error) {
		if (error instanceof UploadError) throw error;
		throw new UploadError("R2 上传失败，请检查存储绑定、网络和访问权限", 502);
	}
	return { storage: "r2", key, id: key, url: `${base}/${key}`, name, size: bytes.byteLength, mime, createdAt };
}

// Retain legacy Cloudinary metadata on existing images; new images use key/storage.
export function albumImageMatches(image, value) {
	return [image.id, image.key, image.publicId, image.url, image.name].some((field) => field && field === value);
}

export function upsertAlbumImage(info, body) {
	const url = String(body.url || "").trim();
	if (!/^https?:\/\//iu.test(url) && !url.startsWith("/images/albums/")) throw new UploadError("图片地址无效");
	const images = Array.isArray(info.images) ? info.images : [];
	const id = String(body.key || body.id || body.publicId || url);
	const index = images.findIndex((image) => albumImageMatches(image, id) || image.url === url);
	const previous = index >= 0 ? images[index] : {};
	const image = {
		...previous, id, url, name: String(body.name || previous.name || "image"),
		...(body.key ? { key: String(body.key), storage: "r2" } : {}),
		...(body.publicId ? { publicId: String(body.publicId) } : {}),
		...(body.size ? { size: Number(body.size) } : {}),
		cover: body.cover === true || previous.cover === true,
	};
	if (body.cover === true) { for (const old of images) old.cover = false; info.cover = url; }
	if (index >= 0) images[index] = image; else images.push(image);
	info.images = images;
	info.updated = new Date().toISOString();
	return image;
}

export function removeAlbumImage(info, identifier) {
	const images = Array.isArray(info.images) ? info.images : [];
	const removed = images.find((image) => albumImageMatches(image, identifier));
	if (!removed) throw new UploadError("图片不存在");
	info.images = images.filter((image) => image !== removed);
	if (removed.cover || info.cover === removed.url) delete info.cover;
	info.updated = new Date().toISOString();
	// Published pages and other posts may still reference the object, so only remove the album reference.
	return removed;
}
