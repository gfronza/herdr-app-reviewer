<!-- BEGIN devskills:base -->
## 1. Think Before Coding

**State assumptions. Surface confusion and tradeoffs; don't pick silently.**

Before implementing:
- State your assumptions explicitly; when something's unclear, name it and ask.
- Ask at most one question per message, and put it last. Two open questions make every answer ambiguous.
- If multiple interpretations exist, present them — don't choose one silently.
- If a simpler approach exists, say so. Push back when warranted.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- No backward-compatibility shims inside the codebase: when every caller is in reach, migrate them and delete the old path in the same change. Compatibility is owed only at published boundaries — a shipped library, API, CLI, wire or storage format — and breaking those is the user's call, never a side effect.
- When asked to improve or refactor, look for what to delete before what to add.
- If you write 200 lines and it could be 50, rewrite it.
- Refactor overly long functions without being asked — length alone is a smell worth fixing, even when nothing else is wrong.
- **Comments target humans and explain WHY, not WHAT** — a non-obvious constraint, invariant, or workaround. Default to one line, only where the reason isn't clear from the code; never restate code or cite plan/ticket IDs. A comment past a few lines is rare and signals "this matters" — keep that signal meaningful.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match the codebase's **conventions** — naming, formatting, idioms — **not its deficiencies**. Write what you touch to standard; don't down-level new work to match surrounding code.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

Make those tests count: behavior through the public interface, the failure modes that matter — not coverage, and never pinned to implementation. A test that would still pass if every function it calls returned nothing asserts no behavior; assert a literal observed result or delete it.

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Sequence the plan in layers: the system works end to end after every step. Never trade a working product for unfinished complexity — a big-bang rewrite that leaves nothing running for steps at a time is a failed plan, not progress.

For a sweep or migration past a handful of edits, write the script or codemod and run it. The tool is what a reviewer can rerun; hand-done edits can only be re-verified by redoing them.

Verify against the real thing — run the feature, read the actual output, inspect the diff. "It compiles" and a subagent's summary are not evidence.

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Safe at the Boundaries

**Distrust the edges. Fail loudly, not silently.**

- Validate untrusted input once where it enters — args, request payloads, external API responses — then trust the typed result. Re-checking deep in call chains is noise, not safety.
- Handle the errors that can actually happen; propagate or surface the rest. Never swallow an error to make a path look clean.
- Never quiet a failure with a guard. A nil check added to make a crash go away is a symptom fix that hides the cause.

## 6. Retrieve Just-in-Time

**Pull context on demand. Locate before you read.**

- Search to find the right place; read scoped regions, not whole files "to be safe".
- If `.project/map.md` exists, read it first and prefer it over re-deriving structure. When the map and the code disagree, the code wins — reread the file.
- Delegate broad searches to a sub-agent where one is available, so the sweep stays out of your context.
- Sufficiency beats thrift: when unsure, read more. A wrong answer costs far more than the tokens.

## 7. Dependencies

**Check before you build. Justify before you add.**

- Never assume a library lacks a capability without reading its documentation and types. Reimplementing what a dependency already does is duplication, not caution.
- New capability lands in this order: the standard library → a dependency the project already has → an established, well-maintained library for genuinely hard ground (crypto, parsing, dates) → hand-rolled code, only when it's small enough to own outright.
- A dependency for one trivial function, or one the standard library or platform already covers, is unjustified — drop it. Hand-rolling a hard, solved problem is the same failure in reverse.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
<!-- END devskills:base -->

<!-- BEGIN devskills:concise -->
## Response Style — Concise

Default to terse, high-density responses. Optimize for the reader's time.

- Lead with the answer or the change. Skip preamble and recap.
- Prefer code, commands, and bullet fragments over prose paragraphs.
- Drop restating the question, apologies, and "I will now..." narration.
- One good example beats three. Cut redundant explanation.
- Expand only when correctness or safety genuinely requires it.
<!-- END devskills:concise -->

<!-- BEGIN devskills:interaction -->
## Interaction Style — Questions & Handbacks

The reader answers while reading and executes while reading. Structure
questions and instructions so one pass through the message is enough.

- **At most one question per message, placed last.** A question that comes up
  mid-work is not a tangent: answer it yourself if you can and fold the result
  in. Only what truly needs the reader gets asked.
- **One topic per question.** If "and" or "or" joins two asks, split them —
  ask one now, hold the rest. Never leave two questions live at once: one
  answer against two open questions tells neither side which was answered.
- **A yes/no question stays yes/no.** Don't unfold it into "yes, no, or…". If
  real options exist, it was never a yes/no question — name the options.
- **The answer's form should be obvious from the question** — a yes, a name, a
  path. No pivot mid-question: a trailing clause that reframes the ask ("…or
  should we rethink X?") is a second question; the first rule applies.
- **Action messages run top to bottom.** Any condition, caveat, or deferral
  goes *before* the instruction it governs, never after. Check: the reader
  runs every line in the order written and ends up correct.
<!-- END devskills:interaction -->

<!-- BEGIN devskills:plain-language -->
## Writing Style — Plain Language

Prose written into the project — docs, READMEs, commit bodies, PR
descriptions, error and log text — follows the Federal Plain Language
Guidelines, applied with Grice's maxims of manner and quantity in mind.
The guidelines are the rule set; nothing here restates them.

- Adapt their register for technical writing: terms the reader already
  owns are plain language; write for what the reader needs next, not for
  the record.
- Scope is prose only — fenced and inline code, identifiers, URLs, and
  quoted material keep their exact form.
- When a plainer phrasing would lose real nuance, keep the nuance: plain
  language sets the default, not a ceiling on precision.
<!-- END devskills:plain-language -->

<!-- BEGIN devskills:phases -->
## Phase-Aware Suggestions

Emit an Insight block when the conversation reaches a clear phase transition and a specific command would help — not on every turn. Use this format exactly:

```
`Insight ─────────────────────────────────────`
[one or two concrete suggestions]
`─────────────────────────────────────────────`
```

Trigger only on the signals that genuinely apply right now:

**Starting a new task** — user describes a feature or bug from scratch, no spec yet.
Suggest: `/ds-spec` to lock the WHAT before the HOW.

**At an architectural fork** — user is choosing between approaches or asks "should I use X or Y?"
Suggest: `/ds-explore` to surface trade-offs; `/ds-grill-me` to pressure-test the choice one branch at a time.

**Code just generated** — a significant block of code was just written.
Suggest: `/ds-deslop` to strip narrating comments and defensive overkill before anyone reviews it.

**Done / opening a PR** — user says "I'm done", "ready to review", or "opening a PR".
Suggest: `/ds-code-quality-review` then `/ds-bug-review`; `/ds-security-review` if it touches input/auth/secrets; `/ds-verify-this <claim>` to prove the headline change works.

## Rules

- One Insight block per transition; never repeat a suggestion already made this session, and skip it when the user already knows (they just ran the command or said so).
- Name the exact command and what it gives, one line each.
<!-- END devskills:phases -->
