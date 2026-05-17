export type StateCommandDisplayInput = {
  attemptAgentSessionId?: string
  attemptCommand?: string
  sessionAgent?: string
  stateConfigAgent?: string
  stateConfigCommand?: string
}

export function stateCommandForDisplay(input: StateCommandDisplayInput): string | undefined {
  if (input.stateConfigAgent) return undefined
  if (input.stateConfigCommand !== undefined) {
    return input.attemptCommand !== undefined ? input.attemptCommand : input.stateConfigCommand
  }
  if (input.sessionAgent && input.sessionAgent !== "custom") return undefined
  if (input.attemptAgentSessionId && input.sessionAgent === undefined) return undefined
  return input.attemptCommand
}

export function responseTextForDisplay(responseContent: string | undefined): string | undefined {
  if (responseContent === undefined) return undefined
  return responseContent.trim() ? responseContent : "(empty response)"
}
