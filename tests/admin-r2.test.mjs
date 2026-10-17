import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { uploadImage, MAX_IMAGE_BYTES, upsertAlbumImage, removeAlbumImage } from "../lib/admin-r2.mjs";
import { uploadLocalImage } from "../scripts/local-r2-upload.mjs";
import { onRequest } from "../functions/api/admin/[[path]].js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");
const publicUrl = "https://images.example.test";
const signedEnv = {
	R2_ACCOUNT_ID: "a".repeat(32), R2_BUCKET_NAME: "blog-images", R2_ACCESS_KEY_ID: "test-access-key",
	R2_SECRET_ACCESS_KEY: "test-secret-key", R2_PUBLIC_URL: publicUrl,
};

function uploadRequest({ scope = "posts", bytes = png, filename = "图片.png", type = "image/png", headers = {} } = {}) {
	const form = new FormData();
	form.append("file", new File([bytes], filename, { type }));
	form.append("scope", scope);
	return new Request("https://blog.example.test/api/admin/upload/", { method: "POST", body: form, headers });
}

test("native R2 upload preserves bytes, assigns unique keys, and returns public URLs for all modules", async () => {
	const writes = [];
	const env = { R2_PUBLIC_URL: publicUrl + "/", R2_BUCKET: { async put(...args) { writes.push(args); } } };
	for (const scope of ["posts", "diary", "projects", "albums"]) {
		const first = await uploadImage(uploadRequest({ scope }), env);
		const second = await uploadImage(uploadRequest({ scope }), env);
		assert.notEqual(first.key, second.key);
		assert.match(first.key, new RegExp(`^boke/${scope}/\\d{4}/\\d{2}/[a-f\\d-]+\\.png$`, "u"));
		assert.equal(first.url, `${publicUrl}/${first.key}`);
		assert.equal(first.id, first.key);
		assert.equal(first.storage, "r2");
		assert.equal(first.name, "图片.png");
		assert.equal(first.size, png.length);
	}
	assert.equal(writes.length, 8);
	assert.deepEqual(Buffer.from(writes[0][1]), png);
	assert.equal(writes[0][2].httpMetadata.contentType, "image/png");
	assert.match(writes[0][2].httpMetadata.cacheControl, /immutable/u);
});

test("S3-compatible uploads are signed on the server, without leaking credentials into the result", async (t) => {
	let captured;
	t.mock.method(globalThis, "fetch", async (input, init) => {
		captured = new Request(input, init);
		return new Response("", { status: 200 });
	});
	const result = await uploadImage(uploadRequest(), signedEnv);
	assert.equal(captured.method, "PUT");
	assert.equal(captured.url, `https://${signedEnv.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/blog-images/${result.key}`);
	assert.match(captured.headers.get("authorization"), /AWS4-HMAC-SHA256 Credential=test-access-key\/\d+\/auto\/s3\/aws4_request/u);
	assert.equal(captured.headers.get("content-type"), "image/png");
	assert.deepEqual(Buffer.from(await captured.arrayBuffer()), png);
	assert.ok(!JSON.stringify(result).includes("test-access-key"));
	assert.ok(!JSON.stringify(result).includes("test-secret-key"));
});

test("upload rejects missing configuration, oversized bodies, forged file types and cross-site requests", async () => {
	let writes = 0;
	const env = { R2_PUBLIC_URL: publicUrl, R2_BUCKET: { async put() { writes++; } } };
	await assert.rejects(uploadImage(uploadRequest(), {}), { status: 503 });
	await assert.rejects(uploadImage(uploadRequest(), { R2_PUBLIC_URL: publicUrl }), { status: 503 });
	await assert.rejects(uploadImage(uploadRequest(), { ...env, R2_PUBLIC_URL: `https://${signedEnv.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` }), { status: 503 });
	await assert.rejects(uploadImage(uploadRequest({ bytes: Buffer.from('<svg onload="alert(1)"></svg>') }), env), { status: 415 });
	await assert.rejects(uploadImage(uploadRequest({ bytes: new Uint8Array() }), env), { status: 400 });
	await assert.rejects(uploadImage(uploadRequest({ scope: "../../another-bucket" }), env), { status: 400 });
	await assert.rejects(uploadImage(uploadRequest({ bytes: new Uint8Array(MAX_IMAGE_BYTES + 1) }), env), { status: 413 });
	await assert.rejects(uploadImage(uploadRequest({ headers: { "content-length": String(MAX_IMAGE_BYTES + 100000) } }), env), { status: 413 });
	await assert.rejects(uploadImage(uploadRequest({ headers: { origin: "https://unrelated.example.test" } }), env), { status: 403 });
	assert.equal(writes, 0);
});

test("R2 errors have actionable messages without exposing provider credentials", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response("provider debug information", { status: 403 }));
	await assert.rejects(uploadImage(uploadRequest(), signedEnv), (error) => error.status === 502 && error.message.includes("HTTP 403") && !error.message.includes("test-secret-key"));
	await assert.rejects(uploadImage(uploadRequest(), { R2_PUBLIC_URL: publicUrl, R2_BUCKET: { put() { throw new Error("internal credential details"); } } }), { status: 502, message: "R2 上传失败，请检查存储绑定、网络和访问权限" });
});

test("online upload requires a valid admin session before accepting files", async () => {
	let writes = 0;
	const env = { SESSION_SECRET: "upload-test-session-secret", R2_PUBLIC_URL: publicUrl, R2_BUCKET: { async put() { writes++; } } };
	const invoke = (request) => onRequest({ request, env, params: { path: ["upload"] } });
	assert.equal((await invoke(uploadRequest())).status, 401);
	assert.equal(writes, 0);
	const body = Buffer.from(JSON.stringify({ exp: Date.now() + 60000 })).toString("base64url");
	const signature = createHmac("sha256", env.SESSION_SECRET).update(body).digest("base64url");
	const response = await invoke(uploadRequest({ headers: { Cookie: `mizuki_admin=${body}.${signature}` } }));
	assert.equal(response.status, 200);
	assert.equal((await response.json()).storage, "r2");
	assert.equal(writes, 1);
});

test("album uploads keep multiple same-name R2 images and legacy URLs; cover and removal use identity", () => {
	const legacy = { id: "legacy", publicId: "old-public-id", name: "photo.png", url: "https://res.cloudinary.com/demo/image/upload/old.png" };
	const info = { images: [legacy] };
	const first = { key: "boke/albums/2026/10/one.png", url: `${publicUrl}/one.png`, name: "photo.png", size: 68 };
	const second = { key: "boke/albums/2026/10/two.png", url: `${publicUrl}/two.png`, name: "photo.png", size: 69 };
	upsertAlbumImage(info, first);
	upsertAlbumImage(info, second);
	assert.equal(info.images.length, 3);
	assert.deepEqual(info.images[0], legacy);
	upsertAlbumImage(info, { ...second, cover: true });
	assert.equal(info.images.length, 3);
	assert.equal(info.cover, second.url);
	assert.equal(info.images[2].storage, "r2");
	assert.equal(info.images[2].size, 69);
	removeAlbumImage(info, second.key);
	assert.equal(info.images.length, 2);
	assert.equal(info.images[1].key, first.key);
	assert.equal(info.cover, undefined);
	assert.equal(info.images[0].url, legacy.url);
});

test("local adapter reads .env.local and forwards the multipart body to signed R2 upload", async (t) => {
	const root = path.resolve(import.meta.dirname, "..");
	const cache = path.join(root, "cache");
	fs.mkdirSync(cache, { recursive: true });
	const fixture = fs.mkdtempSync(path.join(cache, "r2-config-test-"));
	const originalCwd = process.cwd();
	try {
		fs.writeFileSync(path.join(fixture, ".env.local"), Object.entries(signedEnv).map(([key, value]) => `${key}=${value}`).join("\n"));
		t.mock.method(globalThis, "fetch", async (input, init) => {
			const request = new Request(input, init);
			assert.match(request.headers.get("authorization"), /AWS4-HMAC-SHA256/u);
			return new Response("", { status: 200 });
		});
		const form = uploadRequest({ scope: "diary" });
		const req = Readable.from([Buffer.from(await form.arrayBuffer())]);
		req.headers = { ...Object.fromEntries(form.headers), host: "localhost:3000", origin: "http://localhost:3000" };
		req.url = "/api/admin/upload/";
		process.chdir(fixture);
		const result = await uploadLocalImage(req);
		assert.equal(result.storage, "r2");
		assert.match(result.url, /\/boke\/diary\//u);
	} finally {
		process.chdir(originalCwd);
		assert.equal(path.dirname(path.resolve(fixture)), path.resolve(cache));
		assert.ok(path.basename(fixture).startsWith("r2-config-test-"));
		fs.rmSync(fixture, { recursive: true, force: true });
	}
});
