/**
 * MCP protocol data — tool schemas and prompt registry — shared by the
 * extension's MCP server and the CLI's headless MCP server so every client
 * sees identical tool contracts. Pure data: no `vscode` imports.
 */

export const MCP_PROMPTS = [
  {
    name: 'gridflow-orchestrate',
    description:
      'Configure Claude as a GridFlow workflow orchestrator. After loading this prompt, Claude will ' +
      'proactively use gridflow_openWorkflow, gridflow_updateRow, and related tools whenever you ' +
      'describe a multi-step task — no need to name specific tools yourself.',
    arguments: [
      {
        name: 'task',
        description: 'Optional: the task or goal you want to orchestrate (e.g. "refactor the auth system").',
        required: false,
      },
    ],
  },
];

/* ── MCP tool schemas ────────────────────────────────────────────────── */

// Shared shape for a sub-agent task row across openWorkflow / addRows.
const ROW_ITEM_SCHEMA = {
  type: 'object',
  description:
    'A sub-agent task. Keys matching your column names become cell values (e.g. {"Task":"…"}). ' +
    'Reserved keys configure the sub-agent: "agent" (which agent/sub-agent runs it), "model", ' +
    '"inputs" (the prompt/context to hand the sub-agent), and "dependsOn" (array of 0-based indices ' +
    'of earlier rows that must finish first — omit for rows that can run in parallel).',
  properties: {
    agent: { type: 'string' },
    model: { type: 'string' },
    inputs: { type: 'string' },
    dependsOn: { type: 'array', items: { type: 'number' } },
  },
  additionalProperties: true,
};

const COLUMNS_SCHEMA = {
  type: 'array',
  description:
    'Design the columns to represent exactly what the user asked for (e.g. Task, Objective, Target file, Acceptance criteria). ' +
    'You choose these — there is no fixed template.',
  items: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
      type: { type: 'string', enum: ['text', 'select', 'number', 'boolean'] },
      options: { type: 'array', items: { type: 'string' } },
    },
  },
};

export const MCP_TOOLS = [
  {
    name: 'gridflow_openWorkflow',
    description:
      'Opens a sub-agent orchestration workflow grid. Use whenever the user asks to orchestrate agents, parallelize work, or run a multi-step task. ' +
      'YOU design the grid: choose columns for the work, one row per sub-agent task. ' +
      'Set "dependsOn" for sequential tasks (0-based indices); omit for tasks that run in parallel. Set "agent" per row.\n\n' +
      'CALL SEQUENCE after the user clicks "Start Workflow" (the tool unblocks and returns the grid JSON with readyRowIds):\n' +
      '1. For each row in readyRowIds, dispatch it in parallel:\n' +
      '   a. Call gridflow_updateRow(workflowId, rowId, status:"running") immediately.\n' +
      '   b. Run the sub-agent with the row\'s inputs.\n' +
      '   c. Call gridflow_updateRow(workflowId, rowId, status:"done"/"failed", outputs:"...", provenance:{...}, usage:{...}).\n' +
      '2. After each updateRow response, dispatch any new rowIds in its readyRowIds list.\n' +
      '3. Continue until all rows are terminal.\n\n' +
      'PROVENANCE — sub-agents do NOT auto-report file access. ALWAYS append to the end of every "inputs" prompt:\n' +
      '"After finishing, output exactly this line at the very end of your response:\n' +
      '<gf-prov>{\"filesRead\":[\"path/a.ts\",\"path/b.ts\"],\"filesModified\":[\"path/c.ts\"],\"toolCalls\":[\"Read\",\"Bash\"]}</gf-prov>\n' +
      'Include every file you accessed. Required for the audit trail."\n' +
      'When the sub-agent returns, extract that line, parse the JSON, pass it to updateRow\'s provenance fields, and strip the line from outputs.\n\n' +
      'CHAT OUTPUT: Keep chat narration minimal — one short sentence per major step (e.g. "Dispatching 3 sub-agents."). ' +
      'Put all findings and results in updateRow outputs so the user can read them in the VS Code panel.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Workflow name / slug (e.g. "auth-refactor").' },
        title: { type: 'string', description: 'Human-readable panel title. Defaults to name.' },
        columns: COLUMNS_SCHEMA,
        rows: { type: 'array', description: 'One row per sub-agent task.', items: ROW_ITEM_SCHEMA },
        instructions: { type: 'string', description: 'One-line instruction shown above the grid.' },
      },
    },
  },
  {
    name: 'gridflow_addRows',
    description:
      'Adds more sub-agent task rows to an already-open workflow. Use when orchestration reveals new work to dispatch ' +
      '(e.g. a research row uncovers three follow-up tasks). The grid updates live. dependsOn here uses 0-based indices within the rows you pass.',
    inputSchema: {
      type: 'object',
      required: ['workflowId', 'rows'],
      properties: {
        workflowId: { type: 'string', description: 'The workflowId returned by gridflow_openWorkflow.' },
        rows: { type: 'array', items: ROW_ITEM_SCHEMA },
      },
    },
  },
  {
    name: 'gridflow_updateRow',
    description:
      'Reports a sub-agent\'s progress on a workflow row. Call it TWICE per row: ' +
      '(1) status:"running" the moment work begins — GridFlow timestamps this and measures wall-clock duration automatically. ' +
      '(2) status:"done" or "failed" when work is complete.\n\n' +
      'On the COMPLETION call you MUST populate provenance — this is the audit trail the user sees in the panel:\n' +
      '• provenance.filesRead — every file path you READ during this task (every Read tool call, every grep/find/cat via Bash). ' +
        'Leaving this empty shows "0 files read" to the user.\n' +
      '• provenance.filesModified — every file you CREATED, EDITED, or DELETED (Edit, Write, Bash writes). ' +
        'Include the change type ("modified", "created", or "deleted").\n' +
      '• provenance.toolCalls — notable tool invocations (name + short input/output).\n' +
      '• provenance.subAgents — names of any sub-agents you spawned.\n\n' +
      'Also include outputs (what was produced) and estimated usage (inputTokens, outputTokens, totalTokens, costUsd) — best-effort token estimates, since no surface exposes exact counts to a tool; the panel labels them as estimates. ' +
      'The response returns updated readyRowIds so you know which dependent tasks can now be dispatched.',
    inputSchema: {
      type: 'object',
      required: ['workflowId', 'rowId'],
      properties: {
        workflowId: { type: 'string', description: 'The workflowId returned by gridflow_openWorkflow.' },
        rowId: { type: 'string', description: 'The row id from the openWorkflow response.' },
        status: { type: 'string', enum: ['pending', 'queued', 'running', 'blocked', 'done', 'failed', 'cancelled'], description: 'Send "running" when dispatching the sub-agent, then "done"/"failed" when it returns.' },
        agent: { type: 'string', description: 'The sub-agent that ran this row (e.g. "Explore", "general-purpose").' },
        model: { type: 'string', description: 'Model used (e.g. "claude-opus-4-8").' },
        inputs: { type: 'string', description: 'The prompt/context handed to the sub-agent.' },
        outputs: { type: 'string', description: 'What the sub-agent produced.' },
        summary: { type: 'string', description: 'One-line outcome. Defaults to first 240 chars of outputs.' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Row ids this row depends on (if changing dependencies).' },
        startedAt: { type: 'string', description: 'ISO timestamp when the run started (optional; GridFlow tracks this automatically).' },
        finishedAt: { type: 'string', description: 'ISO timestamp when the run finished. Defaults to now.' },
        provenance: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            context: { type: 'string' },
            filesRead: {
              type: 'array',
              description: 'Every file path read or searched during this task (Read tool calls, grep, find, cat, etc.). Include ALL of them — the user sees this count in the panel.',
              items: { type: 'object', properties: { path: { type: 'string', description: 'Absolute or workspace-relative file path.' }, note: { type: 'string', description: 'Optional short note (e.g. "searched for auth logic").' } }, required: ['path'] },
            },
            filesModified: {
              type: 'array',
              description: 'Every file created, edited, or deleted during this task (Edit, Write, Bash writes/deletions).',
              items: { type: 'object', properties: { path: { type: 'string', description: 'Absolute or workspace-relative file path.' }, change: { type: 'string', enum: ['modified', 'created', 'deleted'], description: 'How the file was changed.' }, note: { type: 'string', description: 'Optional short note (e.g. "added auth middleware").' } }, required: ['path'] },
            },
            toolCalls: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' } }, required: ['name'] } },
            subAgents: { type: 'array', items: { type: 'string' } },
          },
        },
        usage: {
          type: 'object',
          description: 'Estimated token usage for this run (best-effort — exact counts are not exposed to tools). The panel labels these as estimates.',
          properties: {
            inputTokens: { type: 'number' },
            outputTokens: { type: 'number' },
            totalTokens: { type: 'number' },
            costUsd: { type: 'number' },
          },
        },
        logs: {
          type: 'array',
          items: { type: 'object', properties: { message: { type: 'string' }, level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] }, at: { type: 'string' } }, required: ['message'] },
        },
      },
    },
  },
  {
    name: 'gridflow_getWorkflow',
    description:
      'Returns the current state of all rows in a workflow — status, assigned agent, inputs, outputs, cost, run count. ' +
      'Also returns "readyRows": each ready row with its resolved inputs (its own prompt plus a snapshot of every ' +
      'dependency\'s outputs) so you can wire parent results into the sub-agent prompt deterministically. ' +
      'Use to read structured context from a running workflow or to resume one.',
    inputSchema: {
      type: 'object',
      required: ['workflowId'],
      properties: {
        workflowId: { type: 'string', description: 'The workflowId returned by gridflow_openWorkflow.' },
      },
    },
  },
  {
    name: 'gridflow_fanOut',
    description:
      'Expands ONE template row into N parallel rows — the map / fan-out primitive. Use when the same task must run ' +
      'over a list (e.g. "audit each of these 8 files", "summarize each PR"). Each item produces an independent row ' +
      'that can run in parallel. In the template\'s string fields use {{item}} for the whole item, or {{field}} for a ' +
      'field when items are objects. Set the template\'s dependsOn to existing parent row ids to gate the whole fan-out.',
    inputSchema: {
      type: 'object',
      required: ['workflowId', 'template', 'items'],
      properties: {
        workflowId: { type: 'string', description: 'The workflowId returned by gridflow_openWorkflow.' },
        template: {
          type: 'object',
          description:
            'A single sub-agent task row with {{item}}/{{field}} placeholders. Reserved keys: agent, model, inputs, ' +
            'dependsOn (existing row ids the whole fan-out waits on). Other keys are cell values keyed by column name.',
          properties: {
            agent: { type: 'string' },
            model: { type: 'string' },
            inputs: { type: 'string' },
            dependsOn: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: true,
        },
        items: {
          type: 'array',
          description: 'The list to fan out over. Strings (use {{item}}) or objects (use {{field}}).',
          items: { type: ['string', 'object'] },
        },
      },
    },
  },
  {
    name: 'gridflow_replayRow',
    description:
      'Replays a SINGLE finished/failed row without re-running any upstream work. Resets just that row to "pending" ' +
      '(its execution history is preserved) and returns its resolvedInputs — the row\'s own prompt plus a snapshot of ' +
      'every dependency\'s outputs as they stand now. Use this to recover from a failed node: call gridflow_replayRow, ' +
      'then re-dispatch the sub-agent with the returned resolvedInputs (optionally pass promptOverride to tweak the prompt), ' +
      'and report the new run via gridflow_updateRow. Far cheaper than re-running the whole workflow.',
    inputSchema: {
      type: 'object',
      required: ['workflowId', 'rowId'],
      properties: {
        workflowId: { type: 'string', description: 'The workflowId returned by gridflow_openWorkflow.' },
        rowId: { type: 'string', description: 'The id of the row to replay.' },
        promptOverride: { type: 'string', description: "Optional: replace the row's inputs/prompt for the replay." },
      },
    },
  },
  {
    name: 'gridflow_collectStructuredInput',
    description:
      'Opens an interactive grid in VS Code and blocks until the user fills it in and clicks "Send to Chat". ' +
      'Returns the rows as JSON. For one-shot form-style collection. For multi-step agent work use gridflow_openWorkflow.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        templateId: { type: 'string', description: "Built-in: 'subagent-orchestration', 'api-endpoints', 'test-cases'." },
        columns: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'type'],
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['text', 'select', 'number', 'boolean'] },
              options: { type: 'array', items: { type: 'string' } },
              placeholder: { type: 'string' },
            },
          },
        },
        rows: { type: 'array', items: { type: 'object' } },
        instructions: { type: 'string' },
      },
    },
  },
];
