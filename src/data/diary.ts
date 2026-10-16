// 日记数据配置
// 用于管理日记页面的数据

export interface DiaryItem {
	id: number;
	content: string;
	date: string;
	updated?: string;
	images?: string[];
	location?: string;
	mood?: string;
	tags?: string[];
}

// 示例日记数据
const diaryData: DiaryItem[] = [
  {
    "id": 1788063782764,
    "content": "今日清空万里，\n无事发生。",
    "date": "2026-08-18T04:22:00.000Z",
    "location": "淮北市",
    "mood": "一般般",
    "tags": [
      "生活，随笔"
    ],
    "images": [
      "https://kong-springboot1.oss-cn-beijing.aliyuncs.com/21233815-c0e4-4a9c-b6a5-8995717d913e.jpg"
    ]
  },
  {
    "id": 1792132288560,
    "date": "2026-10-15T22:25:00.000Z",
    "content": "“市井人家的炊烟笑语，总是令人心安，这时节的梅隐峰，乍暖还寒……”",
    "location": "安徽",
    "mood": "开心",
    "tags": [
      "生活"
    ],
    "images": [
      "https://img.haowallpaper.com/pre_cache_file/2024_10_27_file/15789130517090624.png"
    ],
    "updated": "2026-10-16T06:31:21.159Z"
  }
];

// 获取日记列表
export const getDiaryList = (limit?: number) => {
	const sortedData = [...diaryData].sort(
		(a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
	);

	if (limit && limit > 0) {
		return sortedData.slice(0, limit);
	}

	return sortedData;
};

// 获取所有标签
export const getAllTags = () => {
	const tags = new Set<string>();
	for (const item of diaryData) {
		if (item.tags) {
			for (const tag of item.tags) {
				tags.add(tag);
			}
		}
	}
	return Array.from(tags).sort();
};
