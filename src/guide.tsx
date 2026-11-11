import { useState } from 'react';
import { Modal } from './dialogs';
import { SHORTCUTS } from './extras';

/** The in-app guide. Each section is a list of [heading, explanation] pairs. */
const SECTIONS: { title: string; intro?: string; items: [string, string][] }[] = [
  {
    title: 'Getting started',
    intro: 'CrossPattern is a cross stitch pattern editor that runs entirely in your browser. There is nothing to install and no account; your work stays on your own computer.',
    items: [
      ['Draw from scratch', 'Pick a color on the right, pick a tool on the left, and click or drag on the grid. Every square is one stitch. The bold lines mark every tenth stitch.'],
      ['Start from a picture', 'Press Convert picture, choose a photo, crop it to the size you want to stitch, then mark what to keep, flatten or remove. See "Converting a picture".'],
      ['Moving around', 'Scroll to move, pinch or hold ⌘/Ctrl while scrolling to zoom, and press 0 to fit the pattern to the window. Hold Space and drag to move with any tool.'],
      ['Nothing is lost', 'Every change is saved automatically, and Undo (⌘/Ctrl Z) goes back up to 100 steps.'],
    ],
  },
  {
    title: 'Drawing tools',
    items: [
      ['Pencil and Eraser', 'Add or remove stitches. Change the brush size with the Size menu or the [ and ] keys.'],
      ['Recolor brush', 'Replaces only the color you start the stroke on with the current color. Everything else under the brush is left alone, so you can fix one color without going outside the lines.'],
      ['Tidy brush', 'Brush over a noisy patch and stray stitches are absorbed into the colors around them. It only affects where you brush.'],
      ['Restore brush', 'Paints back the stitches from the first conversion of a picture, for when you have simplified too far.'],
      ['Fill', 'Fills a connected area with the current color. Shift-click replaces that color everywhere in the pattern.'],
      ['Pick color', 'Click a stitch to use its color. Shift-click takes the exact shade from the guide photo and adds it to the palette. Holding Alt with most tools picks a color without switching tools.'],
      ['Line, Rectangle, Ellipse', 'Drag to draw the shape. Hold Shift for a filled rectangle or ellipse.'],
      ['Backstitch', 'Drag between grid corners to add an outline line on top of the stitches. Alt-click a line to remove it.'],
      ['Mirror', 'With Mirror on, everything you paint is repeated on the other side of the centre line. Useful for faces and symmetric motifs.'],
    ],
  },
  {
    title: 'Colors',
    items: [
      ['The palette', 'The list on the right shows every color with its chart symbol and how many stitches use it. Click one to paint with it. Sort puts the most-used colors first.'],
      ['Editing a color', 'With a color selected you can change its shade, type a hex code, or choose a different symbol.'],
      ['Highlight', 'Fades every other color so you can see exactly where one color is used.'],
      ['Lock', 'A locked color cannot be painted over by any tool. Lock the parts you are happy with before cleaning up around them.'],
      ['Merge into', 'Replaces the selected color everywhere with another color and removes it from the palette.'],
      ['Simplify', 'Reduce to N colors merges the least-used colors into their nearest neighbours. Remove stray stitches clears isolated stitches across the whole pattern. Outline adds a border around the design, as backstitch or as stitches.'],
      ['Fabric color', 'Set the fabric color at the bottom of the panel to preview the design on dark or colored cloth. Empty squares show the fabric.'],
    ],
  },
  {
    title: 'Converting a picture',
    intro: 'Conversion has two steps. The aim is a pattern you can actually stitch: few colors, clean shapes, no speckle.',
    items: [
      ['1. Crop and size', 'Type the width and height in stitches. The crop box takes that shape; drag it, or a corner, to choose what goes in. The total stitch count and finished size on your fabric are shown as you go.'],
      ['2. Mark areas', 'Paint on the photo to tell the converter what matters. Remove leaves an area as empty fabric. One color turns each marked area into a single solid color. Keep detail protects an area from simplifying and gives it priority when colors are chosen.'],
      ['Brush, Lasso, Magic wand', 'Brush paints a mark, Lasso marks everything inside a shape you draw, and Magic wand marks the connected area of similar color around where you click.'],
      ['Removing a background', 'Mark the subject (roughly is fine), switch to Remove, and press "Remove everything unmarked". The subject gets a crisp outline and all the colors go to it instead of the background.'],
      ['Colors and simplifying', 'Colors sets how many thread colors to use. Flatten smooths shading in unmarked areas. Remove stray stitches clears single stitches. Adjust the photo changes brightness, contrast and color strength first.'],
      ['A good order for a portrait', 'Remove the background, keep detail on eyes, nose and edges, leave fur or skin unmarked so it flattens, then lower the color count until it looks right.'],
    ],
  },
  {
    title: 'Fine-tuning',
    items: [
      ['Guide picture', 'After converting, the photo and the first conversion are kept. Show either one over your pattern from the top of the right panel, and use the slider to fade between it and your stitches. Hold P to see the guide in full.'],
      ['Tracing', 'On any pattern you can add a photo to trace over with "Add a photo to trace".'],
      ['Re-convert a selection', 'Select an area, press Re-convert in the selection bar, and convert just that part of the photo again with its own color count. Empty squares stay empty unless you say otherwise.'],
      ['Selections', 'Drag with the Select tool, then drag inside to move. The bar above the canvas can flip, rotate, copy, cut, delete, or crop the canvas to the selection. Arrow keys nudge by one square.'],
      ['Canvas size', 'Click the size in the top bar to resize the canvas or trim empty edges.'],
    ],
  },
  {
    title: 'Stitching',
    items: [
      ['Stitch mode', 'Turn on Stitch mode to track real-life progress. Click or drag over squares to tick them off as stitched; they fade so what is left stands out. Click again to untick.'],
      ['Whole patches', 'Shift-click ticks off the whole connected patch of one color.'],
      ['Progress', 'The palette shows stitched and total counts per color, and the bottom of the panel shows overall progress. Progress is saved with the project.'],
      ['Symbols', 'Turn on Symbols to see each color\'s chart symbol in its squares, which helps tell similar shades apart.'],
    ],
  },
  {
    title: 'Projects, saving and printing',
    items: [
      ['Projects', 'Every pattern is a project in the library. Open Projects to switch, duplicate or delete. New, Open and Convert picture each start a new project.'],
      ['Where your work lives', 'Projects are stored in this browser on this computer. They are not uploaded anywhere, and they will not appear on another device or browser.'],
      ['Backing up and moving', 'Save downloads a project file. Open it (or drop it on the window) on any computer to carry on. Clearing your browser data deletes the library, so keep files of anything important.'],
      ['Export an image', 'Export makes a PNG of the chart, with optional symbols, grid numbers and a color key.'],
      ['Print or save as PDF', 'In Export, "Print or save as PDF" lays the chart out across pages with symbols and row and column numbers, plus a cover page with the color key and finished sizes. Choose "Save as PDF" in the print dialog to keep a file.'],
    ],
  },
];

export function GuideDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState(0);
  const titles = [...SECTIONS.map((s) => s.title), 'Keyboard shortcuts'];
  const section = SECTIONS[tab];

  return (
    <Modal title="Guide" onClose={onClose} size="xl">
      <div className="guide">
        <nav>
          {titles.map((t, i) => (
            <button key={t} className={i === tab ? 'on' : ''} onClick={() => setTab(i)}>{t}</button>
          ))}
        </nav>
        <article>
          <h3>{titles[tab]}</h3>
          {section ? (
            <>
              {section.intro && <p className="lead">{section.intro}</p>}
              <dl>
                {section.items.map(([head, text]) => (
                  <div key={head}><dt>{head}</dt><dd>{text}</dd></div>
                ))}
              </dl>
            </>
          ) : (
            <div className="shortcuts">
              {SHORTCUTS.map(([title, rows]) => (
                <section key={title}>
                  <h4>{title}</h4>
                  <dl>
                    {rows.map(([key, what]) => (
                      <div key={key}><dt>{key}</dt><dd>{what}</dd></div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          )}
        </article>
      </div>
      <footer>
        <button className="btn primary" onClick={onClose}>Close</button>
      </footer>
    </Modal>
  );
}
