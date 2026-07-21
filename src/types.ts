export type FilterOperator =
	| "contains" | "does not contain"
	| "contains any of" | "does not contain any of"
	| "contains all of" | "does not contain all of"
	| "is" | "is not"
	| "is exactly" | "is not exactly"
	| "starts with" | "does not start with"
	| "ends with" | "does not end with"
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
	| "openai-compatible"
	| "ollama"
	| "claude-code"
	| "codex";

export const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = {
	gemini: "Gemini",
	anthropic: "Anthropic",
	openai: "OpenAI",
	deepseek: "DeepSeek",
	qwen: "Qwen",
	openrouter: "OpenRouter",
	"openai-compatible": "OpenAI-compatible",
	ollama: "Ollama (local)",
	"claude-code": "Claude Code (subscription)",
	codex: "Codex CLI (subscription)",
};

/** Providers that only run through the Whetstone native engine. */
export const ENGINE_ONLY_PROVIDERS: LlmProvider[] = ["claude-code", "codex"];

export const OPENAI_COMPATIBLE_PROVIDERS: LlmProvider[] = [
	"openai",
	"deepseek",
	"qwen",
	"openrouter",
	"openai-compatible",
	"ollama",
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
		model: "qwen3.7-plus",
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
	"claude-code": {
		baseUrl: "",
		model: "sonnet",
		secretName: "",
		jsonMode: "prompt_only",
		supportsImages: false,
		supportsPdfs: false,
	},
	codex: {
		baseUrl: "",
		model: "terra",
		secretName: "",
		jsonMode: "prompt_only",
		supportsImages: false,
		supportsPdfs: false,
	},
	ollama: {
		baseUrl: "http://localhost:11434/v1/chat/completions",
		model: "llama3.1",
		secretName: "ollama-api-key",
		jsonMode: "json_object",
		supportsImages: false,
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
	/** Desired recall probability when a note comes due (0.7–0.97). */
	targetRetention: number;
	/** What the learner is practicing for; conditions question style. */
	practiceIntent: PracticeIntent;
	/** Generate sessions in adaptive micro-batches instead of one shot. */
	flowGeneration: boolean;
	/** Blind re-solve each generated batch and drop questions whose marked answer fails. */
	verifyAnswers: boolean;
	/** Run the adversarial deep-authoring sharpen pass (token-heavy, off by default). */
	deepAuthoring: boolean;
	pdfSkills: Record<string, number>;
	practiceMemory: PracticeMemory;
	practiceDraft: PracticeDraft | null;
	/** Desktop only: delegate generation to the Whetstone native engine. */
	useNativeEngine: boolean;
	/** Optional explicit path to the whetstone sidecar binary. */
	nativeEnginePath: string;
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
	/** Per-subtopic FSRS stability (DAS3H-style component memory). */
	stabilityDays?: number;
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
	questionFeedback?: QuestionFeedbackEntry[];
}

export type QuestionFeedbackKind = "too_easy" | "too_hard" | "bad_concept";

export interface QuestionFeedbackEntry {
	id: string;
	kind: QuestionFeedbackKind;
	questionText: string;
	correctAnswer: string;
	difficulty: Difficulty;
	sourceTopics: string[];
	sourceSubtopics: string[];
	wasCorrect: boolean;
	skipped: boolean;
	timeTakenMs: number;
	createdAt: number;
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
	questionFeedback: [],
};

export const DEFAULT_SETTINGS: AdaptivePracticeSettings = {
	useNativeEngine: false,
	nativeEnginePath: "",
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
	targetRetention: 0.9,
	practiceIntent: "mastery",
	flowGeneration: true,
	verifyAnswers: true,
	deepAuthoring: false,
	pdfSkills: {},
	practiceMemory: JSON.parse(JSON.stringify(DEFAULT_PRACTICE_MEMORY)) as PracticeMemory,
	practiceDraft: null,
};

export type PracticeIntent = "mastery" | "cram" | "review";

export type QuestionType = "mcq" | "multi" | "integer" | "decimal";
export type Difficulty = "easy" | "medium" | "hard";

export interface Question {
	id: string;
	type: QuestionType;
	questionText: string;
	options?: string[];
	correctAnswer: string;
	/**
	 * "multi" (select-all-that-apply) questions: every correct option. For
	 * multi, `correctAnswer` holds these joined with newlines for display and
	 * fingerprinting; grading uses this array.
	 */
	correctAnswers?: string[];
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
	completed?: true;
}

export interface TopicNote {
	path: string;
	title: string;
	aliases?: string[];
	skill: number;
	isPdf: boolean;
	createdAt?: number;
	/** Filesystem ctime — tiebreak when frontmatter created dates collide. */
	fileCreatedAt?: number;
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
	/** Session entry points set this from settings (default true there); it is
	 * opt-in at this level so test fixtures with bare configs skip the pass. */
	verifyAnswers?: boolean;
	/** Session entry points set this from settings; opt-in adversarial sharpen. */
	deepAuthoring?: boolean;
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
