"""Errors raised by euro-creator.

Everything user-facing inherits from :class:`EuroCreatorError`; the CLI prints
those as a plain message instead of a traceback.
"""


class EuroCreatorError(Exception):
    """Base class for expected, user-fixable failures."""


class ConfigError(EuroCreatorError):
    """A project or vehicle file is missing a field, or holds a bad value."""


class BlenderError(EuroCreatorError):
    """Blender could not be found, or the headless run failed."""


class TextureError(EuroCreatorError):
    """A source image is missing, unreadable or the wrong shape."""
