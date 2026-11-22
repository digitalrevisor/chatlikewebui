// An error answer with its HTTP status; everything else becomes 500.
export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
