import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../bridge/protocol.mjs';
import { MCP_TOOLS, MCP_SCOPES, toolsForScope } from '../extension/lib/mcp-tools.js';

test('Settings lists exactly the tools the bridge serves, once each', () => {
  const names = MCP_TOOLS.map(tool => tool.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual([...names].sort(), TOOLS.map(tool => tool.name).sort());
  for (const tool of MCP_TOOLS) assert.ok(tool.text && tool.text.length < 90, `${tool.name} has a short description`);
});

test('read, write and destructive labels match the bridge tool annotations', () => {
  const byName = new Map(TOOLS.map(tool => [tool.name, tool]));
  for (const tool of MCP_TOOLS) {
    const annotations = byName.get(tool.name)?.annotations || {};
    const expected = annotations.readOnlyHint === true ? 'read' : annotations.destructiveHint === true ? 'destructive' : 'write';
    assert.equal(tool.access, expected, tool.name);
    assert.equal(tool.write, expected !== 'read', tool.name);
  }
});

test('scopes narrow the tool list the same way the bridge does', () => {
  assert.deepEqual(MCP_SCOPES.map(scope => scope.value), ['read', 'write', 'full']);
  assert.ok(toolsForScope('read').every(tool => tool.access === 'read'));
  assert.ok(toolsForScope('write').some(tool => tool.name === 'create_item'));
  assert.ok(!toolsForScope('write').some(tool => tool.name === 'permanently_delete_item'));
  assert.equal(toolsForScope('full').length, MCP_TOOLS.length);
});
