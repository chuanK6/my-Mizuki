const encoder = new TextEncoder();
const DEFAULT_ADMIN_USERNAME = "s0xu";
const DEFAULT_ADMIN_PASSWORD_HASH = "pbkdf2$100000$C7swkKIj2URzTxVRlCFa+w==$L3mbpyVRwv3qoHBaupAMV7URl9fioA1HhyE+fEGPCRU=";

function json(data, status = 200, headers = {}) {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

function envValue(env, name) {
	const value = env?.[name];
	if (!value) throw new Error(`缺少 Cloudflare Secret: ${name}`);
	return value;
}

function configuredValue(env, name, fallback) {
	return env?.[name] || fallback;
}

function base64(bytes) {
	let text = "";
	for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(text);
}

function fromBase64(value) {
	const text = atob(value.replace(/\s/g, ""));
	const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

function timingSafeEqual(a, b) {
	if (a.length !== b.length) return false;
	let result = 0;
	for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return result === 0;
}

async function digest(value) {
	return base64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function verifyPassword(password, encoded) {
	const [kind, iterationsText, saltText, expected] = String(encoded || "").split("$");
	if (kind !== "pbkdf2" || !iterationsText || !saltText || !expected) return false;
	const iterations = Number(iterationsText);
	if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 100000) return false;
	const salt = Uint8Array.from(atob(saltText), (char) => char.charCodeAt(0));
	const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
	return timingSafeEqual(base64(new Uint8Array(bits)), expected);
}

async function signSession(payload, secret) {
	const body = base64(encoder.encode(JSON.stringify({ ...payload, exp: Date.now() + 86_400_000 }))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signature = base64(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
	return `${body}.${signature}`;
}

async function verifySignature(body, signature, secret) {
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
	const normalized = signature.replaceAll("-", "+").replaceAll("_", "/") + "==";
	const bytes = Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
	return crypto.subtle.verify("HMAC", key, bytes, encoder.encode(body));
}

async function validSession(request, env) {
	const token = request.headers.get("Cookie")?.match(/(?:^|;\s*)mizuki_admin=([^;]+)/)?.[1];
	if (!token) return false;
	const [body, signature] = token.split(".");
	if (!body || !signature) return false;
	try {
		const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.replaceAll("-", "+").replaceAll("_", "/") + "=="), (c) => c.charCodeAt(0))));
		return decoded.exp > Date.now() && await verifySignature(body, signature, envValue(env, "SESSION_SECRET"));
	} catch {
		return false;
	}
}

function githubConfig(env) {
	return { token: envValue(env, "GITHUB_TOKEN"), owner: env.GITHUB_OWNER || "chuanK6", repo: env.GITHUB_REPO || "my-Mizuki", branch: env.GITHUB_BRANCH || "master" };
}

async function githubRequest(env, endpoint, options = {}) {
	const config = githubConfig(env);
	const response = await fetch(`https://api.github.com/repos/${config.owner}/${config.repo}${endpoint}`, { ...options, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${config.token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "mizuki-pages-admin", ...options.headers } });
	if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
	return response.status === 204 ? null : response.json();
}

async function readFile(env, filePath) {
	const config = githubConfig(env);
	const result = await githubRequest(env, `/contents/${filePath}?ref=${encodeURIComponent(config.branch)}`);
	return { sha: result.sha, content: fromBase64(result.content) };
}

async function commitFile(env, filePath, content, message, sha) {
	const config = githubConfig(env);
	const current = sha ? { sha } : await readFile(env, filePath).catch(() => null);
	return githubRequest(env, `/contents/${filePath}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: message || `在线更新 ${filePath}`, content: base64(encoder.encode(content)), branch: config.branch, ...(current?.sha ? { sha: current.sha } : {}) }) });
}

async function deleteFile(env, filePath, message) {
	const config = githubConfig(env);
	const current = await readFile(env, filePath);
	return githubRequest(env, `/contents/${filePath}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: message || `在线删除 ${filePath}`, sha: current.sha, branch: config.branch }) });
}

function safePath(value) {
	const path = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
	if (!path || path.includes("..") || !/^[\w./-]+$/u.test(path)) throw new Error("文件路径无效");
	return path;
}

function contentPath(value) {
	const path = safePath(value);
	const allowed = path.startsWith("src/content/posts/") || path === "src/data/diary.ts" || path === "src/data/projects.ts" || /^public\/images\/albums\/[^/]+\/info\.json$/u.test(path);
	if (!allowed) throw new Error("后台只允许修改文章、日记、项目和相册数据");
	return path;
}

async function listPosts(env) {
	const config = githubConfig(env);
	const tree = await githubRequest(env, `/git/trees/${encodeURIComponent(config.branch)}?recursive=1`);
	return (tree.tree || []).filter((entry) => entry.type === "blob" && /^src\/content\/posts\/.*\.(?:md|mdx)$/u.test(entry.path)).map((entry) => ({ id: entry.path.slice("src/content/posts/".length), sha: entry.sha }));
}

export async function onRequest(context) {
	const { request, env, params } = context;
	const action = Array.isArray(params.path) ? params.path.join("/") : String(params.path || "");
	try {
		if (request.method === "POST" && action === "login") {
			const body = await request.json();
			if (String(body.username || "") !== configuredValue(env, "ADMIN_USERNAME", DEFAULT_ADMIN_USERNAME) || !(await verifyPassword(String(body.password || ""), configuredValue(env, "ADMIN_PASSWORD_HASH", DEFAULT_ADMIN_PASSWORD_HASH)))) return json({ error: "账号或密码错误" }, 401);
			const token = await signSession({ sub: body.username }, envValue(env, "SESSION_SECRET"));
			return json({ ok: true }, 200, { "set-cookie": `mizuki_admin=${token}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict` });
		}
		if (action === "logout") return json({ ok: true }, 200, { "set-cookie": "mizuki_admin=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict" });
		if (action === "session") return json({ authenticated: await validSession(request, env) });
		if (!(await validSession(request, env))) return json({ error: "未登录" }, 401);
		if (request.method === "GET" && action === "posts") return json({ posts: await listPosts(env) });
		if (request.method === "GET" && action === "albums") {
			const config = githubConfig(env);
			const result = await githubRequest(env, `/contents/public/images/albums?ref=${encodeURIComponent(config.branch)}`);
			return json({ albums: (result || []).filter((entry) => entry.type === "dir").map((entry) => ({ id: entry.name, path: `public/images/albums/${entry.name}/info.json` })) });
		}
		if (request.method === "GET" && action === "file") {
			const path = contentPath(new URL(request.url).searchParams.get("path"));
			return json({ path, ...(await readFile(env, path)) });
		}
		if (request.method === "POST" && action === "file") {
			const body = await request.json();
			const path = contentPath(body.path);
			if (typeof body.content !== "string" || body.content.length > 2_000_000) return json({ error: "内容无效或过大" }, 400);
			return json({ ok: true, result: await commitFile(env, path, body.content, body.message, body.sha) });
		}
		if (request.method === "DELETE" && action === "file") {
			const body = await request.json();
			return json({ ok: true, result: await deleteFile(env, contentPath(body.path), body.message) });
		}
		return json({ error: "接口不存在" }, 404);
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : "操作失败" }, 400);
	}
}
