/**
 * Errors the user can act on. The CLI prints these as a plain message and the
 * HTTP layer maps them to 4xx, rather than leaking a stack trace either way.
 */
export class EuroCreatorError extends Error {
  override readonly name: string = "EuroCreatorError";
  /** HTTP status the API should use for this class of failure. */
  readonly status: number = 400;
}

export class ConfigError extends EuroCreatorError {
  override readonly name = "ConfigError";
}

export class TextureError extends EuroCreatorError {
  override readonly name = "TextureError";
}

export class BlenderError extends EuroCreatorError {
  override readonly name = "BlenderError";
  override readonly status = 502;
}

export class NotFoundError extends EuroCreatorError {
  override readonly name = "NotFoundError";
  override readonly status = 404;
}
