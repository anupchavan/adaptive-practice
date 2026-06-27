import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SHEET_BASE =
	"https://docs.google.com/spreadsheets/d/e/2PACX-1vQwwL4nbX2NZmqb_yAXIpSZ8TcFi8jhd_AkeUCnVm8-JmfzuglUz53H6CwkX8VA7Y1eKVVHiP8q4eMF";
const SHEET_GIDS = ["1897055834", "0", "1895244070", "521774643", "399687152"];
const VAULT_ROOT = path.resolve(process.cwd(), "../../..");
const OUT_DIR = path.join(VAULT_ROOT, "Practice Lab", "CS Wikipedia");
const MANIFEST_PATH = path.join(OUT_DIR, "_import-manifest.json");
const DEFUDDLE_BASE_URL = normalizeBaseUrl(
	readStringFlag("--defuddle-base", process.env.DEFUDDLE_BASE_URL ?? "")
);
const DEFUDDLE_API_KEY = readStringFlag("--defuddle-key", process.env.DEFUDDLE_API_KEY ?? "");
const DEFUDDLE_PARSE_URL = DEFUDDLE_BASE_URL ? `${DEFUDDLE_BASE_URL}/api/parse` : "";
const TARGET_COUNT = readNumberFlag("--target", 400);
const CONCURRENCY = readNumberFlag("--concurrency", 5);
const MAX_BODY_CHARS = readNumberFlag("--max-chars", 32_000);
const OVERWRITE = process.argv.includes("--overwrite");
const EXPAND_LINKS = process.argv.includes("--expand-links");

if (!DEFUDDLE_BASE_URL) {
	throw new Error(
		"Set DEFUDDLE_BASE_URL or pass --defuddle-base to a self-hosted Defuddle endpoint. " +
		"Example: DEFUDDLE_BASE_URL=http://127.0.0.1:8787 node scripts/import-wikipedia-cs-lab.mjs"
	);
}

const COURSE_TOPICS = {
	"Intro to Programming": [
		"Computer programming",
		"Programming language",
		"Computer program",
		"Algorithm",
		"Flowchart",
		"Control flow",
		"Conditional (computer programming)",
		"Loop (computing)",
		"Iteration",
		"Recursion (computer science)",
		"Variable (computer science)",
		"Data type",
		"Type system",
		"Function (computer programming)",
		"Subroutine",
		"Parameter (computer programming)",
		"Scope (computer science)",
		"Array (data structure)",
		"String (computer science)",
		"Pointer (computer programming)",
		"Reference (computer science)",
		"Memory management",
		"Debugging",
		"Software testing",
		"Unit testing",
		"Exception handling",
		"Object-oriented programming",
		"Class (computer programming)",
		"Encapsulation (computer programming)",
		"Inheritance (object-oriented programming)",
		"Polymorphism (computer science)",
		"Generic programming",
		"Functional programming",
		"Imperative programming",
		"Procedural programming",
	],
	"Software Development Fundamentals": [
		"Software development",
		"Software development process",
		"Software design",
		"Requirements analysis",
		"Version control",
		"Git",
		"Code review",
		"Continuous integration",
		"Software repository",
		"Refactoring",
		"Technical debt",
		"Software documentation",
		"Test-driven development",
		"Integration testing",
		"Regression testing",
		"Software bug",
		"Defensive programming",
		"Design pattern",
		"Application programming interface",
	],
	"Intro to Computing": [
		"Computer science",
		"Computer",
		"Computing",
		"Information",
		"Data (computer science)",
		"Bit",
		"Byte",
		"Binary number",
		"Boolean algebra",
		"Central processing unit",
		"Computer memory",
		"Operating system",
		"File system",
		"Computer network",
		"Internet",
		"World Wide Web",
		"Cloud computing",
		"Human-computer interaction",
	],
	"Discrete Maths": [
		"Discrete mathematics",
		"Set theory",
		"Naive set theory",
		"Mathematical logic",
		"Propositional calculus",
		"Predicate logic",
		"Truth table",
		"Boolean function",
		"Mathematical proof",
		"Mathematical induction",
		"Proof by contradiction",
		"Pigeonhole principle",
		"Combinatorics",
		"Permutation",
		"Combination",
		"Recurrence relation",
		"Generating function",
		"Graph theory",
		"Graph (discrete mathematics)",
		"Tree (graph theory)",
		"Bipartite graph",
		"Planar graph",
		"Graph coloring",
		"Matching (graph theory)",
		"Relation (mathematics)",
		"Equivalence relation",
		"Partial order",
		"Lattice (order)",
		"Modular arithmetic",
	],
	"Probability & Random variables (AI)": [
		"Probability",
		"Probability theory",
		"Random variable",
		"Probability distribution",
		"Conditional probability",
		"Bayes' theorem",
		"Independence (probability theory)",
		"Expected value",
		"Variance",
		"Bernoulli distribution",
		"Binomial distribution",
		"Normal distribution",
		"Poisson distribution",
		"Markov chain",
		"Hidden Markov model",
		"Bayesian network",
		"Naive Bayes classifier",
		"Monte Carlo method",
	],
	"Data Structures": [
		"Data structure",
		"Abstract data type",
		"Array (data structure)",
		"Dynamic array",
		"Linked list",
		"Doubly linked list",
		"Stack (abstract data type)",
		"Queue (abstract data type)",
		"Priority queue",
		"Deque",
		"Hash table",
		"Hash function",
		"Hash collision",
		"Bloom filter",
		"Heap (data structure)",
		"Binary heap",
		"Tree (data structure)",
		"Binary tree",
		"Binary search tree",
		"AVL tree",
		"Red-black tree",
		"B-tree",
		"Trie",
		"Segment tree",
		"Fenwick tree",
		"Disjoint-set data structure",
		"Graph (abstract data type)",
		"Adjacency list",
		"Adjacency matrix",
	],
	"Algorithms": [
		"Algorithm design",
		"Analysis of algorithms",
		"Time complexity",
		"Big O notation",
		"Best, worst and average case",
		"Amortized analysis",
		"Loop invariant",
		"Divide-and-conquer algorithm",
		"Dynamic programming",
		"Greedy algorithm",
		"Backtracking",
		"Branch and bound",
		"Binary search algorithm",
		"Sorting algorithm",
		"Insertion sort",
		"Merge sort",
		"Quicksort",
		"Heapsort",
		"Counting sort",
		"Radix sort",
		"Selection algorithm",
		"Graph traversal",
		"Depth-first search",
		"Breadth-first search",
		"Topological sorting",
		"Shortest path problem",
		"Dijkstra's algorithm",
		"Bellman-Ford algorithm",
		"Floyd-Warshall algorithm",
		"Minimum spanning tree",
		"Kruskal's algorithm",
		"Prim's algorithm",
		"Maximum flow problem",
		"Ford-Fulkerson algorithm",
		"String-searching algorithm",
		"Knuth-Morris-Pratt algorithm",
		"Rabin-Karp algorithm",
		"Computational complexity theory",
		"NP-completeness",
	],
	"C. Architecture": [
		"Computer architecture",
		"Instruction set architecture",
		"Microarchitecture",
		"Central processing unit",
		"Arithmetic logic unit",
		"Processor register",
		"Instruction cycle",
		"Pipelining",
		"Hazard (computer architecture)",
		"Branch predictor",
		"Cache (computing)",
		"CPU cache",
		"Cache coherence",
		"Virtual memory",
		"Memory hierarchy",
		"Endianness",
		"RISC",
		"CISC",
		"Superscalar processor",
		"Out-of-order execution",
		"Parallel computing",
		"SIMD",
		"Multicore processor",
	],
	"Operating Systems 1": [
		"Operating system",
		"Kernel (operating system)",
		"System call",
		"Process (computing)",
		"Thread (computing)",
		"Scheduling (computing)",
		"Context switch",
		"Interrupt",
		"Concurrency (computer science)",
		"Mutual exclusion",
		"Semaphore (programming)",
		"Monitor (synchronization)",
		"Deadlock (computer science)",
		"Race condition",
		"Critical section",
		"Memory management (operating systems)",
		"Paging",
		"Page replacement algorithm",
	],
	"Operating Systems 2": [
		"Virtual memory",
		"File system",
		"Inode",
		"Journaling file system",
		"Device driver",
		"I/O scheduling",
		"Inter-process communication",
		"Message passing",
		"Shared memory",
		"Distributed operating system",
		"Real-time operating system",
		"Virtualization",
		"Hypervisor",
		"Containerization (computing)",
		"Security kernel",
	],
	"DBMS-1": [
		"Database",
		"Database model",
		"Database management system",
		"Relational database",
		"Relational model",
		"Database schema",
		"Entity-relationship model",
		"Entity-relationship diagram",
		"SQL",
		"Relational algebra",
		"Tuple relational calculus",
		"Database normalization",
		"First normal form",
		"Second normal form",
		"Third normal form",
		"Boyce-Codd normal form",
		"Primary key",
		"Foreign key",
	],
	"DBMS-2": [
		"Database index",
		"B-tree",
		"Query optimization",
		"Query plan",
		"Transaction processing",
		"ACID",
		"Concurrency control",
		"Two-phase locking",
		"Serializability",
		"Multiversion concurrency control",
		"Database transaction",
		"Database recovery",
		"Write-ahead logging",
		"Distributed database",
		"NoSQL",
		"CAP theorem",
	],
	"Theory of Computation": [
		"Theory of computation",
		"Automata theory",
		"Finite-state machine",
		"Deterministic finite automaton",
		"Nondeterministic finite automaton",
		"Regular language",
		"Regular expression",
		"Pumping lemma for regular languages",
		"Context-free grammar",
		"Context-free language",
		"Pushdown automaton",
		"Chomsky hierarchy",
		"Turing machine",
		"Decidability (logic)",
		"Halting problem",
		"Computability theory",
		"Lambda calculus",
		"Church-Turing thesis",
	],
	"Compilers 1": [
		"Compiler",
		"Interpreter (computing)",
		"Lexical analysis",
		"Parsing",
		"Parser",
		"Context-free grammar",
		"Abstract syntax tree",
		"Recursive descent parser",
		"LL parser",
		"LR parser",
		"Syntax-directed translation",
		"Semantic analysis (compilers)",
		"Symbol table",
		"Type checking",
		"Intermediate representation",
	],
	"Compilers-2": [
		"Code generation (compiler)",
		"Compiler optimization",
		"Data-flow analysis",
		"Control-flow graph",
		"Static single-assignment form",
		"Register allocation",
		"Garbage collection (computer science)",
		"Just-in-time compilation",
		"Linker (computing)",
		"Loader (computing)",
		"Runtime system",
		"Calling convention",
		"Tail call",
	],
	"Computer Networks": [
		"Computer network",
		"Internet protocol suite",
		"OSI model",
		"Packet switching",
		"Routing",
		"Router (computing)",
		"Switch (networking)",
		"Ethernet",
		"Wi-Fi",
		"Internet Protocol",
		"IPv4",
		"IPv6",
		"Transmission Control Protocol",
		"User Datagram Protocol",
		"Congestion control",
		"Domain Name System",
		"Hypertext Transfer Protocol",
		"Transport Layer Security",
		"Network socket",
		"Firewall (computing)",
	],
	"SWE": [
		"Software engineering",
		"Software architecture",
		"Software design pattern",
		"Agile software development",
		"Scrum (software development)",
		"Unified Modeling Language",
		"Use case",
		"Software quality",
		"Software maintenance",
		"Software deployment",
		"DevOps",
		"Microservices",
		"Service-oriented architecture",
		"REST",
		"GraphQL",
	],
	"Artificial Intelligence": [
		"Artificial intelligence",
		"Intelligent agent",
		"Search algorithm",
		"Adversarial search",
		"Minimax",
		"Alpha-beta pruning",
		"Constraint satisfaction problem",
		"Knowledge representation and reasoning",
		"Expert system",
		"Planning (artificial intelligence)",
		"Machine learning",
		"Supervised learning",
		"Unsupervised learning",
		"Reinforcement learning",
		"Artificial neural network",
		"Natural language processing",
	],
	"Foundations-ML": [
		"Machine learning",
		"Statistical classification",
		"Regression analysis",
		"Linear regression",
		"Logistic regression",
		"Decision tree learning",
		"Random forest",
		"Support vector machine",
		"Naive Bayes classifier",
		"K-means clustering",
		"Principal component analysis",
		"Gradient descent",
		"Backpropagation",
		"Overfitting",
		"Cross-validation (statistics)",
		"Bias-variance tradeoff",
		"Feature engineering",
		"Deep learning",
	],
	"Digital Circuits": [
		"Digital electronics",
		"Logic gate",
		"Boolean algebra",
		"Combinational logic",
		"Sequential logic",
		"Flip-flop (electronics)",
		"Multiplexer",
		"Adder (electronics)",
		"Arithmetic logic unit",
		"Finite-state machine",
		"Hardware description language",
		"Verilog",
		"VHDL",
		"Field-programmable gate array",
	],
	"Linear Algebra": [
		"Linear algebra",
		"Vector space",
		"Matrix (mathematics)",
		"Matrix multiplication",
		"Linear map",
		"Eigenvalues and eigenvectors",
		"Singular value decomposition",
		"Gaussian elimination",
		"Linear independence",
		"Basis (linear algebra)",
		"Rank (linear algebra)",
	],
	"Intro to Statistics": [
		"Statistics",
		"Descriptive statistics",
		"Statistical inference",
		"Hypothesis testing",
		"Confidence interval",
		"Sampling distribution",
		"Correlation",
		"Covariance",
		"Central limit theorem",
	],
};

const FALLBACK_TOPICS = [
	"Information retrieval",
	"Search engine indexing",
	"PageRank",
	"Distributed computing",
	"MapReduce",
	"Blockchain",
	"Cryptography",
	"Public-key cryptography",
	"Hash function",
	"Transport Layer Security",
	"Computer security",
	"Access control",
	"Authentication",
	"Authorization",
	"Static program analysis",
	"Model checking",
	"Formal verification",
	"Program synthesis",
	"Type theory",
	"Category theory",
	"Quantum computing",
	"Computer graphics",
	"Rendering (computer graphics)",
	"Ray tracing (graphics)",
	"Computational geometry",
	"Numerical analysis",
	"Floating-point arithmetic",
	"Parallel algorithm",
	"Distributed algorithm",
	"Consensus (computer science)",
	"Raft (algorithm)",
	"Paxos (computer science)",
	"Byzantine fault",
	"Load balancing (computing)",
	"Caching",
	"Content delivery network",
	"Data compression",
	"Huffman coding",
	"Lempel-Ziv-Welch",
	"Error detection and correction",
	"Unicode",
	"Regular expression",
	"Parsing expression grammar",
	"Domain-specific language",
	"Virtual machine",
	"Bytecode",
	"WebAssembly",
	"Operating-system-level virtualization",
	"Container orchestration",
	"Kubernetes",
	"Relational database management system",
	"Data warehouse",
	"Data mining",
	"Online analytical processing",
	"Information theory",
	"Entropy (information theory)",
	"Cybernetics",
];

const GENERIC_CELLS = new Set([
	"",
	"Code",
	"Credits",
	"Segment",
	"Total",
	"LA/CA",
	"Free Electives",
	"Dept Electives",
	"Institute Range",
	"CSE",
	"Basic Sciences",
	"Basic Engg",
	"Dept Core",
	"Life Skills",
	"Non-CSE",
]);

await mkdir(OUT_DIR, { recursive: true });
const existingManifest = await readJson(MANIFEST_PATH, { imported: [] });
const previousEntryCount = existingManifest.imported?.length ?? 0;
const importedByTitle = new Set(
	OVERWRITE ? [] : (existingManifest.imported?.map((entry) => entry.title) ?? [])
);
const seenTitles = new Set(importedByTitle);
const seenUrls = new Set();
const stats = {
	candidates: 0,
	imported: 0,
	skippedExisting: 0,
	skippedFiltered: 0,
	failed: 0,
};
const failedSamples = [];
const newImports = [];

const courses = await fetchCurriculumCourses();
const queue = buildInitialQueue(courses);
stats.candidates = queue.length;

await runQueue(queue);

const manifest = {
	importedAt: new Date().toISOString(),
	target: TARGET_COUNT,
	source: `${SHEET_BASE}/pubhtml`,
	method: "curl Wikipedia HTML + self-hosted Defuddle /api/parse; no Wikipedia API and no public defuddle.md endpoint",
	defuddleBaseUrl: DEFUDDLE_BASE_URL,
	outputDirectory: OUT_DIR,
	previousEntryCount,
	totalEntryCount: mergeManifestEntries(existingManifest.imported ?? [], newImports).length,
	runStats: stats,
	failedSamples,
	imported: mergeManifestEntries(existingManifest.imported ?? [], newImports),
};
await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8");

console.log(
	`Imported ${stats.imported} new CS Wikipedia notes (${manifest.imported.length} total manifest entries). ` +
	`Skipped ${stats.skippedExisting} existing, ${stats.skippedFiltered} filtered, ${stats.failed} failed.`
);

async function fetchCurriculumCourses() {
	const courses = new Set();
	for (const gid of SHEET_GIDS) {
		const csvUrl = `${SHEET_BASE}/pub?gid=${gid}&single=true&output=csv`;
		const csv = await curl(csvUrl);
		for (const row of parseCsv(csv)) {
			for (const cell of row) {
				const value = cell.trim();
				if (isCourseName(value)) courses.add(value);
			}
		}
	}
	return [...courses];
}

function buildInitialQueue(courses) {
	const buckets = [];
	const addToBucket = (bucket, title, course, depth = 0) => {
		const normalized = normalizeTitle(title);
		if (!normalized || shouldSkipTitle(normalized) || seenTitles.has(normalized)) return;
		seenTitles.add(normalized);
		bucket.push({ title: normalized, course, depth });
	};

	for (const course of courses) {
		const bucket = [];
		const topics = COURSE_TOPICS[course] ?? [];
		if (topics.length === 0 && likelyCsCourse(course)) addToBucket(bucket, course, course);
		for (const topic of topics) addToBucket(bucket, topic, course);
		if (bucket.length > 0) buckets.push(bucket);
	}
	const fallbackBucket = [];
	for (const topic of FALLBACK_TOPICS) addToBucket(fallbackBucket, topic, "CS enrichment");
	if (fallbackBucket.length > 0) buckets.push(fallbackBucket);

	const interleaved = [];
	const maxLength = Math.max(...buckets.map((bucket) => bucket.length));
	for (let i = 0; i < maxLength; i++) {
		for (const bucket of buckets) {
			if (bucket[i]) interleaved.push(bucket[i]);
		}
	}
	return interleaved;
}

async function runQueue(queue) {
	let index = 0;
	const workers = Array.from({ length: CONCURRENCY }, async () => {
		while (importedByTitle.size + stats.imported < TARGET_COUNT && index < queue.length) {
			const item = queue[index++];
			if (!item) return;
			await importOne(item, queue);
		}
	});
	await Promise.all(workers);
}

async function importOne(item, queue) {
	const wikiUrl = wikipediaUrl(item.title);
	if (seenUrls.has(wikiUrl)) return;
	seenUrls.add(wikiUrl);

	const filename = `${safeFilename(item.title)}.md`;
	const outPath = path.join(OUT_DIR, filename);
	if (!OVERWRITE) {
		try {
			await readFile(outPath, "utf8");
			stats.skippedExisting++;
			return;
		} catch {
			// File does not exist yet.
		}
	}

	let markdown;
	try {
		const html = await curl(wikiUrl);
		markdown = await parseWithSelfHostedDefuddle(html, wikiUrl);
	} catch (error) {
		stats.failed++;
		if (failedSamples.length < 20) {
			failedSamples.push({
				title: item.title,
				source: wikiUrl,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return;
	}

	const parsed = parseDefuddleResult(markdown, wikiUrl, item.title);
	if (!parsed || shouldSkipArticle(parsed)) {
		stats.skippedFiltered++;
		return;
	}

	if (EXPAND_LINKS) {
		const linkedTitles = extractWikipediaLinks(parsed.body);
		for (const linkedTitle of linkedTitles) {
			if (queue.length >= TARGET_COUNT * 4) break;
			if (!seenTitles.has(linkedTitle) && !shouldSkipTitle(linkedTitle)) {
				seenTitles.add(linkedTitle);
				queue.push({ title: linkedTitle, course: item.course, depth: item.depth + 1 });
			}
		}
	}

	const body = trimArticle(parsed.body);
	const note = renderNote({
		title: parsed.title || item.title,
		course: item.course,
		source: parsed.source || wikiUrl,
		body,
		truncated: body.length < parsed.body.length,
	});
	await writeFile(outPath, note, "utf8");
	stats.imported++;
	newImports.push({
		title: parsed.title || item.title,
		course: item.course,
		path: path.relative(VAULT_ROOT, outPath),
		source: parsed.source || wikiUrl,
	});
	if (stats.imported % 25 === 0) {
		console.log(`Imported ${stats.imported} new notes...`);
	}
}

function parseDefuddleResult(result, fallbackUrl, fallbackTitle) {
	const body = stringifyDefuddleField(result.content).trim();
	if (!body || /^</.test(body) || /not found|error fetching/i.test(body)) return null;
	if (!/^https:\/\/en\.wikipedia\.org\/wiki\//.test(fallbackUrl)) return null;
	return {
		title: normalizeTitle(stringifyDefuddleField(result.title) || fallbackTitle || titleFromUrl(fallbackUrl)),
		source: fallbackUrl,
		body: absolutizeWikipediaLinks(body),
	};
}

function stringifyDefuddleField(value) {
	return typeof value === "string" ? value.trim() : "";
}

function shouldSkipArticle(article) {
	const title = normalizeTitle(article.title);
	if (shouldSkipTitle(title)) return true;
	if (article.body.length < 1_800) return true;
	const lead = article.body.slice(0, 1_800);
	if (/may refer to:|may also refer to:|commonly refers to:|this disambiguation page lists/i.test(lead)) {
		return true;
	}
	if (/article is about/i.test(lead) && /for other uses/i.test(lead)) return true;
	if (/\b(born|died)\b/i.test(lead) && /\b(computer scientist|mathematician|engineer|inventor|entrepreneur|physicist)\b/i.test(lead)) {
		return true;
	}
	return false;
}

function shouldSkipTitle(title) {
	return !title ||
		title.length > 90 ||
		/[#{}[\]|<>]/.test(title) ||
		/\b(disambiguation|people|births|deaths)\b/i.test(title) ||
		/^(List of|Index of|Outline of|Timeline of|Glossary of|Bibliography of|Category:|File:|Help:|Wikipedia:|Template:|Portal:)/i.test(title);
}

function likelyCsCourse(course) {
	return /comput|program|data|algorithm|operating|compiler|dbms|network|software|machine|artificial|logic|discrete|digital|architecture/i.test(course);
}

function isCourseName(value) {
	if (GENERIC_CELLS.has(value)) return false;
	if (/^(Sem \d+|[A-Z]{2,4}\d{3,4}|LAxxxx|\d+|~?\d+(?:-\d+)?)$/.test(value)) return false;
	return /[A-Za-z]/.test(value) && value.length >= 3 && value.length <= 60;
}

function extractWikipediaLinks(markdown) {
	const links = [];
	const regex = /\]\(https:\/\/en\.wikipedia\.org\/wiki\/([^)#"]+)/g;
	let match;
	while ((match = regex.exec(markdown))) {
		const decoded = decodeURIComponent(match[1]).replace(/_/g, " ");
		const title = normalizeTitle(decoded);
		if (title && !shouldSkipTitle(title)) links.push(title);
	}
	return links;
}

function trimArticle(body) {
	let trimmed = body
		.replace(/\n## (See also|References|External links|Further reading|Notes)\b[\s\S]*$/i, "")
		.replace(/\n\[\^[^\]]+\]:.*(?:\n {2,}.*)*/g, "")
		.trim();
	if (trimmed.length > MAX_BODY_CHARS) {
		trimmed = `${trimmed.slice(0, MAX_BODY_CHARS).trim()}\n\n> [!note] Imported note truncated for practice-lab size. Open the source for the full article.`;
	}
	return trimmed;
}

function renderNote({ title, course, source, body, truncated }) {
	const imported = new Date().toISOString();
	return `---\n` +
		`title: "${yamlEscape(title)}"\n` +
		`course: "${yamlEscape(course)}"\n` +
		`source: "${yamlEscape(source)}"\n` +
		`source_site: "Wikipedia"\n` +
		`source_license: "CC BY-SA 4.0"\n` +
		`imported: "${imported}"\n` +
		`adaptive-practice: true\n` +
		`tags:\n` +
		`  - adaptive-practice/imported\n` +
		`  - cs\n` +
		`  - wikipedia\n` +
		`---\n\n` +
		`# ${title}\n\n` +
		`> Imported with curl via Defuddle from Wikipedia for the Adaptive Practice CS lab. Curriculum seed: ${course}.${truncated ? " This note is intentionally truncated." : ""}\n\n` +
		`${body}\n`;
}

async function curl(url, options = {}) {
	const args = [
		"--location",
		"--silent",
		"--show-error",
		"--fail",
		"--max-time",
		"60",
		"--retry",
		"2",
		"--user-agent",
		"AdaptivePracticeLabImporter/1.0",
	];
	if (options.method) {
		args.push("--request", options.method);
	}
	for (const header of options.headers ?? []) {
		args.push("--header", header);
	}
	if (options.dataFile) {
		args.push("--data-binary", `@${options.dataFile}`);
	}
	args.push(url);

	const { stdout } = await execFileAsync(
		"curl",
		args,
		{ maxBuffer: 24 * 1024 * 1024 }
	);
	return stdout;
}

async function parseWithSelfHostedDefuddle(html, sourceUrl) {
	const dir = await mkdtemp(path.join(tmpdir(), "adaptive-practice-defuddle-"));
	const payloadPath = path.join(dir, "payload.json");
	try {
		await writeFile(payloadPath, JSON.stringify({ html, url: sourceUrl }), "utf8");
		const headers = ["Content-Type: application/json"];
		if (DEFUDDLE_API_KEY) {
			headers.push(`Authorization: Bearer ${DEFUDDLE_API_KEY}`);
		}
		const response = await curl(
			DEFUDDLE_PARSE_URL,
			{ method: "POST", headers, dataFile: payloadPath }
		);
		const result = JSON.parse(response);
		if (result?.error) {
			throw new Error(String(result.error));
		}
		return result;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function absolutizeWikipediaLinks(markdown) {
	return markdown
		.replace(/\]\(about:\/wiki\//g, "](https://en.wikipedia.org/wiki/")
		.replace(/\]\(\/wiki\//g, "](https://en.wikipedia.org/wiki/")
		.replace(/\]\(\/\/upload\.wikimedia\.org/g, "](https://upload.wikimedia.org");
}

function wikipediaUrl(title) {
	const slug = encodeURIComponent(title.replace(/\s+/g, "_")).replace(/%2F/g, "/");
	return `https://en.wikipedia.org/wiki/${slug}`;
}

function titleFromUrl(url) {
	return normalizeTitle(decodeURIComponent(url.split("/wiki/")[1] ?? "").replace(/_/g, " "));
}

function normalizeTitle(title) {
	return title
		.replace(/\s+/g, " ")
		.replace(/\s+\((?:identifier|number)\)$/i, "")
		.trim();
}

function safeFilename(title) {
	return title
		.replace(/[/:\\?*"<>|]/g, " -")
		.replace(/\s+/g, " ")
		.slice(0, 110)
		.trim();
}

function yamlEscape(value) {
	return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function parseCsv(csv) {
	const rows = [];
	let row = [];
	let cell = "";
	let quoted = false;
	for (let i = 0; i < csv.length; i++) {
		const char = csv[i];
		const next = csv[i + 1];
		if (quoted && char === '"' && next === '"') {
			cell += '"';
			i++;
		} else if (char === '"') {
			quoted = !quoted;
		} else if (!quoted && char === ",") {
			row.push(cell);
			cell = "";
		} else if (!quoted && (char === "\n" || char === "\r")) {
			if (char === "\r" && next === "\n") i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
		} else {
			cell += char;
		}
	}
	if (cell || row.length) {
		row.push(cell);
		rows.push(row);
	}
	return rows;
}

async function readJson(file, fallback) {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return fallback;
	}
}

function uniqueManifestEntry(entry, index, entries) {
	return entries.findIndex((candidate) => candidate.path === entry.path) === index;
}

function mergeManifestEntries(existingEntries, entriesToMerge) {
	const merged = [...existingEntries];
	for (const entry of entriesToMerge) {
		const existingIndex = merged.findIndex((candidate) => candidate.path === entry.path);
		if (existingIndex === -1) {
			merged.push(entry);
		} else {
			merged[existingIndex] = entry;
		}
	}
	return merged.filter(uniqueManifestEntry);
}

function readNumberFlag(flag, fallback) {
	const index = process.argv.indexOf(flag);
	if (index === -1) return fallback;
	const value = Number(process.argv[index + 1]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readStringFlag(flag, fallback) {
	const index = process.argv.indexOf(flag);
	if (index === -1) return fallback;
	return process.argv[index + 1] ?? fallback;
}

function normalizeBaseUrl(value) {
	return value.trim().replace(/\/+$/, "");
}
