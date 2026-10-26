import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

const { ChatInput, useChatComposer } = await import('../../src/components/AssistantChat');

let renderer: ReactTestRenderer | undefined;
const onSend = mock(async (_text: string) => true);

function Input({ canSend }: { canSend: boolean }) {
  const composer = useChatComposer(onSend, canSend, false);
  return <ChatInput placeholder="Ask" composer={composer} />;
}

function HiddenInput({ canSend }: { canSend: boolean }) {
  useChatComposer(onSend, canSend, false, () => ['Asked while the panel was closed']);
  return null;
}

function render(canSend: boolean) {
  const element = <Input canSend={canSend} />;
  if (renderer) renderer.update(element);
  else renderer = create(element);
}

function root(): ReactTestInstance {
  return renderer!.root;
}

async function type(text: string) {
  await act(async () => root().findByType('textarea').props.onChange({ target: { value: text } }));
}

async function submit() {
  await act(async () => root().findByType('form').props.onSubmit({ preventDefault() {} }));
}

function queued(): string[] {
  return root()
    .findAll((node) => node.type === 'span' && node.props.className?.includes('break-words'))
    .map((node) => node.children.join(''));
}

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  onSend.mockClear();
});

describe('ChatInput', () => {
  test('sends right away when the assistant is free', async () => {
    await act(async () => render(true));
    await type('Who owns the rollout?');
    await submit();
    expect(onSend).toHaveBeenCalledWith('Who owns the rollout?');
    expect(queued()).toEqual([]);
  });

  test('a message sent while the previous one is still in flight waits in the queue', async () => {
    let finish: (sent: boolean) => void = () => {};
    onSend.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    await act(async () => render(true));
    await type('First question');
    void act(async () => root().findByType('form').props.onSubmit({ preventDefault() {} }));
    await act(async () => {});
    await type('Second question');
    await submit();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(queued()).toEqual(['Second question']);

    await act(async () => finish(true));
    await act(async () => {});

    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenLastCalledWith('Second question');
    expect(queued()).toEqual([]);
  });

  test('queues messages while the assistant answers and sends them together after', async () => {
    await act(async () => render(false));
    await type('First question');
    await submit();
    await type('Second question');
    await submit();
    expect(onSend).not.toHaveBeenCalled();
    expect(queued()).toEqual(['First question', 'Second question']);

    await act(async () => render(true));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('First question\n\nSecond question');
    expect(queued()).toEqual([]);
  });

  test('queued messages go out once the assistant is free, even while the input is not shown', async () => {
    await act(async () => {
      renderer = create(<HiddenInput canSend={false} />);
    });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => renderer!.update(<HiddenInput canSend />));
    expect(onSend).toHaveBeenCalledWith('Asked while the panel was closed');
  });

  test('the cross takes a queued message back into the input', async () => {
    await act(async () => render(false));
    await type('First question');
    await submit();
    await type('Draft in progress');

    await act(async () => root().findByProps({ title: 'Back to the input' }).props.onClick());

    expect(queued()).toEqual([]);
    expect(root().findByType('textarea').props.value).toBe('Draft in progress\n\nFirst question');
    await act(async () => render(true));
    expect(onSend).not.toHaveBeenCalled();
  });
});
