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
    "image": "https://res.cloudinary.com/wmu4lce4/image/upload/v1788249252/boke/jrhur1qn1xu4cbjx3qg7.png",
    "visitUrl": "https://01.klt.ccwu.cc/",
    "sourceCode": "",
    "featured": false,
    "showImage": true
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
