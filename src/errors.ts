export class NekodexError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NekodexError'
  }
}

export class AuthError extends NekodexError {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

export class ToolExecutionError extends NekodexError {
  constructor(message: string) {
    super(message)
    this.name = 'ToolExecutionError'
  }
}
