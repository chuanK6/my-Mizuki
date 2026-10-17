import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { parseEnv } from "node:util";
import { uploadImage, UploadError } from "../lib/admin-r2.mjs";

export function localR2Env(directory = process.cwd()) {
	const env = {};
	for (const file of [".env", ".env.local"]) {
		const target = path.join(directory, file);
		if (fs.existsSync(target)) Object.assign(env, parseEnv(fs.readFileSync(target, "utf8")));
	}
	return { ...env, ...process.env };
}

export async function uploadLocalImage(req) {
	const origin = new URL(`http://${req.headers.host || "localhost"}`);
	if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) throw new UploadError("本地图片上传接口仅限 localhost 访问", 403);
	const request = new Request(new URL(req.url, origin), {
		method: "POST", headers: req.headers, body: Readable.toWeb(req), duplex: "half",
	});
	return uploadImage(request, localR2Env());
}
