import { describe, it, expect } from 'vitest'
import { Model } from '../model'
import type { Message, ContentBlock } from '../../types/messages'
import type { ModelStreamEvent } from '../streaming'
import type { BaseModelConfig, StreamOptions } from '../model'

/**
 * Test model provider that returns a predefined stream of events.
 */
class TestModelProvider extends Model<BaseModelConfig> {
  private eventGenerator: (() => AsyncGenerator<ModelStreamEvent>) | undefined
  private config: BaseModelConfig = { modelId: 'test-model' }

  constructor(eventGenerator?: () => AsyncGenerator<ModelStreamEvent>) {
    super()
    this.eventGenerator = eventGenerator
  }

  setEventGenerator(eventGenerator: () => AsyncGenerator<ModelStreamEvent>): void {
    this.eventGenerator = eventGenerator
  }

  updateConfig(modelConfig: BaseModelConfig): void {
    this.config = { ...this.config, ...modelConfig }
  }

  getConfig(): BaseModelConfig {
    return this.config
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async *stream(_messages: Message[], _options?: StreamOptions): AsyncGenerator<ModelStreamEvent> {
    if (!this.eventGenerator) {
      throw new Error('Event generator not set')
    }
    yield* this.eventGenerator()
  }
}

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

describe('Model', () => {
  describe('streamAggregated', () => {
    describe('when streaming a simple text message', () => {
      it('yields original events plus aggregated content block and returns final message', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent', contentBlockIndex: 0 }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'Hello' },
            contentBlockIndex: 0,
          }
          yield { type: 'modelContentBlockStopEvent', contentBlockIndex: 0 }
          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }
        })

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
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent', contentBlockIndex: 0 }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'First' },
            contentBlockIndex: 0,
          }
          yield { type: 'modelContentBlockStopEvent', contentBlockIndex: 0 }
          yield { type: 'modelContentBlockStartEvent', contentBlockIndex: 1 }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'Second' },
            contentBlockIndex: 1,
          }
          yield { type: 'modelContentBlockStopEvent', contentBlockIndex: 1 }
          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          }
        })

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
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield {
            type: 'modelContentBlockStartEvent',
            contentBlockIndex: 0,
            start: { type: 'toolUseStart', toolUseId: 'tool1', name: 'get_weather' },
          }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'toolUseInputDelta', input: '{"location"' },
            contentBlockIndex: 0,
          }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'toolUseInputDelta', input: ': "Paris"}' },
            contentBlockIndex: 0,
          }
          yield { type: 'modelContentBlockStopEvent', contentBlockIndex: 0 }
          yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
          }
        })

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
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent', contentBlockIndex: 0 }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'reasoningContentDelta', text: 'Thinking about', signature: 'sig1' },
            contentBlockIndex: 0,
          }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'reasoningContentDelta', text: ' the problem' },
            contentBlockIndex: 0,
          }
          yield { type: 'modelContentBlockStopEvent', contentBlockIndex: 0 }
          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          }
        })

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
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent', contentBlockIndex: 0 }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'reasoningContentDelta', text: 'Thinking' },
            contentBlockIndex: 0,
          }
          yield { type: 'modelContentBlockStopEvent', contentBlockIndex: 0 }
          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }
        })

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
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent', contentBlockIndex: 0 }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'Hello' },
            contentBlockIndex: 0,
          }
          yield { type: 'modelContentBlockStopEvent', contentBlockIndex: 0 }
          yield {
            type: 'modelContentBlockStartEvent',
            contentBlockIndex: 1,
            start: { type: 'toolUseStart', toolUseId: 'tool1', name: 'get_weather' },
          }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'toolUseInputDelta', input: '{"city": "Paris"}' },
            contentBlockIndex: 1,
          }
          yield { type: 'modelContentBlockStopEvent', contentBlockIndex: 1 }
          yield { type: 'modelContentBlockStartEvent', contentBlockIndex: 2 }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'reasoningContentDelta', text: 'Reasoning', signature: 'sig1' },
            contentBlockIndex: 2,
          }
          yield { type: 'modelContentBlockStopEvent', contentBlockIndex: 2 }
          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
          }
        })

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
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent', contentBlockIndex: 0 }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'Test' },
            contentBlockIndex: 0,
          }
          yield { type: 'modelContentBlockStopEvent', contentBlockIndex: 0 }
          yield { type: 'modelMessageStopEvent', stopReason: 'maxTokens' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }
        })

        const messages: Message[] = [{ type: 'message', role: 'user', content: [{ type: 'textBlock', text: 'Hi' }] }]

        const { result } = await collectAggregated(provider.streamAggregated(messages))

        expect(result.stopReason).toBe('maxTokens')
      })

      it('includes usage metadata in returned message', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent', contentBlockIndex: 0 }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'Test' },
            contentBlockIndex: 0,
          }
          yield { type: 'modelContentBlockStopEvent', contentBlockIndex: 0 }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }
          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
        })

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
