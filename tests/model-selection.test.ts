import { describe, expect, it } from 'vitest'
import { selectResponseModel, shouldDisableResponseStore } from '../src/agent/model-selection.js'
import { DEFAULT_CHATGPT_CODEX_BASE_URL, DEFAULT_CHATGPT_CODEX_MODEL } from '../src/constants.js'

describe('selectResponseModel', () => {
  it('keeps the requested model for API-key auth', () => {
    expect(selectResponseModel({}, undefined, 'gpt-5')).toEqual({ model: 'gpt-5' })
  })

  it('remaps retired default models for ChatGPT backend auth', () => {
    expect(
      selectResponseModel(
        { baseUrl: DEFAULT_CHATGPT_CODEX_BASE_URL },
        undefined,
        'gpt-5'
      )
    ).toEqual({
      model: DEFAULT_CHATGPT_CODEX_MODEL,
      remappedFrom: 'gpt-5'
    })
  })

  it('keeps supported explicit Codex models for ChatGPT backend auth', () => {
    expect(
      selectResponseModel(
        { baseUrl: DEFAULT_CHATGPT_CODEX_BASE_URL },
        'gpt-5.3-codex-spark',
        'gpt-5'
      )
    ).toEqual({ model: 'gpt-5.3-codex-spark' })
  })

  it('disables response storage for ChatGPT backend auth', () => {
    expect(shouldDisableResponseStore({ baseUrl: DEFAULT_CHATGPT_CODEX_BASE_URL })).toBe(true)
    expect(shouldDisableResponseStore({})).toBe(false)
  })
})
