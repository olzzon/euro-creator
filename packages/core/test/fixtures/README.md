# Golden fixtures

Frozen bytes the encoders are tested against. They are a contract, not output:
if a change makes a test here fail, the change is wrong unless you can say
exactly why the old bytes were.

**Do not regenerate these from the current implementation.** That would turn a
regression test into a tautology.

## Provenance

These were produced by a Python implementation of the same pipeline, written
and verified before the TypeScript port and removed once the port was passing.
It is preserved in git at commit **`513ee77`** under `python/`, and can be
recovered with:

```bash
git show 513ee77:python/src/eurocreator/dds.py
git checkout 513ee77 -- python/        # to restore the whole tree
```

| File | What it is |
| --- | --- |
| `icon.tobj` | `buildTobj("/material/ui/accessory/Nordic Icon.dds", { clamp: true })` |
| `mask.tobj` | `buildTobj("/vehicle/truck/upgrade/paintjob/Nordic/Scania S/Cabin.dds")` |
| `gradient.raw` | The source image: 64×64 RGBA, a two-channel ramp with a hard-edged red block and a graded alpha channel. Reproduced by `gradient()` in `golden.test.ts`. |
| `gradient.dxt5.dds` | `gradient.raw` encoded as BC3 with a full mip chain |
| `gradient.dxt1.dds` | the same as BC1 |
| `gradient.raw.dds` | the same uncompressed, as A8R8G8B8 |
| `manifest.sii`, `paintjob.sii` | rendered SII units, including `@include` placement and float formatting |
| `sample.uvdump` | Written with Python's `struct` using the same packing as `packages/server/src/blender/extract.py`. This is the cross-language contract with the Blender helper, which is still Python and always will be. |
| `index.json` | SHA-256 of every file above, as generated |

## How they are used

The TOBJ and SII fixtures are compared byte for byte — those formats are
exactly reproducible, and the TOBJ header is *also* asserted against the
literal hex pattern shipped by SCS' own textures, so its correctness does not
depend on this directory at all.

The DDS fixtures are compared two ways. Headers and uncompressed output must
match byte for byte. Block-compressed output is compared by *decoding* both and
measuring the difference: the reference used float32 throughout, this port uses
float64, and that shifts a handful of endpoint fits. Bit-equality is the wrong
bar; visual equivalence is the right one, and the test asserts a mean
difference under 0.5 of 255.
