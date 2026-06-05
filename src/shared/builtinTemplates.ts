import { TemplateDef } from './types';

export const BUILTIN_TEMPLATES: TemplateDef[] = [
  {
    id: 'subagent-orchestration',
    name: 'Sub-agent Orchestration',
    description: 'Define a batch of sub-agents to run: agent type, task, objective, and where the output should land.',
    scope: 'builtin',
    columns: [
      {
        id: 'agent',
        name: 'Agent',
        type: 'text',
        placeholder: 'Sub-agent type (e.g. Explore, Plan, claude)',
      },
      { id: 'task', name: 'Task', type: 'text', placeholder: 'Short description of the task' },
      { id: 'objective', name: 'Objective', type: 'text', placeholder: 'What "done" looks like' },
      { id: 'output', name: 'Output', type: 'text', placeholder: 'Where results should go (file path / variable / report)' },
      { id: 'parallel', name: 'Parallel', type: 'boolean' },
    ],
    seedRows: [
      { agent: 'Explore', task: '', objective: '', output: '', parallel: true },
    ],
  },
  {
    id: 'api-endpoints',
    name: 'API Endpoints Spec',
    description: 'Sketch a set of HTTP endpoints with request/response shape.',
    scope: 'builtin',
    columns: [
      { id: 'method', name: 'Method', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { id: 'path', name: 'Path', type: 'text', placeholder: '/v1/resource/:id' },
      { id: 'description', name: 'Description', type: 'text' },
      { id: 'request', name: 'Request', type: 'text', placeholder: 'JSON body / query params' },
      { id: 'response', name: 'Response', type: 'text', placeholder: 'JSON shape' },
    ],
    seedRows: [{ method: 'GET', path: '', description: '', request: '', response: '' }],
  },
  {
    id: 'test-cases',
    name: 'Test Cases',
    description: 'Enumerate scenarios, inputs, and expected outputs for systematic test prompts.',
    scope: 'builtin',
    columns: [
      { id: 'scenario', name: 'Scenario', type: 'text' },
      { id: 'input', name: 'Input', type: 'text' },
      { id: 'expected', name: 'Expected', type: 'text' },
      { id: 'priority', name: 'Priority', type: 'number' },
      { id: 'covered', name: 'Covered', type: 'boolean' },
    ],
    seedRows: [{ scenario: '', input: '', expected: '', priority: 1, covered: false }],
  },
];

export function getBuiltinTemplate(id: string): TemplateDef | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.id === id);
}
