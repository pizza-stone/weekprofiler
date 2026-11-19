import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_MAX_REQUEST_BYTES, validateAIContext, validateAIProposal, buildAIResponseRequest } from '../lib/ai-planner.mjs';

const aiTestUrl = 'https://planner.example/api/ai/plan';
const aiTestEnv = { OPENAI_API_KEY: 'fake-test-value-never-a-real-key' };
function aiInput() {
  return {
    messages: [{ role: 'user', content: '下午安排学习，保留现有日程。' }],
    context: {
      tasks: [
        { id: 'paper', title: '阅读论文', duration: 60, category: 'learn', reusable: false, done: false },
        { id: 'walk', title: '散步', duration: 30, category: 'life', reusable: true, done: false },
      ],
      groups: [{ id: 'learn', name: '学习', color: '#aabbcc' }, { id: 'life', name: '生活', color: '#ccddee' }],
      timezone: 'Asia/Shanghai', startDate: '2026-11-15', endDate: '2026-11-15',
      days: [{ date: '2026-11-15', blocks: [{ id: 'meeting', title: '固定安排', start: 540, duration: 60, category: 'life', done: false }] }],
    },
  };
}
function aiProposal() {
  return {
    reply: '建议下午阅读，傍晚散步。', explanation: '保留上午已有安排。',
    assignments: [
      { taskId: 'paper', date: '2026-11-15', start: 840, duration: 60 },
      { taskId: 'walk', date: '2026-11-15', start: 1020, duration: 30 },
    ], unscheduledTaskIds: [],
  };
}
function aiRequest(input = aiInput(), options = {}) {
  return new Request(aiTestUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://planner.example', ...options.headers },
    body: JSON.stringify(input), ...(options.signal ? { signal: options.signal } : {}),
  });
}
const aiUpstream = proposal => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }] });

test('AI context accepts one day or contiguous seven days and rejects unsafe or oversized input', () => {
  assert.equal(validateAIContext(aiInput()), true);
  const week = aiInput();
  week.context.endDate = '2026-11-21';
  week.context.days = Array.from({ length: 7 }, (_, i) => ({ date: '2026-11-' + (15 + i), blocks: [] }));
  assert.equal(validateAIContext(week), true);
  for (const change of [
    input => { input.messages[0].role = 'system'; },
    input => { input.messages[0].content = 'x'.repeat(2001); },
    input => { input.messages = []; },
    input => { input.messages.push({ role: 'assistant', content: 'last' }); },
    input => { input.context.tasks[0].duration = 45; },
    input => { input.context.days[0].blocks[0].start = 210; },
    input => { input.context.days[0].blocks[0].start = 1650; },
    input => { input.context.days[0].date = '2026-11-16'; },
    input => { input.context.timezone = 'Invalid/Zone'; },
    input => { input.context.groups.push({ ...input.context.groups[0] }); },
    input => { input.extra = 'x'.repeat(AI_MAX_REQUEST_BYTES); },
  ]) {
    const input = aiInput(); change(input); assert.equal(validateAIContext(input), false);
  }
});

test('AI proposals preserve existing arrangements and enforce task IDs, duration and 04:00 boundary', () => {
  assert.equal(validateAIProposal(aiProposal(), aiInput().context), true);
  for (const change of [
    proposal => { proposal.assignments[0].start = 540; },
    proposal => { proposal.assignments[0].taskId = 'unknown'; },
    proposal => { proposal.assignments[0].duration = 30; },
    proposal => { proposal.assignments[0].start = 210; },
    proposal => { proposal.assignments[0].start = 1650; },
    proposal => { proposal.assignments[0].date = '2026-11-16'; },
    proposal => { proposal.assignments[1].start = 870; },
    proposal => { proposal.assignments.push({ ...proposal.assignments[0], start: 1200 }); },
    proposal => { proposal.assignments[0].url = 'https://example.com'; },
    proposal => { proposal.unscheduledTaskIds.push('paper'); },
  ]) {
    const proposal = aiProposal(); change(proposal); assert.equal(validateAIProposal(proposal, aiInput().context), false);
  }
  const late = aiProposal(); late.assignments[0].start = 1440; late.assignments[1].start = 1650;
  assert.equal(validateAIProposal(late, aiInput().context), true);
});

test('completed or already scheduled one-off tasks cannot be proposed and omitted tasks are accounted for', () => {
  const completed = aiInput(); completed.context.tasks[0].done = true;
  assert.equal(validateAIProposal(aiProposal(), completed.context), false);
  const scheduled = aiInput(); scheduled.context.days[0].blocks[0].taskId = 'paper';
  assert.equal(validateAIProposal(aiProposal(), scheduled.context), false);
  const partial = aiProposal(); partial.assignments.pop(); partial.unscheduledTaskIds = ['walk'];
  assert.equal(validateAIProposal(partial, aiInput().context), true);
  partial.unscheduledTaskIds = [];
  assert.equal(validateAIProposal(partial, aiInput().context), false);
  const clarify = { reply: '希望几点开始？', explanation: '', assignments: [], unscheduledTaskIds: ['paper', 'walk'] };
  assert.equal(validateAIProposal(clarify, aiInput().context), true);
});

test('Responses request includes strict schema, minimal allowlisted context and no implicit writes', () => {
  const input = aiInput(); input.context.privateOtherField = 'must-not-send';
  const request = buildAIResponseRequest(input);
  assert.equal(request.store, false);
  assert.equal(request.stream, false);
  assert.equal(request.model, 'gpt-4.1-mini');
  assert.equal(request.text.format.type, 'json_schema');
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.schema.additionalProperties, false);
  assert.equal(JSON.stringify(request).includes('must-not-send'), false);
  assert.equal('tools' in request, false);
});
