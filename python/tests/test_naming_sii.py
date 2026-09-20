import pytest

from eurocreator.naming import is_unit_name, to_asset_name, to_unit_name
from eurocreator.sii import SiiFile, SiiUnit


@pytest.mark.parametrize(
    "text,expected",
    [
        ("Nordic", "nordic"),
        ("Olzzon's Nordic Livery", "olzzon_s_nordic_livery"),
        ("Blå Himmel", "blaa_himmel"),
        ("Grün & Weiß", "gruen_weiss"),
        ("  spaced  out  ", "spaced_out"),
        ("142", "_142"),
    ],
)
def test_unit_names_are_always_legal(text, expected):
    assert to_unit_name(text) == expected
    assert is_unit_name(to_unit_name(text))


def test_asset_names_keep_spaces_but_drop_path_breakers():
    assert to_asset_name("Cabin A (High Roof)") == "Cabin A (High Roof)"
    assert to_asset_name('bad/name:here?') == "bad_name_here_"


def test_sii_renders_arrays_and_includes():
    unit = SiiUnit("accessory_paint_job_data", "nordic.truck.paint_job")
    unit.include("nordic_settings.sui")
    unit.extend("suitable_for", ["a.truck.cabin", "b.truck.cabin"])
    unit.set("price", 9500).set("airbrush", True).set("base_color", (0.02, 0.5, 1.0))
    text = SiiFile(unit).render()
    assert text.startswith("SiiNunit\n{\n")
    assert text.rstrip().endswith("}")
    # @include must sit at column zero or the parser treats it as an attribute.
    assert '\n@include "nordic_settings.sui"' in text
    assert 'suitable_for[]: "a.truck.cabin"' in text
    assert "airbrush: true" in text
    assert "base_color: (0.02, 0.5, 1)" in text


def test_quotes_in_a_value_are_refused_rather_than_silently_truncating():
    with pytest.raises(ValueError):
        SiiUnit("x", "y").set("name", 'He said "hi"')
