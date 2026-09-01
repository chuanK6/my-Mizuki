import * as fs from "node:fs";
import * as path from "node:path";

import type { AlbumGroup, Photo } from "../types/album";

export async function scanAlbums(): Promise<AlbumGroup[]> {
	const albumsDir = path.join(process.cwd(), "public/images/albums");
	const albums: AlbumGroup[] = [];

	// 检查目录是否存在
	if (!fs.existsSync(albumsDir)) {
		console.warn("相册目录不存在:", albumsDir);
		return [];
	}

	// 获取所有子文件夹
	const albumFolders = fs
		.readdirSync(albumsDir, { withFileTypes: true })
		.filter((dirent) => dirent.isDirectory())
		.map((dirent) => dirent.name);

	// 处理每个相册文件夹
	for (const folder of albumFolders) {
		const albumPath = path.join(albumsDir, folder);
		const album = await processAlbumFolder(albumPath, folder);
		if (album) {
			albums.push(album);
		}
	}

	return albums;
}

async function processAlbumFolder(
	folderPath: string,
	folderName: string,
): Promise<AlbumGroup | null> {
	// 检查必要文件
	const infoPath = path.join(folderPath, "info.json");

	if (!fs.existsSync(infoPath)) {
		console.warn(`相册 ${folderName} 缺少 info.json 文件`);
		return null;
	}

	// 读取相册信息
	const infoContent = fs.readFileSync(infoPath, "utf-8");
	interface AlbumInfo {
		mode?: string;
		cover?: string;
		photos?: Record<string, unknown>[];
		hidden?: boolean;
		title?: string;
		description?: string;
		date?: string;
		location?: string;
		tags?: string[];
		password?: string;
		passwordHint?: string;
		images?: {
			id?: string;
			url: string;
			name?: string;
			alt?: string;
			title?: string;
			publicId?: string;
			cover?: boolean;
			date?: string;
		}[];
	}
	let info: AlbumInfo;
	try {
		info = JSON.parse(infoContent);
	} catch (e) {
		console.error(`相册 ${folderName} 的 info.json 格式错误:`, e);
		return null;
	}

	// 检查是否为外链模式
	const isExternalMode = info.mode === "external";
	let photos: Photo[] = [];
	let cover: string;

	if (isExternalMode) {
		// 外链模式：从 info.json 中获取封面和照片
		if (!info.cover) {
			console.warn(`相册 ${folderName} 外链模式缺少 cover 字段`);
			return null;
		}

		cover = info.cover as string;
		photos = processExternalPhotos(
			(info.photos ?? []) as Parameters<typeof processExternalPhotos>[0],
			folderName,
		);
	} else {
		// 本地模式：检查本地文件
		const imageNames = fs
			.readdirSync(folderPath)
			.filter((file) => /\.(?:jpg|jpeg|png|gif|webp|avif|bmp|tiff|tif|svg)$/iu.test(file));
		const conventionalCover = imageNames.find((file) => /^cover\.(?:jpg|jpeg|png|gif|webp|avif|bmp|tiff|tif|svg)$/iu.test(file));
		let coverPath = conventionalCover ? path.join(folderPath, conventionalCover) : "";
		if (!coverPath) {
				// If no conventional cover exists, use the first local photo as cover.
				// This keeps albums created by the local admin usable without requiring
				// users to rename one of their photos to cover.jpg.
				const firstPhoto = imageNames.find((file) => !/^cover\./iu.test(file));
				if (!firstPhoto) {
					console.warn(`相册 ${folderName} 暂无本地图片，将使用默认封面`);
					coverPath = "";
				}
				if (firstPhoto) coverPath = path.join(folderPath, firstPhoto);
			}

		cover = coverPath
			? `/images/albums/${folderName}/${path.basename(coverPath)}`
			: "";
		photos = scanPhotos(folderPath, folderName);
		if (Array.isArray(info.images)) {
			photos.push(
				...processExternalPhotos(
					info.images.map((image) => ({
						src: image.url,
						id: image.id || image.publicId,
						alt: image.alt || image.name,
						title: image.title || image.name,
						date: image.date,
					})),
					folderName,
				),
			);
		}
		if (info.cover && /^https?:\/\//iu.test(info.cover)) cover = info.cover;
		else if (!cover && info.images?.[0]?.url) cover = info.images[0].url;
	}

	// 检查是否隐藏相册
	if (info.hidden === true) {
		console.log(`相册 ${folderName} 已设置为隐藏，跳过显示`);
		return null;
	}

	// 构建相册对象
	return {
		id: folderName,
		title: info.title || folderName,
		description: info.description || "",
		cover,
		date: info.date || new Date().toISOString().split("T")[0],
		location: info.location || "",
		tags: info.tags || [],
		photos,
		password: info.password || undefined,
		passwordHint: info.passwordHint || undefined,
	};
}

function scanPhotos(folderPath: string, albumId: string): Photo[] {
	const photos: Photo[] = [];
	const files = fs.readdirSync(folderPath);

	const imageExtensions = [
		".jpg",
		".jpeg",
		".png",
		".gif",
		".webp",
		".svg",
		".avif",
		".bmp",
		".tiff",
		".tif",
	];

	const imageFiles = files.filter((file) => {
		const ext = path.extname(file).toLowerCase();
		return (
			imageExtensions.includes(ext) &&
			!/^cover\./iu.test(file)
		);
	});

	const fileWebpMap = new Map<string, string>();
	for (const file of imageFiles) {
		const baseName = path.basename(file, path.extname(file));
		const ext = path.extname(file).toLowerCase();
		if (ext === ".jpg" || ext === ".jpeg" || ext === ".png") {
			if (imageFiles.includes(`${baseName}.webp`)) {
				fileWebpMap.set(file, `${baseName}.webp`);
			}
		}
	}

	imageFiles.forEach((file, index) => {
		const filePath = path.join(folderPath, file);
		const stats = fs.statSync(filePath);

		const { baseName, tags } = parseFileName(file);

		const src = fileWebpMap.has(file)
			? `/images/albums/${albumId}/${fileWebpMap.get(file)}`
			: `/images/albums/${albumId}/${file}`;

		photos.push({
			id: `${albumId}-photo-${index}`,
			src,
			alt: baseName,
			title: baseName,
			tags: tags,
			date: stats.mtime.toISOString().split("T")[0],
		});
	});

	return photos;
}

function processExternalPhotos(
	externalPhotos: {
		src: string;
		id?: string;
		thumbnail?: string;
		alt?: string;
		title?: string;
		description?: string;
		tags?: string[];
		date?: string;
		location?: string;
		width?: number;
		height?: number;
	}[],
	albumId: string,
): Photo[] {
	const photos: Photo[] = [];

	externalPhotos.forEach((photo, index) => {
		if (!photo.src) {
			console.warn(`相册 ${albumId} 的第 ${index + 1} 张照片缺少 src 字段`);
			return;
		}

		photos.push({
			id: photo.id || `${albumId}-external-photo-${index}`,
			src: photo.src,
			thumbnail: photo.thumbnail,
			alt: photo.alt || photo.title || `Photo ${index + 1}`,
			title: photo.title,
			description: photo.description,
			tags: photo.tags || [],
			date: photo.date || new Date().toISOString().split("T")[0],
			location: photo.location,
			width: photo.width,
			height: photo.height,
			// camera: photo.camera,
			// lens: photo.lens,
			// settings: photo.settings,
		});
	});

	return photos;
}

function parseFileName(fileName: string): { baseName: string; tags: string[] } {
	// 匹配文件名中的标签，格式为：文件名_标签1_标签2.扩展名
	const parts = path.basename(fileName, path.extname(fileName)).split("_");

	if (parts.length >= 3) {
		// 前 N-2 部分作为基本名称，最后 2 部分作为标签
		const baseName = parts.slice(0, -2).join("_");
		const tags = parts.slice(-2);
		return { baseName, tags };
	}

	if (parts.length === 2) {
		// 第一部分作为基本名称，第二部分作为标签
		return { baseName: parts[0], tags: [parts[1]] };
	}

	// 如果没有标签，返回不带扩展名的文件名
	const baseName = path.basename(fileName, path.extname(fileName));
	return { baseName, tags: [] };
}
