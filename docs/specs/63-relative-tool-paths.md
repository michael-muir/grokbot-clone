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

New pure module `server/src/display-path.ts`:

```ts
/** A path for a label: relative inside the workspace, absolute (resolved) outside it. */
export function displayPath(workspaceDir: string, path: string): string;
```

- The path is resolved against the workspace (a relative path is relative to it, as the tools treat it), purely
  lexically: a label never touches the disk.
- Inside: `relative(workspace, resolved)`, or `.` for the workspace itself.
- Outside (the relative path starts with a `..` segment, or is absolute, as on another Windows drive): the
  resolved absolute path, so `../../etc/passwd` shows where it really goes.
- `node:path` compares Windows paths without regard to case, so `C:\Users\…` and `c:\users\…` match.
- A file whose name merely starts with `..` (`..notes`) is inside.

`Tool.summarize(input)` becomes `summarize(input, workspaceDir)`; the loop passes the run's workspace.
`summarizeTool(tool, input)` in the Claude provider takes `workspaceDir` too. Shortening to 80 characters
happens after the path is made relative, so a long workspace prefix no longer pushes the file name out.

## Interfaces

- `displayPath(workspaceDir: string, path: string): string` (new)
- `Tool.summarize(input, workspaceDir)` and `summarizeTool(tool, input, workspaceDir)` (one more argument)

## Test plan

| Task (from the issue) | Shown by |
| --- | --- |
| Labels take the workspace dir and shorten paths inside it | `display path: …` tests, `tool summaries match the status row wording`, `claude: file tool labels are relative inside the workspace` |
| Tests for inside, outside and `..` paths | `display path: inside`, `display path: outside and escaping with ..`, `display path: a name starting with .. is inside` |

## Risks and open questions

- A workspace reached through a symlink or an 8.3 short name on Windows won't match lexically, so its paths
  stay absolute. That's the safe direction: the label looks outside, never inside when it isn't.
