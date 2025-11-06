import { describe, it, expect } from 'vitest'
import { TextBlock, Message } from '../../types/messages.js'
import { TestModelProvider, collectGenerator } from '../../__fixtures__/model-test-helpers.js'

describe('Model', () => {
  describe('streamAggregated', () => {
    describe('when streaming a simple text message', () => {
      it('yields original events plus aggregated content block and returns final message', async () => {
        const provider = new TestModelProvider(async function* () {
          yield {
            modelMessageStartEvent: { role: 'assistant' },
          }
          yield {
            modelContentBlockStartEvent: {},
          }
          yield {
            modelContentBlockDeltaEvent: {
              delta: { type: 'textDelta', text: 'Hello' },
            },
          }
          yield {
            modelContentBlockStopEvent: {},
          }
          yield {
            modelMessageStopEvent: { stopReason: 'endTurn' },
          }
          yield {
            modelMetadataEvent: {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            },
          }
        })

        const messages: Message[] = [new Message({ role: 'user', content: [new TextBlock({ text: 'Hi' })] })]

        const { items, result } = await collectGenerator(provider.streamAggregated(messages))

        // Verify all yielded items (events + aggregated content block)
        expect(items).toEqual([
          expect.objectContaining({ type: 'modelMessageStartEvent', role: 'assistant' }),
          expect.objectContaining({
            type: 'modelContentBlockStartEvent',
          }),
          expect.objectContaining({
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'Hello' },
          }),
          expect.objectContaining({
            type: 'modelContentBlockStopEvent',
          }),
          expect.objectContaining({ type: 'textBlock', text: 'Hello' }),
          expect.objectContaining({ type: 'modelMessageStopEvent', stopReason: 'endTurn' }),
        ])

        // Verify the returned result
        expect(result).toEqual({
          message: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'textBlock', text: 'Hello' }],
          },
          stopReason: 'endTurn',
        })
      })
    })

    describe('when streaming multiple text blocks', () => {
      it('yields all blocks in order', async () => {
        const provider = new TestModelProvider(async function* () {
          yield {
            modelMessageStartEvent: { role: 'assistant' },
          }
          yield {
            modelContentBlockStartEvent: {},
          }
          yield {
            modelContentBlockDeltaEvent: {
              delta: { type: 'textDelta', text: 'First' },
            },
          }
          yield {
            modelContentBlockStopEvent: {},
          }
          yield {
            modelContentBlockStartEvent: {},
          }
          yield {
            modelContentBlockDeltaEvent: {
              delta: { type: 'textDelta', text: 'Second' },
            },
          }
          yield {
            modelContentBlockStopEvent: {},
          }
          yield {
            modelMessageStopEvent: { stopReason: 'endTurn' },
          }
          yield {
            modelMetadataEvent: {
              usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            },
          }
        })

        const messages: Message[] = [new Message({ role: 'user', content: [new TextBlock({ text: 'Hi' })] })]

        const { items, result } = await collectGenerator(provider.streamAggregated(messages))

        expect(items).toContainEqual(expect.objectContaining({ type: 'textBlock', text: 'First' }))
        expect(items).toContainEqual(expect.objectContaining({ type: 'textBlock', text: 'Second' }))

        expect(result).toEqual({
          message: {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'textBlock', text: 'First' },
              { type: 'textBlock', text: 'Second' },
            ],
          },
          stopReason: 'endTurn',
        })
      })
    })

    describe('when streaming tool use', () => {
      it('yields complete tool use block', async () => {
        const provider = new TestModelProvider(async function* () {
          yield {
            modelMessageStartEvent: { role: 'assistant' },
          }
          yield {
            modelContentBlockStartEvent: {
              start: { type: 'toolUseStart', toolUseId: 'tool1', name: 'get_weather' },
            },
          }
          yield {
            modelContentBlockDeltaEvent: {
              delta: { type: 'toolUseInputDelta', input: '{"location"' },
            },
          }
          yield {
            modelContentBlockDeltaEvent: {
              delta: { type: 'toolUseInputDelta', input: ': "Paris"}' },
            },
          }
          yield {
            modelContentBlockStopEvent: {},
          }
          yield {
            modelMessageStopEvent: { stopReason: 'toolUse' },
          }
          yield {
            modelMetadataEvent: {
              usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
            },
          }
        })

        const messages: Message[] = [new Message({ role: 'user', content: [new TextBlock({ text: 'Hi' })] })]

        const { items, result } = await collectGenerator(provider.streamAggregated(messages))

        expect(items).toContainEqual(
          expect.objectContaining({
            type: 'toolUseBlock',
            toolUseId: 'tool1',
            name: 'get_weather',
            input: { location: 'Paris' },
          })
        )

        expect(result).toEqual({
          message: {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'toolUseBlock',
                toolUseId: 'tool1',
                name: 'get_weather',
                input: { location: 'Paris' },
              },
            ],
          },
          stopReason: 'toolUse',
        })
      })
    })

    describe('when streaming reasoning content', () => {
      it('yields complete reasoning block', async () => {
        const provider = new TestModelProvider(async function* () {
          yield {
            modelMessageStartEvent: { role: 'assistant' },
          }
          yield {
            modelContentBlockStartEvent: {},
          }
          yield {
            modelContentBlockDeltaEvent: {
              delta: { type: 'reasoningContentDelta', text: 'Thinking about', signature: 'sig1' },
            },
          }
          yield {
            modelContentBlockDeltaEvent: {
              delta: { type: 'reasoningContentDelta', text: ' the problem' },
            },
          }
          yield {
            modelContentBlockStopEvent: {},
          }
          yield {
            modelMessageStopEvent: { stopReason: 'endTurn' },
          }
          yield {
            modelMetadataEvent: {
              usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            },
          }
        })

        const messages: Message[] = [new Message({ role: 'user', content: [new TextBlock({ text: 'Hi' })] })]

        const { items, result } = await collectGenerator(provider.streamAggregated(messages))

        expect(items).toContainEqual(
          expect.objectContaining({
            type: 'reasoningBlock',
            text: 'Thinking about the problem',
            signature: 'sig1',
          })
        )

        expect(result).toEqual({
          message: {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'reasoningBlock',
                text: 'Thinking about the problem',
                signature: 'sig1',
              },
            ],
          },
          stopReason: 'endTurn',
        })
      })

      it('yields redacted content reasoning block', async () => {
        const provider = new TestModelProvider(async function* () {
          yield {
            modelMessageStartEvent: { role: 'assistant' },
          }
          yield {
            modelContentBlockStartEvent: {},
          }
          yield {
            modelContentBlockDeltaEvent: {
              delta: { type: 'reasoningContentDelta', redactedContent: new Uint8Array(0) },
            },
          }
          yield {
            modelContentBlockStopEvent: {},
          }
          yield {
            modelMessageStopEvent: { stopReason: 'endTurn' },
          }
          yield {
            modelMetadataEvent: {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            },
          }
        })

        const messages: Message[] = [new Message({ role: 'user', content: [new TextBlock({ text: 'Hi' })] })]

        const { items, result } = await collectGenerator(provider.streamAggregated(messages))

        expect(items).toContainEqual(
          expect.objectContaining({
            type: 'reasoningBlock',
            redactedContent: new Uint8Array(0),
          })
        )

        expect(result).toEqual({
          message: {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'reasoningBlock',
                redactedContent: new Uint8Array(0),
              },
            ],
          },
          stopReason: 'endTurn',
        })
      })

      it('omits signature if not present', async () => {
        const provider = new TestModelProvider(async function* () {
          yield {
            modelMessageStartEvent: { role: 'assistant' },
          }
          yield {
            modelContentBlockStartEvent: {},
          }
          yield {
            modelContentBlockDeltaEvent: {
              delta: { type: 'reasoningContentDelta', text: 'Thinking' },
            },
          }
          yield {
            modelContentBlockStopEvent: {},
          }
          yield {
            modelMessageStopEvent: { stopReason: 'endTurn' },
          }
          yield {
            modelMetadataEvent: {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            },
          }
        })

        const messages: Message[] = [new Message({ role: 'user', content: [new TextBlock({ text: 'Hi' })] })]

        const { items, result } = await collectGenerator(provider.streamAggregated(messages))

        expect(items).toContainEqual(
          expect.objectContaining({
            type: 'reasoningBlock',
            text: 'Thinking',
          })
        )

        expect(result).toEqual({
          message: {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'reasoningBlock',
                text: 'Thinking',
              },
            ],
          },
          stopReason: 'endTurn',
        })
      })
    })

    describe('when streaming mixed content blocks', () => {
      it('yields all blocks in correct order', async () => {
        const provider = new TestModelProvider(async function* () {
          yield {
            modelMessageStartEvent: { role: 'assistant' },
          }
          yield {
            modelContentBlockStartEvent: {},
          }
          yield {
            modelContentBlockDeltaEvent: {
              delta: { type: 'textDelta', text: 'Hello' },
            },
          }
          yield {
            modelContentBlockStopEvent: {},
          }
          yield {
            modelContentBlockStartEvent: {
              start: { type: 'toolUseStart', toolUseId: 'tool1', name: 'get_weather' },
            },
          }
          yield {
            modelContentBlockDeltaEvent: {
              delta: { type: 'toolUseInputDelta', input: '{"city": "Paris"}' },
            },
          }
          yield {
            modelContentBlockStopEvent: {},
          }
          yield {
            modelContentBlockStartEvent: {},
          }
          yield {
            modelContentBlockDeltaEvent: {
              delta: { type: 'reasoningContentDelta', text: 'Reasoning', signature: 'sig1' },
            },
          }
          yield {
            modelContentBlockStopEvent: {},
          }
          yield {
            modelMessageStopEvent: { stopReason: 'endTurn' },
          }
          yield {
            modelMetadataEvent: {
              usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
            },
          }
        })

        const messages: Message[] = [new Message({ role: 'user', content: [new TextBlock({ text: 'Hi' })] })]

        const { items, result } = await collectGenerator(provider.streamAggregated(messages))

        expect(items).toContainEqual(expect.objectContaining({ type: 'textBlock', text: 'Hello' }))
        expect(items).toContainEqual(
          expect.objectContaining({
            type: 'toolUseBlock',
            toolUseId: 'tool1',
            name: 'get_weather',
            input: { city: 'Paris' },
          })
        )
        expect(items).toContainEqual(
          expect.objectContaining({ type: 'reasoningBlock', text: 'Reasoning', signature: 'sig1' })
        )

        expect(result).toEqual({
          message: {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'textBlock', text: 'Hello' },
              { type: 'toolUseBlock', toolUseId: 'tool1', name: 'get_weather', input: { city: 'Paris' } },
              { type: 'reasoningBlock', text: 'Reasoning', signature: 'sig1' },
            ],
          },
          stopReason: 'endTurn',
        })
      })
    })
  })
})
