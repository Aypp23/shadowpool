---
name: context-retrieval-protocol
description: Retrieve project context from guide.txt/context.txt/hooks.txt and iExec MCP tools. Use before any implementation, refactor, debugging, or architectural decision to ensure constraints and existing hooks are understood.
---

# Context Retrieval Protocol

## Protocol
Follow this order strictly before making changes.

## Context Reuse (avoid re-reading the same files)
Reuse context only when all conditions are true:
- You already read `guide.txt`, `context.txt`, and/or `hooks.txt` in this workspace session.
- The task continues the same feature or bug area (same contracts/app, same user flow).
- No signals indicate changed requirements (new spec, new files, conflicting behavior).

When reusing context:
1. Do a targeted lookup for the specific section you need.
2. Re-read only the relevant slices for precision.
3. Proceed with implementation or debugging.

If any doubt remains (or the scope changes), follow the full protocol.

## Full Protocol
1. Read `guide.txt` (entire file) to understand architecture patterns, naming conventions, and tech stack rules.
   - If the viewer/tool has line limits, keep reading with offsets until EOF.
2. Read `context.txt` (entire file) to understand business rules, user flows, and edge cases.
   - If the viewer/tool has line limits, keep reading with offsets until EOF.
3. Read `hooks.txt` (entire file) to identify reusable hooks and implementation patterns.
   - If the viewer/tool has line limits, keep reading with offsets until EOF.
4. If the task touches iExec functionality, check available MCP tools (e.g., `protect_data`, `web3mail`) and prefer them over re-implementing.

## After Retrieval
Do all of the following before implementation:
- Summarize constraints and requirements discovered.
- Reuse existing hooks and patterns where possible.
- Start implementation or debugging only after the above is complete.

## Validation Checklist
- [ ] Identify architectural constraints from `guide.txt`.
- [ ] Understand user requirements from `context.txt`.
- [ ] Reuse existing hooks from `hooks.txt` instead of writing new ones.
- [ ] Confirm required iExec tools are available.

**// turbo-all**

## Example
Input: "Implement feature X"

Output:
1. Read `guide.txt`, `context.txt`, `hooks.txt` in order.
2. Confirm required iExec tools if feature X touches iExec functionality.
3. Summarize constraints and requirements.
4. Begin implementation.
