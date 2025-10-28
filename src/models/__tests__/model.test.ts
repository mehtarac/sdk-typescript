import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime'
import { BedrockModel } from '../bedrock'
import type { Message, ContentBlock } from '../../types/messages'
import type { ModelStreamEvent } from '../streaming'

/**
 * Helper function to collect events and message from an async generator properly.
 */
async function collectAggregated(
  generator: AsyncGenerator<ModelStreamEvent | ContentBlock, Message, never>
): Promise<{ items: (ModelStreamEvent | ContentBlock)[]; result: Message }> {
  const items: (ModelStreamEvent | ContentBlock)[] = []
  let done = false
  let result: Message | undefined

  while (!done) {
    const { value, done: isDone } = await generator.next()
    done = isDone ?? false
    if (!done) {
      items.push(value as ModelStreamEvent | ContentBlock)
    } else {
      result = value as Message
    }
  }

  return { items, result: result! }
}

/**
 * Helper function to setup mock send with custom stream generator.
 */
function setupMockSend(streamGenerator: () => AsyncGenerator<unknown>): void {
  vi.clearAllMocks()

  const mockSend = vi.fn().mockImplementation(async () => {
    return {
      stream: streamGenerator(),
    }
  })

  vi.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation(mockSend)
}

describe('Model', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('streamAggregated', () => {
    describe('when streaming a simple text message', () => {
      it('yields original events plus aggregated content block and returns final message', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { contentBlockStart: { contentBlockIndex: 0 } }
          yield { contentBlockDelta: { delta: { text: 'Hello' }, contentBlockIndex: 0 } }
          yield { contentBlockStop: { contentBlockIndex: 0 } }
          yield { messageStop: { stopReason: 'end_turn' } }
          yield { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } }
        })

        const provider = new BedrockModel()
        const messages: Message[] = [{ type: 'message', role: 'user', content: [{ type: 'textBlock', text: 'Hi' }] }]

        const { items, result } = await collectAggregated(provider.streamAggregated(messages))

        // Test that we got all the events and blocks
        let streamEventCount = 0
        let contentBlockCount = 0

        for (const item of items) {
          switch (item.type) {
            case 'modelMessageStartEvent':
            case 'modelContentBlockStartEvent':
            case 'modelContentBlockDeltaEvent':
            case 'modelContentBlockStopEvent':
            case 'modelMessageStopEvent':
            case 'modelMetadataEvent':
              streamEventCount++
              break
            case 'textBlock':
            case 'toolUseBlock':
            case 'reasoningBlock':
              contentBlockCount++
              break
          }
        }

        expect(streamEventCount).toBe(5)
        expect(contentBlockCount).toBe(1)

        // Verify the returned message
        expect(result).toEqual({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'textBlock', text: 'Hello' }],
          stopReason: 'endTurn',
        })
      })
    })

    describe('when streaming multiple text blocks', () => {
      it('yields all blocks in order', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { contentBlockStart: { contentBlockIndex: 0 } }
          yield { contentBlockDelta: { delta: { text: 'First' }, contentBlockIndex: 0 } }
          yield { contentBlockStop: { contentBlockIndex: 0 } }
          yield { contentBlockStart: { contentBlockIndex: 1 } }
          yield { contentBlockDelta: { delta: { text: 'Second' }, contentBlockIndex: 1 } }
          yield { contentBlockStop: { contentBlockIndex: 1 } }
          yield { messageStop: { stopReason: 'end_turn' } }
          yield { metadata: { usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } } }
        })

        const provider = new BedrockModel()
        const messages: Message[] = [{ type: 'message', role: 'user', content: [{ type: 'textBlock', text: 'Hi' }] }]

        const { items, result } = await collectAggregated(provider.streamAggregated(messages))

        const contentBlocks = items.filter(
          (i) => i.type === 'textBlock' || i.type === 'toolUseBlock' || i.type === 'reasoningBlock'
        )
        expect(contentBlocks).toEqual([
          { type: 'textBlock', text: 'First' },
          { type: 'textBlock', text: 'Second' },
        ])

        expect(result).toEqual({
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'textBlock', text: 'First' },
            { type: 'textBlock', text: 'Second' },
          ],
          stopReason: 'endTurn',
        })
      })
    })

    describe('when streaming tool use', () => {
      it('yields complete tool use block', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield {
            contentBlockStart: {
              contentBlockIndex: 0,
              start: { toolUse: { toolUseId: 'tool1', name: 'get_weather' } },
            },
          }
          yield { contentBlockDelta: { delta: { toolUse: { input: '{"location"' } }, contentBlockIndex: 0 } }
          yield { contentBlockDelta: { delta: { toolUse: { input: ': "Paris"}' } }, contentBlockIndex: 0 } }
          yield { contentBlockStop: { contentBlockIndex: 0 } }
          yield { messageStop: { stopReason: 'tool_use' } }
          yield { metadata: { usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 } } }
        })

        const provider = new BedrockModel()
        const messages: Message[] = [{ type: 'message', role: 'user', content: [{ type: 'textBlock', text: 'Hi' }] }]

        const { items, result } = await collectAggregated(provider.streamAggregated(messages))

        const contentBlocks = items.filter(
          (i) => i.type === 'textBlock' || i.type === 'toolUseBlock' || i.type === 'reasoningBlock'
        )
        expect(contentBlocks).toHaveLength(1)
        expect(contentBlocks[0]).toEqual({
          type: 'toolUseBlock',
          toolUseId: 'tool1',
          name: 'get_weather',
          input: { location: 'Paris' },
        })

        expect(result.content).toEqual([
          {
            type: 'toolUseBlock',
            toolUseId: 'tool1',
            name: 'get_weather',
            input: { location: 'Paris' },
          },
        ])
      })
    })

    describe('when streaming reasoning content', () => {
      it('yields complete reasoning block', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { contentBlockStart: { contentBlockIndex: 0 } }
          yield {
            contentBlockDelta: {
              delta: { reasoningContent: { text: 'Thinking about', signature: 'sig1', redactedContent: null } },
              contentBlockIndex: 0,
            },
          }
          yield {
            contentBlockDelta: {
              delta: { reasoningContent: { text: ' the problem', signature: null, redactedContent: null } },
              contentBlockIndex: 0,
            },
          }
          yield { contentBlockStop: { contentBlockIndex: 0 } }
          yield { messageStop: { stopReason: 'end_turn' } }
          yield { metadata: { usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } } }
        })

        const provider = new BedrockModel()
        const messages: Message[] = [{ type: 'message', role: 'user', content: [{ type: 'textBlock', text: 'Hi' }] }]

        const { items, result } = await collectAggregated(provider.streamAggregated(messages))

        const contentBlocks = items.filter(
          (i) => i.type === 'textBlock' || i.type === 'toolUseBlock' || i.type === 'reasoningBlock'
        )
        expect(contentBlocks).toEqual([
          {
            type: 'reasoningBlock',
            text: 'Thinking about the problem',
            signature: 'sig1',
          },
        ])

        expect(result.content).toEqual([
          {
            type: 'reasoningBlock',
            text: 'Thinking about the problem',
            signature: 'sig1',
          },
        ])
      })

      it('omits signature if not present', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { contentBlockStart: { contentBlockIndex: 0 } }
          yield {
            contentBlockDelta: {
              delta: { reasoningContent: { text: 'Thinking', signature: null, redactedContent: null } },
              contentBlockIndex: 0,
            },
          }
          yield { contentBlockStop: { contentBlockIndex: 0 } }
          yield { messageStop: { stopReason: 'end_turn' } }
          yield { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } }
        })

        const provider = new BedrockModel()
        const messages: Message[] = [{ type: 'message', role: 'user', content: [{ type: 'textBlock', text: 'Hi' }] }]

        const { items, result } = await collectAggregated(provider.streamAggregated(messages))

        const contentBlocks = items.filter(
          (i) => i.type === 'textBlock' || i.type === 'toolUseBlock' || i.type === 'reasoningBlock'
        )
        expect(contentBlocks).toEqual([
          {
            type: 'reasoningBlock',
            text: 'Thinking',
          },
        ])

        expect(result.content).toEqual([
          {
            type: 'reasoningBlock',
            text: 'Thinking',
          },
        ])
      })
    })

    describe('when streaming mixed content blocks', () => {
      it('yields all blocks in correct order', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { contentBlockStart: { contentBlockIndex: 0 } }
          yield { contentBlockDelta: { delta: { text: 'Hello' }, contentBlockIndex: 0 } }
          yield { contentBlockStop: { contentBlockIndex: 0 } }
          yield {
            contentBlockStart: {
              contentBlockIndex: 1,
              start: { toolUse: { toolUseId: 'tool1', name: 'get_weather' } },
            },
          }
          yield { contentBlockDelta: { delta: { toolUse: { input: '{"city": "Paris"}' } }, contentBlockIndex: 1 } }
          yield { contentBlockStop: { contentBlockIndex: 1 } }
          yield { contentBlockStart: { contentBlockIndex: 2 } }
          yield {
            contentBlockDelta: {
              delta: { reasoningContent: { text: 'Reasoning', signature: 'sig1', redactedContent: null } },
              contentBlockIndex: 2,
            },
          }
          yield { contentBlockStop: { contentBlockIndex: 2 } }
          yield { messageStop: { stopReason: 'end_turn' } }
          yield { metadata: { usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 } } }
        })

        const provider = new BedrockModel()
        const messages: Message[] = [{ type: 'message', role: 'user', content: [{ type: 'textBlock', text: 'Hi' }] }]

        const { items, result } = await collectAggregated(provider.streamAggregated(messages))

        const contentBlocks = items.filter(
          (i) => i.type === 'textBlock' || i.type === 'toolUseBlock' || i.type === 'reasoningBlock'
        )
        expect(contentBlocks).toEqual([
          { type: 'textBlock', text: 'Hello' },
          { type: 'toolUseBlock', toolUseId: 'tool1', name: 'get_weather', input: { city: 'Paris' } },
          { type: 'reasoningBlock', text: 'Reasoning', signature: 'sig1' },
        ])

        expect(result.content).toEqual([
          { type: 'textBlock', text: 'Hello' },
          { type: 'toolUseBlock', toolUseId: 'tool1', name: 'get_weather', input: { city: 'Paris' } },
          { type: 'reasoningBlock', text: 'Reasoning', signature: 'sig1' },
        ])
      })
    })

    describe('stop reasons', () => {
      it('includes stop reason in returned message', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { contentBlockStart: { contentBlockIndex: 0 } }
          yield { contentBlockDelta: { delta: { text: 'Test' }, contentBlockIndex: 0 } }
          yield { contentBlockStop: { contentBlockIndex: 0 } }
          yield { messageStop: { stopReason: 'max_tokens' } }
          yield { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } }
        })

        const provider = new BedrockModel()
        const messages: Message[] = [{ type: 'message', role: 'user', content: [{ type: 'textBlock', text: 'Hi' }] }]

        const { result } = await collectAggregated(provider.streamAggregated(messages))

        expect(result.stopReason).toBe('maxTokens')
      })

      it('includes usage metadata in returned message', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { contentBlockStart: { contentBlockIndex: 0 } }
          yield { contentBlockDelta: { delta: { text: 'Test' }, contentBlockIndex: 0 } }
          yield { contentBlockStop: { contentBlockIndex: 0 } }
          yield { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } }
          yield { messageStop: { stopReason: 'end_turn' } }
        })

        const provider = new BedrockModel()
        const messages: Message[] = [{ type: 'message', role: 'user', content: [{ type: 'textBlock', text: 'Hi' }] }]

        const { result } = await collectAggregated(provider.streamAggregated(messages))

        expect(result.usage).toEqual({
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        })
      })
    })
  })
})
