import { useState } from 'react';
import { TemplateDef } from '../shared/types';
import { post } from './vscode';
import { useStore } from './store';

export function TemplateManagerApp() {
  const templates = useStore((s) => s.templates);

  const visibleBuiltins = templates.filter((t) => t.scope === 'builtin' && !t.hidden);
  const hiddenBuiltins = templates.filter((t) => t.scope === 'builtin' && t.hidden);
  const workspace = templates.filter((t) => t.scope === 'workspace');
  const global = templates.filter((t) => t.scope === 'global');

  return (
    <div className="tm-page">
      <div className="tm-header">
        <h2>Template Manager</h2>
        <p>
          Built-in templates can be hidden but not deleted. Workspace templates are stored in{' '}
          <code>.vscode/gridflow.templates.json</code>. Global templates are available in all workspaces.
        </p>
      </div>
      <div className="tm-body">
        <Section
          title="Built-in"
          templates={visibleBuiltins}
          emptyHint={hiddenBuiltins.length > 0 ? 'All built-in templates are hidden.' : undefined}
        >
          {(t) => (
            <BuiltinRow key={t.id} template={t} />
          )}
        </Section>

        {hiddenBuiltins.length > 0 && (
          <Section title="Hidden built-ins" templates={hiddenBuiltins}>
            {(t) => <HiddenBuiltinRow key={t.id} template={t} />}
          </Section>
        )}

        <Section
          title="Workspace"
          templates={workspace}
          emptyHint="No workspace templates yet — save the current grid as a template to create one."
        >
          {(t) => <CustomRow key={t.id} template={t} />}
        </Section>

        <Section title="Global" templates={global} emptyHint="No global templates yet.">
          {(t) => <CustomRow key={t.id} template={t} />}
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  templates,
  emptyHint,
  children,
}: {
  title: string;
  templates: TemplateDef[];
  emptyHint?: string;
  children?: (t: TemplateDef) => React.ReactNode;
}) {
  return (
    <div className="tm-section">
      <div className="tm-section-heading">
        {title}
        <span className="tm-count">{templates.length}</span>
      </div>
      {templates.length === 0 && emptyHint ? (
        <div className="tm-empty">{emptyHint}</div>
      ) : templates.length > 0 && children ? (
        <div className="tm-list">{templates.map(children)}</div>
      ) : null}
    </div>
  );
}

function BuiltinRow({ template }: { template: TemplateDef }) {
  return (
    <div className="tm-row">
      <div className="tm-row-body">
        <div className="tm-row-name">{template.name}</div>
        {template.description && <div className="tm-row-desc">{template.description}</div>}
      </div>
      <div className="tm-row-actions">
        <button
          className="btn icon"
          title="Hide from templates list"
          onClick={() => post({ type: 'hideBuiltin', id: template.id })}
        >
          Hide
        </button>
        <button
          className="btn primary"
          title="Open template in a new grid to edit"
          onClick={() => post({ type: 'openTemplateInGrid', templateId: template.id })}
        >
          ✎ Edit
        </button>
      </div>
    </div>
  );
}

function HiddenBuiltinRow({ template }: { template: TemplateDef }) {
  return (
    <div className="tm-row" style={{ opacity: 0.6 }}>
      <div className="tm-row-body">
        <div className="tm-row-name">{template.name}</div>
        {template.description && <div className="tm-row-desc">{template.description}</div>}
      </div>
      <div className="tm-row-actions">
        <button
          className="btn"
          title="Restore to templates list"
          onClick={() => post({ type: 'showBuiltin', id: template.id })}
        >
          Restore
        </button>
      </div>
    </div>
  );
}

function CustomRow({ template }: { template: TemplateDef }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description ?? '');

  function startEdit() {
    setName(template.name);
    setDescription(template.description ?? '');
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
  }

  function saveEdit() {
    if (!name.trim()) return;
    post({ type: 'renameTemplate', id: template.id, name: name.trim(), description: description.trim() || undefined });
    setEditing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
    if (e.key === 'Escape') cancelEdit();
  }

  if (editing) {
    return (
      <div className="tm-edit-form">
        <input
          type="text"
          value={name}
          autoFocus
          placeholder="Template name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <input
          type="text"
          value={description}
          placeholder="Description (optional)"
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="tm-edit-actions">
          <button className="btn secondary" onClick={cancelEdit}>Cancel</button>
          <button className="btn primary" onClick={saveEdit} disabled={!name.trim()}>Save</button>
        </div>
      </div>
    );
  }

  return (
    <div className="tm-row">
      <div className="tm-row-body">
        <div className="tm-row-name">{template.name}</div>
        {template.description && <div className="tm-row-desc">{template.description}</div>}
      </div>
      <div className="tm-row-actions">
        <button className="btn icon" title="Rename or edit description" onClick={startEdit}>
          Rename
        </button>
        <button
          className="btn icon"
          title="Delete template"
          style={{ color: 'var(--gridflow-error)' }}
          onClick={() => post({ type: 'deleteTemplate', templateId: template.id })}
        >
          Delete
        </button>
        <button
          className="btn primary"
          title="Open template in a new grid to edit"
          onClick={() => post({ type: 'openTemplateInGrid', templateId: template.id })}
        >
          ✎ Edit
        </button>
      </div>
    </div>
  );
}
