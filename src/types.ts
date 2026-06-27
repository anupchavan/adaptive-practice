export type FilterOperator =
	| "contains" | "does not contain"
	| "contains any of" | "does not contain any of"
	| "contains all of" | "does not contain all of"
	| "is" | "is not"
	| "starts with" | "ends with"
	| "is empty" | "is not empty"
	| "links to" | "does not link to"
	| "in folder" | "is not in folder"
	| "has tag" | "does not have tag"
	| "has property" | "does not have property"
	| "on" | "not on"
	| "before" | "on or before"
	| "after" | "on or after";

export type FilterConjunction = "AND" | "OR" | "NOR";

export interface Filter {
	type: "filter";
	field: string;
	operator: FilterOperator;
	value?: string;
}

export interface FilterGroup {
	type: "group";
	operator: FilterConjunction;
	conditions: (Filter | FilterGroup)[];
}

export const DEFAULT_FILTER_RULES: FilterGroup = {
	type: "group",
	operator: "AND",
	conditions: [],
};

export const DEFAULT_CREATED_DATE_PROPERTIES = "created, created_at, createdAt, date created";
export const DEFAULT_UPDATED_DATE_PROPERTIES = "updated, modified, updated_at, updatedAt, last updated";

export type LlmProvider =
	| "gemini"
	| "anthropic"
	| "openai"
	| "deepseek"
	| "qwen"
	| "openrouter"
	| "openai-compatible";

export const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = {
	gemini: "Gemini",
	anthropic: "Anthropic",
	openai: "OpenAI",
	deepseek: "DeepSeek",
	qwen: "Qwen",
	openrouter: "OpenRouter",
	"openai-compatible": "OpenAI-compatible",
};

export const OPENAI_COMPATIBLE_PROVIDERS: LlmProvider[] = [
	"openai",
	"deepseek",
	"qwen",
	"openrouter",
	"openai-compatible",
];

export interface ProviderPreset {
	baseUrl: string;
	model: string;
	secretName: string;
	jsonMode: "json_schema" | "json_object" | "prompt_only";
	supportsImages: boolean;
	supportsPdfs: boolean;
}

export const PROVIDER_PRESETS: Record<LlmProvider, ProviderPreset> = {
	gemini: {
		baseUrl: "",
		model: "gemini-3.5-flash",
		secretName: "gemini-api-key",
		jsonMode: "prompt_only",
		supportsImages: true,
		supportsPdfs: true,
	},
	anthropic: {
		baseUrl: "https://api.anthropic.com/v1/messages",
		model: "claude-sonnet-4-6",
		secretName: "anthropic-api-key",
		jsonMode: "prompt_only",
		supportsImages: true,
		supportsPdfs: true,
	},
	openai: {
		baseUrl: "https://api.openai.com/v1/responses",
		model: "gpt-5.5",
		secretName: "openai-api-key",
		jsonMode: "json_schema",
		supportsImages: true,
		supportsPdfs: false,
	},
	deepseek: {
		baseUrl: "https://api.deepseek.com/chat/completions",
		model: "deepseek-v4-flash",
		secretName: "deepseek-api-key",
		jsonMode: "json_object",
		supportsImages: false,
		supportsPdfs: false,
	},
	qwen: {
		baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
		model: "qwen-plus",
		secretName: "qwen-api-key",
		jsonMode: "json_object",
		supportsImages: false,
		supportsPdfs: false,
	},
	openrouter: {
		baseUrl: "https://openrouter.ai/api/v1/chat/completions",
		model: "openai/gpt-5.4-mini",
		secretName: "openrouter-api-key",
		jsonMode: "json_schema",
		supportsImages: true,
		supportsPdfs: false,
	},
	"openai-compatible": {
		baseUrl: "http://localhost:1234/v1/chat/completions",
		model: "",
		secretName: "openai-compatible-api-key",
		jsonMode: "json_object",
		supportsImages: false,
		supportsPdfs: false,
	},
};

export interface AdaptivePracticeSettings {
	geminiApiKey: string;
	llmProvider: LlmProvider;
	secretName: string;
	providerSecretNames: Partial<Record<LlmProvider, string>>;
	providerBaseUrls: Partial<Record<LlmProvider, string>>;
	providerModels: Partial<Record<LlmProvider, string>>;
	providerJsonModes: Partial<Record<LlmProvider, ProviderPreset["jsonMode"]>>;
	providerSupportsImages: Partial<Record<LlmProvider, boolean>>;
	practiceFolder: string;
	createdDateProperties: string;
	updatedDateProperties: string;
	filterRules: FilterGroup;
	defaultQuestionCount: number;
	questionPaneSide: "left" | "right";
	dashboardOpen: boolean;
	dailyPracticeEnabled: boolean;
	dailyReminderTime: string;
	dailyQuestionCount: number;
	dailyTopicLimit: number;
	pdfSkills: Record<string, number>;
	practiceMemory: PracticeMemory;
	practiceDraft: PracticeDraft | null;
}

export interface DailyPracticeState {
	lastReminderDate: string;
	lastReminderAttemptAt: number;
	lastPracticeDate: string;
	streak: number;
	lastScanAt: number;
}

export interface SubtopicPracticeState {
	lastPracticedAt: number;
	attempts: number;
	correct: number;
}

export interface NotePracticeState {
	path: string;
	title: string;
	skill: number;
	createdAt: number;
	updatedAt: number;
	lastPracticedAt: number;
	dueAt: number;
	attempts: number;
	correct: number;
	skipped: number;
	correctStreak: number;
	stabilityDays: number;
	averageTimeMs: number;
	lastSessionAccuracy: number;
	lastSessionFluency: number;
	practicedSubtopics: Record<string, SubtopicPracticeState>;
}

export interface PracticeMemory {
	version: 1;
	notes: Record<string, NotePracticeState>;
	index: Record<string, NoteIndexEntry>;
	daily: DailyPracticeState;
}

export const DEFAULT_PRACTICE_MEMORY: PracticeMemory = {
	version: 1,
	notes: {},
	index: {},
	daily: {
		lastReminderDate: "",
		lastReminderAttemptAt: 0,
		lastPracticeDate: "",
		streak: 0,
		lastScanAt: 0,
	},
};

export const DEFAULT_SETTINGS: AdaptivePracticeSettings = {
	geminiApiKey: "",
	llmProvider: "gemini",
	secretName: "gemini-api-key",
	providerSecretNames: {},
	providerBaseUrls: {},
	providerModels: {},
	providerJsonModes: {},
	providerSupportsImages: {},
	practiceFolder: "",
	createdDateProperties: DEFAULT_CREATED_DATE_PROPERTIES,
	updatedDateProperties: DEFAULT_UPDATED_DATE_PROPERTIES,
	filterRules: JSON.parse(JSON.stringify(DEFAULT_FILTER_RULES)) as FilterGroup,
	defaultQuestionCount: 10,
	questionPaneSide: "left",
	dashboardOpen: false,
	dailyPracticeEnabled: false,
	dailyReminderTime: "18:00",
	dailyQuestionCount: 8,
	dailyTopicLimit: 6,
	pdfSkills: {},
	practiceMemory: JSON.parse(JSON.stringify(DEFAULT_PRACTICE_MEMORY)) as PracticeMemory,
	practiceDraft: null,
};

export type QuestionType = "mcq" | "integer" | "decimal";
export type Difficulty = "easy" | "medium" | "hard";

export interface Question {
	id: string;
	type: QuestionType;
	questionText: string;
	options?: string[];
	correctAnswer: string;
	explanation: string;
	sourceTopics: string[];
	sourceSubtopics?: string[];
	difficulty: Difficulty;
}

export interface QuizResult {
	question: Question;
	userAnswer: string;
	isCorrect: boolean;
	skipped: boolean;
	timeTakenMs: number;
}

export interface PracticeDraft {
	questions: Question[];
	results: QuizResult[];
	currentIndex: number;
	topics: TopicNote[];
	config: SessionConfig;
	createdAt: number;
	updatedAt: number;
}

export interface TopicNote {
	path: string;
	title: string;
	aliases?: string[];
	skill: number;
	isPdf: boolean;
	createdAt?: number;
	updatedAt?: number;
	lastPracticedAt?: number;
	dueAt?: number;
	priorityScore?: number;
	scheduleReason?: string;
}

export interface NoteIndexMedia {
	path: string;
	kind: NoteMediaKind;
	mimeType: string;
	size: number;
	alt: string;
	source?: "local" | "remote";
	url?: string;
	caption?: string;
}

export interface NoteIndexEntry {
	path: string;
	title: string;
	aliases?: string[];
	extension: string;
	isPdf: boolean;
	frontmatter: Record<string, string>;
	tags: string[];
	links: string[];
	headings: NoteHeading[];
	media: NoteIndexMedia[];
	estimatedWordCount: number;
	size: number;
	skill: number;
	createdAt: number;
	updatedAt: number;
	fileCreatedAt: number;
	fileUpdatedAt: number;
	indexedAt: number;
}

export interface SessionConfig {
	topics: TopicNote[];
	questionCount: number;
	mode?: "manual" | "daily";
	challengeMode?: DailyChallengeMode;
	challengeReason?: string;
}

export type DailyChallengeMode = "warmup" | "steady" | "stretch";

export interface DailySessionPlan {
	questionCount: number;
	challengeMode: DailyChallengeMode;
	reason: string;
}

export interface SkillDelta {
	path: string;
	title: string;
	before: number;
	after: number;
}

export interface NoteHeading {
	heading: string;
	level: number;
}

export interface NoteSection {
	heading: string;
	level: number;
	content: string;
	wordCount: number;
}

export type NoteMediaKind = "image" | "pdf" | "svg" | "unknown";

export interface NoteMediaReference {
	path: string;
	alt: string;
	kind: NoteMediaKind;
	mimeType: string;
	size: number;
	source?: "local" | "remote";
	url?: string;
	caption?: string;
	svgText?: string;
}

export interface NoteStructure {
	path: string;
	title: string;
	frontmatter: Record<string, string>;
	tags: string[];
	links: string[];
	headings: NoteHeading[];
	sections: NoteSection[];
	cleanedText: string;
	media: NoteMediaReference[];
	createdAt: number;
	updatedAt: number;
	contentHash: string;
}

export interface PromptAttachment {
	noteTitle: string;
	path: string;
	kind: "image" | "pdf";
	mimeType: string;
	data: ArrayBuffer;
}
