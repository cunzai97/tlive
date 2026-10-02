import { describe, expect, it } from 'vitest';
import type { ProgressData } from '../../shared/formatting/message-types.js';
import { FeishuFormatter } from '../../server/channels/feishu/formatter.js';

const progress = (extra: Partial<ProgressData> = {}): ProgressData => ({
  phase: 'executing',
  taskSummary: '测试',
  elapsedSeconds: 1,
  renderedText: '',
  totalTools: 0,
  todoItems: [],
  actionButtons: [],
  ...extra,
});

const todos = [
  { content: '确认 7900 XTX 上 ComfyUI 服务状态', status: 'in_progress' as const },
  { content: '提交生成任务', status: 'pending' as const },
  { content: '换一种采样器', status: 'cancelled' as const },
];

const planCall = {
  kind: 'tool' as const,
  toolId: 'call-1',
  toolName: 'todo',
  toolInput: JSON.stringify({ todos }),
  inputData: { todos },
  status: 'completed' as const,
};

interface CardElement {
  tag?: string;
  expanded?: boolean;
  element_id?: string;
  header?: { title?: { content?: string } };
}

const render = (data: ProgressData): string =>
  JSON.stringify(new FeishuFormatter('zh').formatProgress('chat', data).feishuElements);

const planPanels = (data: ProgressData): CardElement[] =>
  ((new FeishuFormatter('zh').formatProgress('chat', data).feishuElements ??
    []) as unknown as CardElement[]).filter((element) => element.tag === 'collapsible_panel');

const panelTitle = (element: CardElement | undefined): string =>
  element?.header?.title?.content ?? '';

describe('persistent plan block on progress cards', () => {
  it('shows the plan once, as markers, and keeps the tool payload out of the card', () => {
    const json = render(progress({ totalTools: 1, todoItems: todos, timeline: [planCall] }));
    expect(json).toContain('确认 7900 XTX 上 ComfyUI 服务状态');
    expect(json).toContain('⛔ 换一种采样器');
    expect(json).toContain('🔧 确认 7900 XTX 上 ComfyUI 服务状态');
    expect(json).not.toContain('\\"content\\"');
    expect(json).not.toContain('\\"todos\\"');
  });

  it('keeps the timeline row to "which tool was used" with a result summary of its own', () => {
    const elements = planPanels(progress({ totalTools: 1, todoItems: todos, timeline: [planCall] }));
    const plan = elements.find((element) => panelTitle(element).includes('工作进度'));
    expect(plan).toBeDefined();
    expect(plan?.expanded).toBe(true);
    expect(panelTitle(plan)).toContain('(0/3)');
  });

  it('carries the same identity across refreshes so the client can keep its fold state', () => {
    const first = planPanels(progress({ todoItems: todos }))[0];
    const second = planPanels(progress({ todoItems: todos, phase: 'completed' }))[0];
    expect(first?.element_id).toBe(second?.element_id);
    expect(typeof first?.element_id).toBe('string');
  });

  it('appears on the last card of a turn even when nothing else is left to report', () => {
    const json = render(progress({ phase: 'completed', totalTools: 1, todoItems: todos }));
    expect(json).toContain('工作进度');
  });

  it('renders no plan block for a child card, which owns no session plan', () => {
    const json = render(
      progress({
        subagent: { agentName: 'researcher', task: '查资料', parentToolUseId: 'p', childId: 'c' },
        todoItems: [],
        totalTools: 1,
        timeline: [planCall],
      }),
    );
    expect(json).not.toContain('工作进度');
    // The child still gets the suppressed one-line row, not the raw payload.
    expect(json).not.toContain('\\"todos\\"');
  });

  it('leaves ordinary tools untouched', () => {
    const json = render(
      progress({
        totalTools: 1,
        timeline: [
          {
            kind: 'tool',
            toolId: 'call-2',
            toolName: 'my_custom_tool',
            inputData: { alpha: 'ALPHA_VALUE', beta: { gamma: 'GAMMA_VALUE' } },
            status: 'completed',
          },
        ],
      }),
    );
    expect(json).toContain('ALPHA_VALUE');
    expect(json).toContain('GAMMA_VALUE');
  });

  it('does not silently drop a plan that outgrows one card', () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      content: `步骤_${index}_END`,
      status: index === 0 ? ('completed' as const) : ('pending' as const),
    }));
    const message = new FeishuFormatter('zh').formatProgress('chat', progress({ todoItems: many }));
    const json = JSON.stringify([message.feishuElements, message.text]);
    for (let index = 0; index < 120; index++) expect(json).toContain(`步骤_${index}_END`);
    expect(json).toContain('(1/120)');
  });
});
