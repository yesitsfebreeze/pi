// Shared state for the ask / questionnaire tools so that live UI components
// (DeltaLine, status panels) can reflect the number of currently open questions.
// The ask tool calls setOpenQuestions(n) on open and close; consumer components
// poll with getOpenQuestions() at render time.  Only one ask can be open at a
// time (the agent loop blocks until the user answers), so this is a simple
// module-level singleton.

let count = 0;

export function setOpenQuestions(n: number): void {
	count = n;
}

export function getOpenQuestions(): number {
	return count;
}
