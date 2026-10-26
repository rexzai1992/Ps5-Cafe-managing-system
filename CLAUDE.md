@AGENTS.md
@docs/agent/CURRENT_STATUS.md

# Claude Code continuation

Continue from the repository, not from chat history. First inspect the listed files and run the current verification gate. Implement the single **Next task** in `docs/agent/CURRENT_STATUS.md` before widening scope.

When done:

1. Run `npm run verify`.
2. Inspect the actual diff and confirm no unrelated features were added.
3. Update `docs/agent/CURRENT_STATUS.md` with truthful evidence and a new single next task.
4. Do not claim real-TV compatibility from mock tests.

