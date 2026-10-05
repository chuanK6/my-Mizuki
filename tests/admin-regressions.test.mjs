import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { parse } from "node-html-parser";
import { onRequest } from "../functions/api/admin/[[path]].js";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "local-admin/index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/u)[1];

function editorHarness() {
	const document = parse(html);
	for (const node of document.querySelectorAll("[id]")) {
		node.value = "";
		node.addEventListener = () => {};
		node.dataset = { editorMode: node.getAttribute("data-editor-mode") };
	}
	for (const node of document.querySelectorAll("select")) node.value = "recent";
	let richContent = "";
	const listeners = {};
	const context = vm.createContext({
		$: (id) => document.querySelector(`#${id}`),
		document,
		location: { origin: "https://example.test" },
		escapeHtml: (value) => String(value).replaceAll('"', "&quot;"),
		dateValue: (value) => String(value || "").slice(0, 10),
		editor: {
			on: (name, callback) => { listeners[name] = callback; },
			setMarkdown: (value) => { richContent = value; listeners.change?.(); },
			getMarkdown: () => richContent,
		},
	});
	vm.runInContext(fs.readFileSync(path.join(root, "local-admin/vendor/marked.umd.js"), "utf8"), context);
	vm.runInContext(script.slice(script.indexOf("    // Keep the source authoritative"), script.indexOf("    function fileToBase64")), context);
	return { context, document, editRich(value) { richContent = value; listeners.change(); } };
}

test("admin JavaScript compiles", () => { new vm.Script(script); });

test("all four navigation lists sort by modified date, falling back to publication dates", () => {
	const { context, document } = editorHarness();
	const entries = [
		{ id: "post", published: "2024-04-01", updated: "2026-10-05T12:00:00Z" },
		{ id: "diary", date: "2026-10-04T10:30:00Z" },
		{ id: "project", startDate: "2026-10-03" },
		{ id: "album", date: "2026-10-02", updated: "invalid" },
		{ id: "undated" },
	];
	for (const list of ["post", "diary", "project", "album"]) {
		assert.deepEqual(Array.from(context.sortedItems(entries, list), (item) => item.id), ["post", "diary", "project", "album", "undated"]);
		document.querySelector(`#${list}-sort`).value = "oldest";
		assert.deepEqual(Array.from(context.sortedItems(entries, list), (item) => item.id), ["album", "project", "diary", "post", "undated"]);
	}
	assert.equal(entries[0].id, "post", "sorting must not mutate the API result");
});

test("HTML and mixed Markdown survive edit, preview and save without WYSIWYG conversion", () => {
	const { context, document } = editorHarness();
	const source = '# Hello\n\n<div class="custom" data-note="keep" style="color: red">HTML <span>content</span></div>\n\n<style>.custom { padding: 2rem; }</style>\n';
	context.setArticleContent(source);
	assert.equal(context.getArticleContent(), source);
	assert.equal(document.querySelector("#mode-rich").disabled, true);
	context.setEditorMode("preview");
	assert.match(document.querySelector("#content-preview").srcdoc, /<h1>Hello<\/h1>/u);
	assert.match(document.querySelector("#content-preview").srcdoc, /data-note="keep" style="color: red"/u);
	assert.equal(document.querySelector("#content-preview").getAttribute("sandbox"), "");
	context.setEditorMode("rich");
	assert.equal(context.getArticleContent(), source);
	context.setEditorMode("source");
	document.querySelector("#source-editor").value += "\n<!-- saved exactly -->";
	context.setEditorMode("preview");
	assert.equal(context.getArticleContent(), source + "\n<!-- saved exactly -->");
	context.setArticleContent("Next article");
	assert.equal(context.getArticleContent(), "Next article");
	assert.equal(document.querySelector("#mode-rich").disabled, false);
});

test("Markdown modes retain edits and HTML examples inside code stay editable", () => {
	const { context, document, editRich } = editorHarness();
	const source = "# Heading\n\n```html\n<div>Example</div>\n```\n\nInline `<span>` example.\n";
	context.setArticleContent(source);
	assert.equal(document.querySelector("#mode-rich").disabled, false);
	assert.equal(context.getArticleContent(), source);
	editRich("# Edited\n");
	context.setEditorMode("source");
	assert.equal(document.querySelector("#source-editor").value, "# Edited\n");
	document.querySelector("#source-editor").value = "**Source edit**";
	context.setEditorMode("rich");
	assert.equal(context.getArticleContent(), "**Source edit**");
	assert.equal(context.containsHtml("Text <span style='color:red'>inline HTML</span>"), true);
});

test("online API persists modification dates and exposes article updated dates", async (t) => {
	const files = new Map([
		["src/data/diary.ts", 'const diaryData: DiaryItem[] = [];'],
		["src/data/projects.ts", 'export const projectsData: Project[] = [];'],
		["src/content/posts/example.md", '---\ntitle: Example\npublished: 2024-01-01\nupdated: 2026-10-05\n---\nBody'],
		["public/images/albums/example/info.json", '{"title":"Example","date":"2024-01-01"}'],
	]);
	t.mock.method(globalThis, "fetch", async (url, options = {}) => {
		const endpoint = new URL(url).pathname.replace(/^\/repos\/[^/]+\/[^/]+/u, "");
		if (endpoint.startsWith("/git/ref/heads/")) return Response.json({ object: { sha: "branch-sha" } });
		if (endpoint.startsWith("/git/trees/")) return Response.json({ tree: [{ path: "src/content/posts/example.md", type: "blob", sha: "post-sha" }] });
		assert.ok(endpoint.startsWith("/contents/"), `Unexpected network call: ${endpoint}`);
		const file = decodeURIComponent(endpoint.slice("/contents/".length));
		if (options.method === "PUT") {
			const body = JSON.parse(options.body);
			assert.equal(body.branch, "content-draft");
			files.set(file, Buffer.from(body.content, "base64").toString("utf8"));
			return Response.json({ content: { sha: "saved-sha" } });
		}
		if (!files.has(file)) return new Response("Missing fixture", { status: 404 });
		return Response.json({ sha: "fixture-sha", content: Buffer.from(files.get(file)).toString("base64") });
	});
	const secret = "admin-regression-test-secret";
	const body = Buffer.from(JSON.stringify({ exp: Date.now() + 60000 })).toString("base64url");
	const token = `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
	const call = async (action, payload, method = "POST") => {
		const response = await onRequest({
			params: { path: [action.split("?")[0]] },
			env: { SESSION_SECRET: secret, GITHUB_TOKEN: "fixture-token" },
			request: new Request(`https://example.test/api/admin/${action}`, {
				method,
				headers: { Cookie: `mizuki_admin=${token}`, "Content-Type": "application/json" },
				...(payload ? { body: JSON.stringify(payload) } : {}),
			}),
		});
		const result = await response.json();
		assert.equal(response.status, 200, JSON.stringify(result));
		return result;
	};
	const started = Date.now();
	const diary = await call("diary", { item: { id: 1, content: "Diary", date: "2024-01-01", updated: "2000-01-01" } });
	const project = await call("projects", { item: { id: "project", title: "Project", startDate: "2024-01-01" } });
	const album = await call("albums", { item: { id: "example", title: "Album", date: "2024-01-01" } });
	for (const result of [diary, project, album]) assert.ok(Date.parse(result.item.updated) >= started);
	assert.ok(files.get("src/data/diary.ts").includes(diary.item.updated));
	assert.ok(files.get("src/data/projects.ts").includes(project.item.updated));
	await call("album-image", { albumId: "example", name: "photo", publicId: "photo-id", url: "https://example.test/photo.jpg" });
	assert.ok(Date.parse(JSON.parse(files.get("public/images/albums/example/info.json")).updated) >= started);
	await call("album-image", { albumId: "example", name: "photo" }, "DELETE");
	assert.equal(JSON.parse(files.get("public/images/albums/example/info.json")).images.length, 0);
	assert.equal((await call("posts", null, "GET")).posts[0].updated, "2026-10-05");
	const source = '\n<div data-note="keep" style="color: red">HTML</div>\n\n<style>div { padding: 20px; }</style>\n';
	const post = { id: "round-trip.md", data: { title: "Round trip", published: "2026-10-05" }, content: source };
	await call("post", post);
	const loaded = await call("post?id=round-trip.md", null, "GET");
	assert.equal(loaded.content, source);
	await call("post", { ...post, content: loaded.content });
	assert.equal((await call("post?id=round-trip.md", null, "GET")).content, source);
});

const localPlugin = path.join(root, "scripts/admin-vite-plugin.mjs");
test("local API preserves HTML, records timestamps, and serves editor resources", { skip: !fs.existsSync(localPlugin) }, async () => {
	const cache = path.join(root, "cache");
	fs.mkdirSync(cache, { recursive: true });
	const fixture = fs.mkdtempSync(path.join(cache, "admin-api-fixture-"));
	const originalCwd = process.cwd();
	const write = (name, value) => {
		const file = path.join(fixture, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, value);
	};
	try {
		write("src/data/diary.ts", "const diaryData: DiaryItem[] = [];\n\n// 获取日记列表\n");
		write("src/data/projects.ts", "export const projectsData: Project[] = [];\n\n// Get project statistics\n");
		write("public/images/albums/example/info.json", '{"title":"Example","date":"2024-01-01"}');
		write("local-admin/vendor/fixture.js", "// static resource fixture");
		process.chdir(fixture);
		const { default: createPlugin } = await import(pathToFileURL(localPlugin));
		let handler;
		createPlugin().configureServer({ middlewares: { use(value) { handler = value; } } });
		const call = async (url, body, method = body ? "POST" : "GET") => {
			let result;
			const request = { url, method, async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body); } };
			const response = { statusCode: 200, setHeader() {}, end(value) { result = String(value); } };
			await handler(request, response, () => { throw new Error(`Unhandled route: ${url}`); });
			assert.equal(response.statusCode, 200, result);
			return url.includes("/vendor/") ? result : JSON.parse(result);
		};
		const source = '# Example\n\n<div data-note="keep" style="color: red">HTML</div>\n\n<style>div { padding: 20px; }</style>\n';
		await call("/api/admin/post/", { id: "example.md", data: { title: "Example", published: "2024-01-01", updated: "2026-10-05" }, content: source });
		assert.equal((await call("/api/admin/post/?id=example.md")).content, source);
		assert.equal((await call("/api/admin/posts/")).posts[0].updated.slice(0, 10), "2026-10-05");
		for (const [action, item] of [
			["diary", { id: 1, content: "Example", date: "2024-01-01" }],
			["projects", { id: "example", title: "Example", description: "Example", startDate: "2024-01-01" }],
			["albums", { id: "example", title: "Example", date: "2024-01-01" }],
		]) {
			const started = Date.now();
			await call(`/api/admin/${action}/`, { item });
			const saved = (await call(`/api/admin/${action}/`)).items[0];
			assert.ok(Date.parse(saved.updated) >= started);
		}
		const started = Date.now();
		await call("/api/admin/album-image/", { albumId: "example", publicId: "photo", name: "photo", url: "https://example.test/photo.jpg" });
		assert.ok(Date.parse((await call("/api/admin/albums/")).items[0].updated) >= started);
		await call("/api/admin/album-image/", { albumId: "example", name: "photo" }, "DELETE");
		assert.equal((await call("/api/admin/albums/")).items[0].images.length, 0);
		assert.equal(await call("/admin/vendor/fixture.js"), "// static resource fixture");
	} finally {
		process.chdir(originalCwd);
		assert.equal(path.dirname(path.resolve(fixture)), path.resolve(cache));
		assert.ok(path.basename(fixture).startsWith("admin-api-fixture-"));
		fs.rmSync(fixture, { recursive: true, force: true });
	}
});
