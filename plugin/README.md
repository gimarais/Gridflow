# GridFlow orchestration plugin

A tool-agnostic [agent plugin](https://code.visualstudio.com/docs/copilot/customization/agent-plugins) that teaches any AI coding assistant how to drive GridFlow workflows correctly — opening a workflow, dispatching one sub-agent per row, and reporting **status, files read/modified, and estimated token usage** back to the live panel.

The behaviour it enforces lives in one place: [`skills/gridflow-orchestration/SKILL.md`](skills/gridflow-orchestration/SKILL.md). It is plain markdown, so every assistant can read it regardless of which loading mechanism it supports.

## Layout

```
plugin/
  .claude-plugin/
    plugin.json                          # manifest (detected by VS Code AND Claude Code)
  skills/
    gridflow-orchestration/
      SKILL.md                           # the orchestration rules — single source of truth
  README.md
```

The manifest lives at `.claude-plugin/plugin.json` because that path is detected by **both** surfaces: it is Claude Code's native plugin location *and* one of the paths VS Code probes for agent plugins.

## How each assistant picks it up

### GitHub Copilot (VS Code) — agent plugin
Agent plugins are gated behind the organization-level **`chat.plugins.enabled`** setting. If your admin has enabled it, point VS Code at this folder as an agent plugin and Copilot loads the skill automatically. If it is **not** enabled (common on managed work machines), use the ungated fallback below — you lose nothing, because the content is identical.

### Claude Code / Claude desktop — plugin or skill
Claude Code reads `.claude-plugin/plugin.json` and the `skills/` folder natively. Install this folder as a local plugin, or copy `skills/gridflow-orchestration/` into the project's `.claude/skills/` directory.

### Any other MCP / LM-tool client
The `gridflow_*` tools already ship their own enforcement in their tool descriptions, so any client gets the core behaviour for free. For the full orchestration loop, paste the contents of `SKILL.md` into that client's system / project instructions.

## Ungated fallback (works everywhere, no plugin feature required)

When the agent-plugin setting is locked down (common on managed work machines), use these ready-made copies instead — both are ungated and auto-loaded by their respective tools:

| Copy this file | …to here in your project | Loaded by |
|----------------|--------------------------|-----------|
| [`templates/copilot-instructions.md`](templates/copilot-instructions.md) | `.github/copilot-instructions.md` | GitHub Copilot (all editions) |
| [`templates/CLAUDE.md`](templates/CLAUDE.md) | `CLAUDE.md` (project root) | Claude Code |

Both mirror [`skills/gridflow-orchestration/SKILL.md`](skills/gridflow-orchestration/SKILL.md), which is the canonical source — if you change one, update the others.
