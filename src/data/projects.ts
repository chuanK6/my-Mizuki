// Project data configuration file
// Used to manage data for the project display page

export interface Project {
	id: string;
	title: string;
	description: string;
	image: string;
	category: "web" | "mobile" | "desktop" | "other";
	techStack: string[];
	status: "completed" | "in-progress" | "planned";
	liveDemo?: string;
	sourceCode?: string;
	visitUrl?: string;
	startDate: string;
	endDate?: string;
	featured?: boolean;
	tags?: string[];
	showImage?: boolean;
}

export const projectsData: Project[] = [
  {
    "id": "mizuki",
    "title": "Mizuki",
    "description": "A next-gen Material Design 3 blog theme built with Astro, featuring i18n, dark mode, and responsive design.",
    "category": "web",
    "status": "completed",
    "startDate": "2026-09-01",
    "endDate": "2026-09-01",
    "techStack": [
      "Astro",
      "TypeScript",
      "Tailwind CSS",
      "Svelte"
    ],
    "tags": [
      "Blog",
      "Theme",
      "Open Source"
    ],
    "image": "/assets/projects/mizuki.webp",
    "visitUrl": "https://mizuki.mysqil.com",
    "sourceCode": "https://github.com/LyraVoid/Mizuki",
    "featured": true,
    "showImage": true
  },
  {
    "id": "my-mizuki",
    "title": "my-mizuki",
    "description": "一个轻量并且复杂的个人博客！",
    "category": "web",
    "status": "completed",
    "startDate": "2026-08-30",
    "techStack": [
      "Astro",
      "TypeScript",
      "Tailwind CSS",
      "Svelte"
    ],
    "tags": [
      "开源，博客"
    ],
    "image": "https://res.cloudinary.com/wmu4lce4/image/upload/v1791202831/boke/b1bmmesctcvjyebonsvb.png",
    "visitUrl": "https://klt.ccwu.cc/",
    "sourceCode": "https://github.com/chuanK6/my-Mizuki",
    "featured": false,
    "showImage": true,
    "updated": "2026-10-05T12:29:03.515Z"
  },
  {
    "id": "game",
    "title": "游浪-游戏网站",
    "description": "简单的游戏资源发布网站",
    "category": "web",
    "status": "completed",
    "startDate": "2026-09-01",
    "techStack": [
      "vue"
    ],
    "tags": [
      "开源"
    ],
    "image": "https://res.cloudinary.com/wmu4lce4/image/upload/v1791203113/boke/x86oqn7vl2vcsfyngfma.png",
    "visitUrl": "https://youlang.cc.cd/",
    "sourceCode": "https://github.com/chuanK6/game",
    "featured": false,
    "showImage": true,
    "updated": "2026-10-05T12:25:59.500Z"
  }
];

// Get project statistics
export const getProjectStats = () => {
	const total = projectsData.length;
	const completed = projectsData.filter((p) => p.status === "completed").length;
	const inProgress = projectsData.filter(
		(p) => p.status === "in-progress",
	).length;
	const planned = projectsData.filter((p) => p.status === "planned").length;

	return {
		total,
		byStatus: {
			completed,
			inProgress,
			planned,
		},
	};
};

// Get projects by category
export const getProjectsByCategory = (category?: string) => {
	if (!category || category === "all") {
		return projectsData;
	}
	return projectsData.filter((p) => p.category === category);
};

// Get featured projects
export const getFeaturedProjects = () => {
	return projectsData.filter((p) => p.featured);
};

// Get all tech stacks
export const getAllTechStack = () => {
	const techSet = new Set<string>();
	projectsData.forEach((project) => {
		project.techStack.forEach((tech) => {
			techSet.add(tech);
		});
	});
	return Array.from(techSet).sort();
};
