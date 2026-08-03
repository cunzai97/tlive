import { describe, expect, it } from 'vitest';
import type { DeliveryRoute } from '../../server/channels/delivery-route.js';
import { FileDeliveryRegistry } from '../../server/engine/sdk/file-delivery-registry.js';

function createRoute(): DeliveryRoute {
  return {
    channelType: 'feishu',
    chatId: 'chat-1',
    scopeId: 'chat-1#thread:thread-1',
    threadId: 'thread-1',
    replyToMessageId: 'msg-1',
    replyInThread: true,
  };
}

describe('FileDeliveryRegistry stable session tokens', () => {
  it('returns a stable token for the same session key', () => {
    const reg = new FileDeliveryRegistry();
    const firstToken = reg.register(
      'feishu:chat-1:session-1',
      createRoute(),
      '/workdir',
    );
    const secondToken = reg.register(
      'feishu:chat-1:session-1',
      { ...createRoute(), replyToMessageId: 'msg-2' },
      '/workdir',
    );

    expect(secondToken).toBe(firstToken);
    expect(reg.resolve(firstToken)).toMatchObject({
      chatId: 'chat-1',
      cwd: '/workdir',
      sessionKey: 'feishu:chat-1:session-1',
      replyToMessageId: 'msg-2',
    });
  });

  it('returns different tokens for different session keys', () => {
    const reg = new FileDeliveryRegistry();
    const tokenA = reg.register('feishu:chat-1:session-1', createRoute(), '/workdir');
    const tokenB = reg.register('feishu:chat-1:session-2', createRoute(), '/workdir');

    expect(tokenA).not.toBe(tokenB);
  });

  it('forgets the session token when pruned', () => {
    const reg = new FileDeliveryRegistry({ ttlMs: 50 });
    const token = reg.register('feishu:chat-1:session-1', createRoute(), '/workdir');

    reg.prune(Date.now() + 100000);

    expect(reg.resolve(token)).toBeUndefined();
    const newToken = reg.register('feishu:chat-1:session-1', createRoute(), '/workdir');
    expect(newToken).not.toBe(token);
  });
});
