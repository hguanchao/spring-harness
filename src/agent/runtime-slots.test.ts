import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runTurn } from './loop.js';
import type { AgentEvent } from './events.js';
import type { LlmClient, StreamDelta } from '../llm/openai.js';
import type { SandboxHandle } from '../sandbox/types.js';
import type { Approver } from '../approval/policy.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolSpec } from '../tools/types.js';
import type { SessionFactory, SessionMessage, SessionPort, SessionRecord } from '../session/types.js';
import { messagesOf } from '../session/query.js';

class MemorySession implements SessionPort {
  readonly records: SessionRecord[] = [];
  constructor(
    readonly dir: string,
    readonly id: string,
  ) {}

  append(record: SessionRecord): void {
    this.records.push(record);
  }

  appendMessage(message: Omit<SessionMessage, 'type' | 'ts'>): void {
    this.append({ type: 'message', ts: new Date().toISOString(), ...message });
  }

  appendEvent(kind: string, data: Record<string, unknown>): void {
    this.append({ type: 'event', ts: new Date().toISOString(), kind, data });
  }

  readAll(): SessionRecord[] {
    return this.records;
  }

  readMessages(): SessionMessage[] {
    return messagesOf(this.records);
  }
}

function memoryFactory(): SessionFactory {
  const byId = new Map<string, MemorySession>();
  let n = 0;
  return {
    create(dir) {
      const id = `mem-${++n}`;
      const session = new MemorySession(dir, id);
      byId.set(id, session);
      return session;
    },
    open(dir, id) {
      const existing = byId.get(id);
      if (existing) return existing;
      const session = new MemorySession(dir, id);
      byId.set(id, session);
      return session;
    },
    async resumeOrCreate(dir) {
      return this.create(dir, dir);
    },
  };
}

const sandbox: SandboxHandle = {
  status: { mode: 'off', enforcement: 'none', platform: process.platform },
  tempDir: '',
  run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  dispose() {},
};

const approver: Approver = { decide: async () => true };

describe('runtime slots: four replacements still complete a turn', () => {
  it('memory session + fake tool + fake client + fake sandbox records the tool call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sph-slots-'));
    try {
      const pingCalls: string[] = [];
      const ping: ToolSpec = {
        name: 'ping',
        description: 'probe',
        schema: { type: 'object', properties: { msg: { type: 'string' } } },
        concurrencySafe: true,
        async execute(args) {
          pingCalls.push(String(args.msg ?? ''));
          return { ok: true, content: 'pong' };
        },
      };
      const tools = new ToolRegistry([ping]);
      const sessions = memoryFactory();
      const session = sessions.create(root, root);
      let calls = 0;
      const client: LlmClient = {
        async complete(): Promise<StreamDelta> {
          calls++;
          if (calls === 1) {
            return {
              text: '',
              finishReason: 'tool-calls',
              toolCalls: [{ id: 'c1', name: 'ping', arguments: '{"msg":"hi"}' }],
            };
          }
          return { text: 'done', finishReason: 'stop' };
        },
      };
      const events: AgentEvent[] = [];
      await runTurn({
        prompt: 'ping once',
        workspaceRoot: root,
        client,
        session,
        tools,
        sessions,
        sandbox,
        approver,
        contextWindow: 100_000,
        listener: (event) => events.push(event),
      });
      assert.deepEqual(pingCalls, ['hi']);
      assert.equal(calls, 2);
      const roles = session.readMessages().map((row) => row.role);
      assert.ok(roles.includes('user'));
      assert.ok(roles.includes('tool'));
      assert.ok(roles.includes('assistant'));
      assert.ok(session.readAll().some((row) => row.type === 'event' && row.kind === 'turn_start'));
      assert.ok(events.some((event) => event.type === 'tool_end' && event.name === 'ping' && event.ok));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});