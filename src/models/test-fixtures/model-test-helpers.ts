/**
 * Test fixtures and helpers for Model testing.
 * This module provides utilities for testing Model implementations without
 * requiring actual API clients.
 */

import { Model } from '../model'
import type { Message, ContentBlock } from '../../types/messages'
import type { ModelStreamEvent } from '../streaming'
import type { BaseModelConfig, StreamOptions } from '../model'

/**
 * Test model provider that returns a predefined stream of events.
 * Useful for testing Model.streamAggregated() and other Model functionality
 * without requiring actual API calls.
 *
 * @example
 * ```typescript
 * const provider = new TestModelProvider(async function* () {
 *   yield { type: 'modelMessageStartEvent', role: 'assistant' }
 *   yield { type: 'modelContentBlockStartEvent', contentBlockIndex: 0 }
 *   yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Hello' }, contentBlockIndex: 0 }
 *   yield { type: 'modelContentBlockStopEvent', contentBlockIndex: 0 }
 *   yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
 * })
 *
 * const message = await collectAggregated(provider.streamAggregated(messages))
 * ```
 */
export class TestModelProvider extends Model<BaseModelConfig> {
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
 * Helper function to collect events and message from an async generator.
 * Properly handles AsyncGenerator where the final value is returned
 * rather than yielded.
 *
 * @param generator - An async generator that yields items and returns a final result
 * @returns Object with items array (yielded values) and result (return value)
 *
 * @example
 * ```typescript
 * const { items, result } = await collectAggregated(provider.streamAggregated(messages))
 * // items: Array of ModelStreamEvent | ContentBlock
 * // result: Final Message
 * ```
 */
export async function collectAggregated(
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
