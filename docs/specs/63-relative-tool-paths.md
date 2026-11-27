# #63 Tool status labels: show paths relative to the bot's workspace

Issue: #63 · Milestone: Phase 2 · Desktop app core · Requirements: none · Stories: none

## Goal

Status rows and approval cards name files the way the user thinks of them: `Writing hello.txt` for a file in the
bot's computer, and the full path only when the bot reaches outside it, which is what the user needs to notice.

## Scope

- In: the file labels of the built-in tools (`read_file`, `write_file`, `edit_file`) and of Claude's file tools
  (`Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`).
- Out: shell commands (the command is shown as typed; rewriting paths inside it could mislead), search patterns,
  URLs.

## Design

New module `server/src/display-path.ts`:

```ts
/** Relative inside the workspace, the real absolute path outside it. */
export function displayPath(workspaceDir: string, path: string): string;
/** displayPath, then cut to 80 characters from the left so the file name shows. */
export function labelPath(workspaceDir: string, v: unknown): string;
```

- The path is resolved against the workspace (a relative path is relative to it, as the tools treat it). Both are
  then taken to their real location: the deepest existing ancestor through `realpath`, plus the rest. A link
  inside the workspace that points out shows where a write would really land. Claude's own file tools don't go
  through `resolveInWorkspace`, so its approval cards depend on this. A workspace reached through a link (macOS
  `/var` → `/private/var`) still matches.
- Inside: `relative(workspace, target)`, or `.` for the workspace itself.
- Outside (the relative path starts with a `..` segment, or is absolute, as on another Windows drive): the real
  absolute path, so `../../etc/passwd` shows where it really goes.
- A file whose name merely starts with `..` (`..notes`) is inside.

`Tool.summarize(input)` becomes `summarize(input, workspaceDir)`; the loop passes the run's workspace.
`summarizeTool(tool, input)` in the Claude provider takes `workspaceDir` too. Both use `labelPath`, and Claude's
other labels reuse the loop's `short`, so the two wordings can't drift.

## Interfaces

- `displayPath(workspaceDir: string, path: string): string` and `labelPath(workspaceDir: string, v: unknown): string` (new)
- `Tool.summarize(input, workspaceDir)` and `summarizeTool(tool, input, workspaceDir)` (one more argument)

## Test plan

| Task (from the issue) | Shown by |
| --- | --- |
| Labels take the workspace dir and shorten paths inside it | `display path: …` tests, `tool summaries match the status row wording`, `claude: file tool labels are relative inside the workspace` |
| Tests for inside, outside and `..` paths | `display path: inside`, `display path: outside and escaping with ..`, `display path: a name starting with .. is inside` |

## Risks and open questions

- A label reads the disk (`realpath` up the path): a few stat calls per tool call, small next to the tool.
