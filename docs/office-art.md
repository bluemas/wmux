# Office pixel art

The Office page's room and characters (`src/renderer/assets/office/`) are
**original art made for this repo**. No third-party image is used, so there is
no entry for them in `THIRD_PARTY_NOTICES.md`. Nookrew's office screenshot was
only a quality reference; none of its art was copied or traced.

## How it is made

The art is drawn by code, pixel by pixel, in `scripts/office-art/`:

| File | Role |
| --- | --- |
| `build-office-art.mjs` | Entry point. Writes `furniture.png`, `characters.png` and `layout.generated.ts`. |
| `palette.mjs` | The one palette: every material is a 5-step ramp. |
| `furniture.mjs` | Room pieces and furniture as isometric boxes and planes. |
| `characters.mjs` | Hand-drawn letter templates for heads, hair styles and body poses, and the looks. |
| `raster.mjs` | Layers, polygon fill, selective outline, and a dependency-free PNG encoder. |
| `preview-office-art.mjs` | Review contact sheet (HTML) and a sample room PNG. |

```sh
node scripts/office-art/build-office-art.mjs                 # rebuild the sheets
node scripts/office-art/preview-office-art.mjs <out-dir>     # contact sheet + sample room
```

The build is deterministic: rerunning it with unchanged sources writes
byte-identical PNGs (PNG encoding uses `node:zlib` only). Never edit the PNGs
or `layout.generated.ts` by hand; change the generator and rerun it.

## Grid and style

- Isometric 2:1. A floor tile is 32x16 px. World units: one tile is 16x16
  units; a point (a, b, z) lands at screen (a - b, (a + b) / 2 - z). `a` runs
  down-right along the right wall, `b` down-left along the left wall.
- Light comes from the top-left: top faces take the ramp's `light` tone,
  south-west faces `base`, south-east faces `shade`, the top's front rim the
  `highlight`.
- Outlines are selective: one pixel in the darkest tone of the material they
  touch, never pure black. Floors and walls have no outline so they tile.
- Characters are chibi, about 2 heads tall (a 16 px face plus hair on a
  ~17 px body), drawn at 1x. Seated poses face the desk (north-east, back and
  right cheek visible); rest and walk poses face the viewer (south-west).

## Palette

Ramps are `[highlight, light, base, shade, dark]`, all in `palette.mjs`:
room (`floor`, `carpet`, `rug`, `wall`, `wallSide`, `baseboard`, `glass`,
`frame`), furniture (`wood`, `woodDark`, `plastic`, `metal`, `bezel`,
`screenOff`, `screenOn`, `chair`, `sofa`, `cushion`, `leaf`, `leafDeep`,
`pot`, `soil`, `paper`), accents and clothes (`coral`, `navy`, `mustard`,
`sage`, `teal`, `purple`, `olive`, `hoodie`, `shirt`, `red`, `denim`,
`charcoal`, `khaki`, `black`, `shoe`, `sneaker`), four skin ramps
(`skin1`..`skin4`) and seven hair ramps. Add a colour as a new ramp here
rather than as a one-off hex value elsewhere.

## Sheets and frame layout

`furniture.png` (262x178) packs every room piece; rectangles and anchors are
in `layout.generated.ts` and exported from `index.ts`:

- `FURNITURE`: `floor`, `wall`, `window`, `desk`, `monitorOff`, `monitorOn`,
  `chair`, `plant`, `sofa`, `shelf`.
- `OFFICE_EXTRAS`: `wallLeft`, `windowLeft` (the left wall, mirrored and
  shaded darker), `carpet` (a floor tile for the work area), `rug`,
  `coffeeTable`.
- `FURNITURE_ANCHORS`: per sprite, the pixel that sits on its floor reference
  point (tile top corner for floors; the segment's north corner on the floor
  for walls; the north corner of the footprint for furniture).

`characters.png` (512x504) holds one row per look and one column per pose,
each frame 64x56: `sit`, `type1`, `type2`, `raiseHand`, `rest1`, `rest2`,
`walk1`, `walk2`. The rows are the eight `CHARACTERS` (`spiky`, `bob`,
`curly`, `long`, `bun`, `ponytail`, `beanie`, `sidepart`) and then
`GENERIC_CHARACTER` (`hood`) for agents that are neither Claude Code nor Codex.

### The station frame

The desk, both monitors, the chair and every character frame share one 64x56
frame (`STATION`). Draw desk, then a monitor, then the character at the same
top-left and they line up. The seated frames already include the chair (drawn
over the character's back, as seen from behind), so draw `chair` only at an
empty desk. In the frame, `deskX/deskY` is the north corner of the desk's
footprint (2 tiles along `a`, 1 along `b`; the chair takes the tile in front)
and `seatX/seatY` is the chair's centre on the floor, which is also the anchor
of every character pose. A resting character's anchor goes on a sofa seat
(`SOFA_SEATS`, in sofa-sprite pixels); a walking one stands with its anchor on
the floor point it occupies.

## Adding a look

1. In `characters.mjs`, add an entry to `LOOKS` with an `id`, a hair style
   from `HAIR` and the ramps for `hair`, `skin`, `top`, `top2` (collar),
   `pants`, `shoes` and `acc` (hats, hair ties). `glasses: true` adds glasses.
2. For a new hair style, add `front` and `back` overlays to `HAIR` (20 columns,
   rows over the 20x19 head grid; `.` keeps the face below) and, for hair that
   hangs behind the shoulders in front views, `frontBehind`.
3. Run the build, then the preview, and check every pose at 2x and 3x.

Template letters: capitals are shaded automatically (`H` hair, `K` skin, `T`
top, `U` collar, `P` trousers, `Z` shoes, `R` accessory, `G` mug); lower-case
and the other letters pin a tone (`h` hair shade, `j`/`i` hair light and
highlight, `k` skin shade, `t` top shade, `E` eye, `W` eye highlight, `M`
mouth, `B` blush, `C` coffee, `F` glasses frame). The full map is `LETTERS` in
`characters.mjs`.
