// crawl research — seed a research request by matching it to the
// best-scoring topic, off kern. The extension shelled out to `kern ingest`
// to record the seed; the core port writes a seed record into the local
// store under the `crawl/frontier` topic-prefix scheme (mirroring kern's
// object-id naming), so a later rescore/export over that topic surfaces
// seeded requests alongside crawled pages.
import { readConfig, type Topic } from "./config.ts";
import { ingestPage } from "./store.ts";

// pick the topic whose keywords the request hits most. A request that
// matches no topic returns undefined so the caller can report available
// topics rather than silently bucketing into "uncategorized".
export function bestTopicFromRequest(request: string): Topic | undefined {
	const topics = readConfig();
	if (topics.length === 0) return undefined;
	const lower = request.toLowerCase();
	let best: { topic: Topic; hits: number } | null = null;
	for (const topic of topics) {
		let hits = 0;
		for (const kw of topic.keywords) {
			if (kw.length < 4) continue;
			if (lower.includes(kw.toLowerCase())) hits++;
		}
		if (hits > 0 && (!best || hits > best.hits)) best = { topic, hits };
	}
	return best?.topic;
}

// record the seed as a frontier page under the matched topic, so the
// research intent is queryable alongside crawled pages.
export function research(request: string): string {
	const topic = bestTopicFromRequest(request);
	if (!topic) {
		const topics = readConfig();
		if (topics.length === 0) return "No topics configured. Add topics in .pi/crawl/topics.json to start researching.";
		return `No matching topic found for "${request}". Available topics: ${topics.map((t) => t.id).join(", ")}`;
	}
	const seedUrl = `crawl/frontier/${Date.now()}`;
	const body = `SEED REQUEST: ${request}\nTopic: ${topic.label}\nKeywords: ${topic.keywords.join(", ")}`;
	ingestPage(seedUrl, body, topic.id);
	return `Seeded topic "${topic.id}" (${topic.label}) for research.`;
}
