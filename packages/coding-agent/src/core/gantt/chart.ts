// Chart a gantt routine into .pi/gantt/. The charting protocol,
// a routine the way an explorer charts terrain — destination first,
// breadth over depth at the gantt, everything else left in fog.
export function chartPrompt(dir: string): string {
	return `Chart a gantt routine into ${dir}/.

Step 1 — grill the destination. Before writing anything, interrogate the
goal until it is one falsifiable paragraph: what does done look like, who
consumes it, what is deliberately NOT included. If the user is present,
ask; if not, derive it from the request and state your assumptions in
map.md Notes.

Step 2 — escape hatch, checked before any map exists: if the way is
already clear — one obvious ticket, no unknowns worth recording — do NOT
chart. No map, no tickets; say the way is clear and stop. A map of a
straight road is overhead.

Step 3 — breadth-first gantt pass. Walk the edge of what is known:
list every piece of work visible from here WITHOUT descending into any
of them. Only tickets you could spec today become files; each gets an
\`est: <n>d\` guess. Everything deeper stays unwritten.

Step 4 — write the files. ${dir}/map.md with Destination, Notes, Out of
scope, Fog headings; one ticket per file in ${dir}/tickets/<id>.md:

---
kind: build
state: open
mode: afk
est: 1d
---

# Title

Body: the brief for a fresh subagent that cannot see this conversation
— objective in one falsifiable sentence, where to work (paths, symbols),
acceptance criteria, what is explicitly out of scope. The loop hands
ticket bodies to children verbatim; a body only you could act on is a
ticket that will come back.

kind is decision|research|build; mode is hitl for anything needing the
human (naming, taste, money), afk otherwise. verify: <command> on build
tickets that can prove themselves.

Step 5 — wire blocked-by in a second pass, after every ticket file
exists (create-then-wire: dangling ids are a parse error, so never write
a blocked-by before its target). blocked-by is the ONLY thing that
serializes the routine, so wire it sparingly: add it only where a ticket
genuinely needs another's artifact to begin. Leave independent tickets
unblocked on purpose — the frontier surfaces them together and the loop
works them in parallel. Never chain tickets just to impose an order you
imagined; a wide, shallow DAG that runs many tickets at once is the goal,
a deep serial chain is a planning smell. Whatever remains unknown goes
under Fog in map.md — fog is honest; a fake ticket is not.

Then commit ${dir}/ and run /gantt work to start the loop.`;
}
